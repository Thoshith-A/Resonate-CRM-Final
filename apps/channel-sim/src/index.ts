import { randomUUID } from "node:crypto";
import {
  errorEnvelope,
  HealthResponseSchema,
  IDEMPOTENCY_HEADER,
  SendBatchRequestSchema,
  SendBatchResponseSchema,
  SIGNATURE_HEADER,
  type HealthResponse,
  type SendBatchResponse,
  type SendResult,
} from "@resonate/shared";
import { verifyPayload } from "@resonate/shared/crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, printConfig } from "./config";
import { funnelSummary } from "./funnels";
import { scheduleLifecycle } from "./lifecycle";
import { logger } from "./logger";
import { startReceiptFlusher } from "./receipts";
import { cacheBatch, getCachedBatch, putMessage } from "./store";

// Stash the raw request body on the request so HMAC verification signs exactly
// the bytes that arrived, before JSON parsing normalises them. Express's
// exported Request extends the global Express.Request, so augmenting that
// interface is type-safe and resolution-independent (no `any`).
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

/** Synchronous rejection reasons (~5% of accepted-eligible messages). */
const SYNC_REJECT_REASONS = ["invalid_number", "opted_out"] as const;
const SYNC_REJECT_RATE = 0.05;

const app = express();

app.use(
  express.json({
    verify: (req: Request, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info("request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  const body: HealthResponse = HealthResponseSchema.parse({
    status: "ok",
    service: "channel-sim",
    version: "0.1.0",
    time: new Date().toISOString(),
  });
  res.status(200).json(body);
});

app.post("/v1/messages", (req: Request, res: Response) => {
  // a. HMAC over the raw body.
  if (!verifyPayload(config.webhookSecret, req.rawBody ?? "", req.header(SIGNATURE_HEADER))) {
    res.status(401).json(errorEnvelope("invalid_signature", "Invalid or missing signature"));
    return;
  }

  // b. Idempotency replay — return the cached response without re-processing.
  const idempotencyKey = req.header(IDEMPOTENCY_HEADER);
  if (idempotencyKey !== undefined) {
    const cached = getCachedBatch(idempotencyKey);
    if (cached !== undefined) {
      res.status(202).json(cached);
      return;
    }
  }

  // c. Validate the batch.
  const parsed = SendBatchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json(errorEnvelope("invalid_request", parsed.error.message));
    return;
  }

  // d. Resolve each message: synchronous reject or accept + schedule lifecycle.
  const results: SendResult[] = parsed.data.messages.map((message) => {
    if (Math.random() < SYNC_REJECT_RATE) {
      const reason =
        SYNC_REJECT_REASONS[Math.floor(Math.random() * SYNC_REJECT_REASONS.length)] ??
        SYNC_REJECT_REASONS[0];
      return { clientRef: message.clientRef, vendorMessageId: null, status: "rejected", reason };
    }

    const vendorMessageId = randomUUID();
    putMessage(vendorMessageId, {
      channel: message.channel,
      clientRef: message.clientRef,
      customerId: message.customerId,
      campaignId: message.campaignId,
    });
    scheduleLifecycle(vendorMessageId, message.channel);
    return { clientRef: message.clientRef, vendorMessageId, status: "accepted" };
  });

  // e. Self-check the response against the contract, cache, and respond.
  const response: SendBatchResponse = SendBatchResponseSchema.parse({ results });
  if (idempotencyKey !== undefined) {
    cacheBatch(idempotencyKey, response);
  }
  res.status(202).json(response);
});

app.use((_req: Request, res: Response) => {
  res.status(404).json(errorEnvelope("not_found", "Resource not found"));
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("unhandled error", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json(errorEnvelope("internal_error", "Internal server error"));
});

const server = app.listen(config.port, () => {
  logger.info("channel-sim listening", { port: config.port });
  printConfig(logger);
  logger.info("funnels", { summary: funnelSummary() });
});

const flusher = startReceiptFlusher();
logger.info("receipt flusher started (every 3s)");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info("shutting down", { signal });
    clearInterval(flusher);
    server.close(() => {
      process.exit(0);
    });
  });
}
