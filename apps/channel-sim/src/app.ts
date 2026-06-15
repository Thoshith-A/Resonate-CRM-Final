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
import { config, configError } from "./config";
import { logger } from "./logger";
import { cacheBatch, getCachedBatch, putMessage, type MessageRecord } from "./store";

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

/** An accepted message handed to the lifecycle driver after the 202 response. */
export interface AcceptedMessage {
  readonly vendorMessageId: string;
  readonly record: MessageRecord;
  /** scheduledFor offset from now in ms (0 for INSTANT / already-due sends). */
  readonly startDelayMs: number;
}

/**
 * Runs the lifecycle for a just-accepted batch. The standalone server schedules
 * it on background timers; the serverless entry wraps it in `waitUntil`. Called
 * AFTER the 202 is sent, so it must never throw back into the request.
 */
export type DispatchLifecycle = (messages: AcceptedMessage[]) => void;

/** Synchronous rejection reasons (~5% of accepted-eligible messages). */
const SYNC_REJECT_REASONS = ["invalid_number", "opted_out"] as const;
const SYNC_REJECT_RATE = 0.05;

/**
 * Builds the channel-sim Express app. The `dispatch` strategy decides how the
 * accepted lifecycle plays out (background timers vs. a serverless waitUntil),
 * keeping the request/response contract — HMAC, idempotency, validation — in
 * exactly one place.
 */
export function createApp(dispatch: DispatchLifecycle): express.Express {
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

  // Root landing page. Every path is rewritten to this function (vercel.json),
  // so a human hitting the deployment URL gets a readable status page instead
  // of a 404/500. This is a backend service — the CRM UI is a separate deploy.
  app.get("/", (_req: Request, res: Response) => {
    const healthy = configError === null;
    res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Resonate channel-sim</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; background:#0b0f17; color:#e6edf3; }
  .card { max-width:34rem; padding:2rem; }
  h1 { font-size:1.1rem; margin:0 0 .75rem; }
  .dot { color:${healthy ? "#3fb950" : "#d29922"}; }
  a { color:#58a6ff; } code { background:#161b22; padding:.1rem .35rem; border-radius:4px; }
  .muted { color:#8b949e; }
</style></head>
<body><div class="card">
  <h1><span class="dot">●</span> Resonate channel-sim — ${healthy ? "running" : "running (check config)"}</h1>
  <p>Outbound message simulator for the Resonate CRM. This is a <b>backend service</b>, not the app UI:
  the CRM calls <code>POST /v1/messages</code> and the sim posts signed delivery receipts back to the CRM.</p>
  <p class="muted">Health JSON: <a href="/health">/health</a></p>
</div></body></html>`);
  });

  app.get("/health", (_req: Request, res: Response) => {
    const body: HealthResponse = HealthResponseSchema.parse({
      status: "ok",
      service: "channel-sim",
      version: "0.2.0-rootfix",
      time: new Date().toISOString(),
    });
    // Append a config diagnostic (never leaks the secret) so a misconfigured
    // deploy is visible over HTTP instead of only crashing on a real send.
    res.status(200).json({
      ...body,
      config: {
        ok: configError === null,
        webhookSecretSet: config.webhookSecret.length >= 8,
        crmUrl: config.crmUrl,
        ...(configError !== null ? { error: configError } : {}),
      },
    });
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

    // d. Resolve each message: synchronous reject, or accept + queue lifecycle.
    const accepted: AcceptedMessage[] = [];
    const results: SendResult[] = parsed.data.messages.map((message) => {
      if (Math.random() < SYNC_REJECT_RATE) {
        const reason =
          SYNC_REJECT_REASONS[Math.floor(Math.random() * SYNC_REJECT_REASONS.length)] ??
          SYNC_REJECT_REASONS[0];
        return { clientRef: message.clientRef, vendorMessageId: null, status: "rejected", reason };
      }

      const vendorMessageId = randomUUID();
      const record: MessageRecord = {
        channel: message.channel,
        clientRef: message.clientRef,
        customerId: message.customerId,
        campaignId: message.campaignId,
        peakWindow: message.peakWindow ?? false,
      };
      putMessage(vendorMessageId, record);
      // Send-Time Intelligence: honor scheduledFor by delaying the lifecycle
      // until then (already-due / INSTANT messages start immediately).
      const startDelayMs = message.scheduledFor
        ? Math.max(0, new Date(message.scheduledFor).getTime() - Date.now())
        : 0;
      accepted.push({ vendorMessageId, record, startDelayMs });
      return { clientRef: message.clientRef, vendorMessageId, status: "accepted" };
    });

    // e. Self-check the response against the contract, cache, and respond.
    const response: SendBatchResponse = SendBatchResponseSchema.parse({ results });
    if (idempotencyKey !== undefined) {
      cacheBatch(idempotencyKey, response);
    }
    res.status(202).json(response);

    // f. Drive the accepted lifecycle AFTER responding (so the CRM records the
    //    vendorMessageIds first). Strategy-injected: timers or waitUntil. The
    //    202 is already sent, so a dispatch failure must be swallowed here
    //    rather than bubble into Express's after-headers error path.
    if (accepted.length > 0) {
      try {
        dispatch(accepted);
      } catch (err) {
        logger.error("lifecycle dispatch failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
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

  return app;
}
