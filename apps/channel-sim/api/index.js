// src/serverless.ts
import { waitUntil } from "@vercel/functions";

// src/app.ts
import { randomUUID } from "node:crypto";

// ../../packages/shared/src/health.ts
import { z } from "zod";
var HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.enum(["crm", "channel-sim"]),
  version: z.string(),
  time: z.string().datetime()
});

// ../../packages/shared/src/errors.ts
import { z as z2 } from "zod";
var ErrorEnvelopeSchema = z2.object({
  error: z2.object({
    code: z2.string(),
    message: z2.string()
  })
});
function errorEnvelope(code, message) {
  return { error: { code, message } };
}

// ../../packages/shared/src/ingestion.ts
import { z as z3 } from "zod";
var OrderSourceSchema = z3.enum(["ORGANIC", "CAMPAIGN"]);
var OrderItemSchema = z3.object({
  name: z3.string().min(1),
  category: z3.string().min(1),
  qty: z3.number().int().positive(),
  /** Unit price in integer paise. */
  price: z3.number().int().nonnegative()
});
var CustomerInputSchema = z3.object({
  externalId: z3.string().min(1).optional(),
  name: z3.string().min(1),
  email: z3.string().email(),
  phone: z3.string().min(1),
  city: z3.string().min(1),
  tags: z3.array(z3.string()).default([])
});
var OrderInputSchema = z3.object({
  /** Resolve the buyer by internal id or external id — at least one. */
  customerId: z3.string().min(1).optional(),
  externalId: z3.string().min(1).optional(),
  /** Total order amount in integer paise. */
  amount: z3.number().int().positive(),
  currency: z3.string().default("INR"),
  items: z3.array(OrderItemSchema).min(1),
  /** ISO-8601 timestamp. */
  placedAt: z3.string().datetime(),
  source: OrderSourceSchema.default("ORGANIC"),
  attributedCampaignId: z3.string().min(1).optional(),
  attributedCommunicationId: z3.string().min(1).optional()
}).refine((value) => Boolean(value.customerId ?? value.externalId), {
  message: "Either customerId or externalId is required",
  path: ["customerId"]
});

// ../../packages/shared/src/channel.ts
import { z as z4 } from "zod";
var ChannelSchema = z4.enum(["WHATSAPP", "SMS", "EMAIL", "RCS"]);
var SendMessageItemSchema = z4.object({
  /** CommunicationLog id — echoed back so the CRM can resolve the row. */
  clientRef: z4.string().min(1),
  customerId: z4.string().min(1),
  campaignId: z4.string().min(1),
  channel: ChannelSchema,
  /** Phone (WhatsApp/SMS/RCS) or email (EMAIL). */
  to: z4.string().min(1),
  renderedMessage: z4.string().min(1),
  /** Send-Time Intelligence: ISO time the sim should delay the lifecycle until. */
  scheduledFor: z4.string().datetime().optional(),
  /** True when this message lands in the customer's inferred peak window — the
   * sim boosts its read rate, producing the measurable open-rate lift. */
  peakWindow: z4.boolean().optional()
});
var SendBatchRequestSchema = z4.object({
  messages: z4.array(SendMessageItemSchema).min(1).max(100)
});
var SendResultSchema = z4.object({
  clientRef: z4.string(),
  /** Present when accepted; null when synchronously rejected. */
  vendorMessageId: z4.string().nullable(),
  status: z4.enum(["accepted", "rejected"]),
  reason: z4.string().optional()
});
var SendBatchResponseSchema = z4.object({
  results: z4.array(SendResultSchema)
});
var ReceiptEventTypeSchema = z4.enum(["delivered", "read", "clicked", "failed"]);
var ReceiptEventPayloadSchema = z4.object({
  vendorMessageId: z4.string().min(1),
  eventType: ReceiptEventTypeSchema,
  occurredAt: z4.string().datetime(),
  /** Failure reason for `failed` events (blocked, bounce, …). */
  reason: z4.string().optional()
});
var ReceiptBatchSchema = z4.object({
  /** Flush timestamp — the CRM rejects batches older than the skew window. */
  sentAt: z4.string().datetime(),
  events: z4.array(ReceiptEventPayloadSchema).min(1)
});
var ReceiptAckSchema = z4.object({
  accepted: z4.number().int(),
  duplicates: z4.number().int(),
  failed: z4.number().int()
});
var SIGNATURE_HEADER = "x-signature";
var IDEMPOTENCY_HEADER = "idempotency-key";

// ../../packages/shared/src/sendWindows.ts
import { z as z5 } from "zod";
var PEAK_WINDOW_READ_BOOST = 1.3;
var WindowStatRowSchema = z5.object({
  window: z5.string(),
  sent: z5.number().int(),
  delivered: z5.number().int(),
  read: z5.number().int(),
  readRate: z5.number()
});
var WindowStatsResponseSchema = z5.object({
  windows: z5.array(WindowStatRowSchema),
  baselineReadRate: z5.number(),
  liftPp: z5.number()
});

// ../../packages/shared/src/routing.ts
import { z as z6 } from "zod";
var ChannelRoutingDecisionSchema = z6.object({
  customerId: z6.string().min(1),
  channel: ChannelSchema,
  /** One short sentence on why this channel won. */
  reason: z6.string().min(1).max(200),
  confidence: z6.number().min(0).max(1)
});
var RoutingDistributionSchema = z6.object({
  whatsapp: z6.number().int().nonnegative(),
  sms: z6.number().int().nonnegative(),
  email: z6.number().int().nonnegative(),
  rcs: z6.number().int().nonnegative()
});
var RoutePreviewResponseSchema = z6.object({
  distribution: RoutingDistributionSchema,
  sampleReasons: z6.array(
    z6.object({
      customerId: z6.string(),
      channel: ChannelSchema,
      reason: z6.string()
    })
  ),
  /** Audience-weighted CTR using the shared CHANNEL_CTR benchmarks (percentage points). */
  estimatedBlendedCtr: z6.number()
});

// ../../packages/shared/src/segment.ts
import { z as z7 } from "zod";
var SEGMENT_NUMERIC_FIELDS = [
  "total_spend",
  "order_count",
  "avg_order_value",
  "last_order_days_ago",
  "created_days_ago"
];
var SEGMENT_FIELDS = [...SEGMENT_NUMERIC_FIELDS, "city", "tags"];
var MAX_SEGMENT_DEPTH = 3;
var NumericComparatorSchema = z7.enum(["gt", "gte", "lt", "lte", "eq", "neq"]);
var NumericConditionSchema = z7.object({
  field: z7.enum(SEGMENT_NUMERIC_FIELDS),
  cmp: NumericComparatorSchema,
  value: z7.number().int().nonnegative()
});
var CityConditionSchema = z7.object({
  field: z7.literal("city"),
  cmp: z7.enum(["eq", "neq", "in"]),
  value: z7.union([z7.string().min(1), z7.array(z7.string().min(1)).min(1)])
}).superRefine((condition, ctx) => {
  const isArray = Array.isArray(condition.value);
  if (condition.cmp === "in" && !isArray) {
    ctx.addIssue({ code: "custom", message: "city 'in' requires an array of cities" });
  }
  if (condition.cmp !== "in" && isArray) {
    ctx.addIssue({ code: "custom", message: "city eq/neq require a single city" });
  }
});
var TagsConditionSchema = z7.object({
  field: z7.literal("tags"),
  cmp: z7.literal("contains"),
  value: z7.string().min(1)
});
var SegmentConditionSchema = z7.union([
  NumericConditionSchema,
  CityConditionSchema,
  TagsConditionSchema
]);
var SegmentGroupSchema = z7.lazy(
  () => z7.object({
    op: z7.enum(["AND", "OR"]),
    children: z7.array(SegmentNodeSchema).min(1, "A group must contain at least one condition")
  })
);
var SegmentNodeSchema = z7.lazy(
  () => z7.union([SegmentConditionSchema, SegmentGroupSchema])
);
function segmentGroupDepth(node) {
  if (!("op" in node)) {
    return 0;
  }
  return 1 + node.children.reduce((max, child) => Math.max(max, segmentGroupDepth(child)), 0);
}
var SegmentRulesSchema = SegmentNodeSchema.superRefine((node, ctx) => {
  if (segmentGroupDepth(node) > MAX_SEGMENT_DEPTH) {
    ctx.addIssue({
      code: "custom",
      message: `Maximum nesting depth is ${MAX_SEGMENT_DEPTH}`
    });
  }
});

// ../../packages/shared/src/crypto.ts
import { createHmac, timingSafeEqual } from "node:crypto";
function signPayload(secret, rawBody) {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}
function verifyPayload(secret, rawBody, signature) {
  if (!signature) {
    return false;
  }
  const expected = Buffer.from(signPayload(secret, rawBody), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}

// src/app.ts
import express from "express";

// src/config.ts
import { z as z8 } from "zod";
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
}
var EnvSchema = z8.object({
  PORT: z8.coerce.number().int().min(1).max(65535).default(4001),
  CRM_URL: z8.url().default("http://localhost:3000"),
  WEBHOOK_SECRET: z8.string().min(8),
  SIM_SPEED: z8.coerce.number().positive().default(1),
  /** Share of CLICKED messages that place an attributed order (SPEC §7). */
  CONVERSION_RATE: z8.coerce.number().min(0).max(1).default(0.08)
});
var parsed = EnvSchema.safeParse(process.env);
var configError = parsed.success ? null : `channel-sim: invalid environment configuration
${parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`).join("\n")}`;
if (configError) {
  console.error(configError);
}
var data = parsed.success ? parsed.data : { PORT: 4001, CRM_URL: "http://localhost:3000", WEBHOOK_SECRET: "", SIM_SPEED: 1, CONVERSION_RATE: 0.08 };
var config = Object.freeze({
  port: data.PORT,
  crmUrl: data.CRM_URL,
  webhookSecret: data.WEBHOOK_SECRET,
  simSpeed: data.SIM_SPEED,
  conversionRate: data.CONVERSION_RATE
});

// src/logger.ts
function write(level, msg, fields) {
  const line = JSON.stringify({
    level,
    msg,
    time: (/* @__PURE__ */ new Date()).toISOString(),
    ...fields
  });
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}
`);
}
var logger = {
  info: (msg, fields) => write("info", msg, fields),
  warn: (msg, fields) => write("warn", msg, fields),
  error: (msg, fields) => write("error", msg, fields)
};

// src/store.ts
var messages = /* @__PURE__ */ new Map();
var idempotency = /* @__PURE__ */ new Map();
function putMessage(vendorMessageId, record) {
  messages.set(vendorMessageId, record);
}
function getCachedBatch(idempotencyKey) {
  return idempotency.get(idempotencyKey);
}
function cacheBatch(idempotencyKey, response) {
  idempotency.set(idempotencyKey, response);
}

// src/app.ts
var SYNC_REJECT_REASONS = ["invalid_number", "opted_out"];
var SYNC_REJECT_RATE = 0.05;
function createApp(dispatch) {
  const app2 = express();
  app2.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      }
    })
  );
  app2.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info("request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100
      });
    });
    next();
  });
  app2.get("/", (_req, res) => {
    const healthy = configError === null;
    res.status(200).type("html").send(`<!doctype html>
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
  <h1><span class="dot">\u25CF</span> Resonate channel-sim \u2014 ${healthy ? "running" : "running (check config)"}</h1>
  <p>Outbound message simulator for the Resonate CRM. This is a <b>backend service</b>, not the app UI:
  the CRM calls <code>POST /v1/messages</code> and the sim posts signed delivery receipts back to the CRM.</p>
  <p class="muted">Health JSON: <a href="/health">/health</a></p>
</div></body></html>`);
  });
  app2.get("/health", (_req, res) => {
    const body = HealthResponseSchema.parse({
      status: "ok",
      service: "channel-sim",
      version: "0.2.0-rootfix",
      time: (/* @__PURE__ */ new Date()).toISOString()
    });
    res.status(200).json({
      ...body,
      config: {
        ok: configError === null,
        webhookSecretSet: config.webhookSecret.length >= 8,
        crmUrl: config.crmUrl,
        ...configError !== null ? { error: configError } : {}
      }
    });
  });
  app2.post("/v1/messages", (req, res) => {
    if (!verifyPayload(config.webhookSecret, req.rawBody ?? "", req.header(SIGNATURE_HEADER))) {
      res.status(401).json(errorEnvelope("invalid_signature", "Invalid or missing signature"));
      return;
    }
    const idempotencyKey = req.header(IDEMPOTENCY_HEADER);
    if (idempotencyKey !== void 0) {
      const cached = getCachedBatch(idempotencyKey);
      if (cached !== void 0) {
        res.status(202).json(cached);
        return;
      }
    }
    const parsed2 = SendBatchRequestSchema.safeParse(req.body);
    if (!parsed2.success) {
      res.status(422).json(errorEnvelope("invalid_request", parsed2.error.message));
      return;
    }
    const accepted = [];
    const results = parsed2.data.messages.map((message) => {
      if (Math.random() < SYNC_REJECT_RATE) {
        const reason = SYNC_REJECT_REASONS[Math.floor(Math.random() * SYNC_REJECT_REASONS.length)] ?? SYNC_REJECT_REASONS[0];
        return { clientRef: message.clientRef, vendorMessageId: null, status: "rejected", reason };
      }
      const vendorMessageId = randomUUID();
      const record = {
        channel: message.channel,
        clientRef: message.clientRef,
        customerId: message.customerId,
        campaignId: message.campaignId,
        peakWindow: message.peakWindow ?? false
      };
      putMessage(vendorMessageId, record);
      const startDelayMs = message.scheduledFor ? Math.max(0, new Date(message.scheduledFor).getTime() - Date.now()) : 0;
      accepted.push({ vendorMessageId, record, startDelayMs });
      return { clientRef: message.clientRef, vendorMessageId, status: "accepted" };
    });
    const response = SendBatchResponseSchema.parse({ results });
    if (idempotencyKey !== void 0) {
      cacheBatch(idempotencyKey, response);
    }
    res.status(202).json(response);
    if (accepted.length > 0) {
      try {
        dispatch(accepted);
      } catch (err) {
        logger.error("lifecycle dispatch failed", {
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
  });
  app2.use((_req, res) => {
    res.status(404).json(errorEnvelope("not_found", "Resource not found"));
  });
  app2.use((err, _req, res, _next) => {
    logger.error("unhandled error", {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : void 0
    });
    res.status(500).json(errorEnvelope("internal_error", "Internal server error"));
  });
  return app2;
}

// src/conversions.ts
var FALLBACK_SKU = {
  name: "Single-Origin Arabica 250g",
  category: "beans",
  min: 45e3,
  max: 9e4
};
var SKUS = [
  FALLBACK_SKU,
  { name: "Estate Reserve Beans 500g", category: "beans", min: 9e4, max: 16e4 },
  { name: "Espresso Blend 1kg", category: "beans", min: 14e4, max: 22e4 },
  { name: "Pour-Over Kit", category: "equipment", min: 18e4, max: 32e4 },
  { name: "AeroPress Go", category: "equipment", min: 3e5, max: 45e4 },
  { name: "Monthly Beans Subscription", category: "subscription", min: 8e4, max: 14e4 }
];
var RETRY_BACKOFF_MS = [500, 1500];
var ORDERS_PATH = "/api/orders";
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
function pickSku() {
  return SKUS[Math.floor(Math.random() * SKUS.length)] ?? FALLBACK_SKU;
}
function buildOrder(record) {
  const lineCount = Math.random() < 0.3 ? 2 : 1;
  const items = [];
  for (let i = 0; i < lineCount; i += 1) {
    const sku = pickSku();
    const qty = sku.category === "equipment" ? 1 : randInt(1, 2);
    const price = randInt(sku.min, sku.max);
    items.push({ name: sku.name, category: sku.category, qty, price });
  }
  const amount = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return OrderInputSchema.parse({
    customerId: record.customerId,
    amount,
    currency: "INR",
    items,
    placedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: "CAMPAIGN",
    attributedCampaignId: record.campaignId,
    attributedCommunicationId: record.clientRef
  });
}
async function postOrder(body) {
  try {
    const res = await fetch(`${config.crmUrl}${ORDERS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}
async function recordConversion(record) {
  let body;
  try {
    body = JSON.stringify(buildOrder(record));
  } catch (err) {
    logger.error("conversion build failed", {
      message: err instanceof Error ? err.message : String(err)
    });
    return;
  }
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    if (await postOrder(body)) {
      logger.info("conversion recorded", { campaignId: record.campaignId });
      return;
    }
    const backoff = RETRY_BACKOFF_MS[attempt];
    if (backoff !== void 0) {
      await sleep(backoff);
    }
  }
  logger.warn("conversion dropped (CRM unreachable)", { campaignId: record.campaignId });
}

// src/funnels.ts
var WHATSAPP_DELIVERED_RATE = 0.94;
var WHATSAPP_DELIVERY_DELAY = { minMs: 500, maxMs: 6e3 };
var WHATSAPP_READ_RATE = 0.7;
var WHATSAPP_READ_DELAY = { minMs: 2e3, maxMs: 45e3 };
var WHATSAPP_CLICKED_RATE = 0.28;
var WHATSAPP_CLICK_DELAY = { minMs: 2e3, maxMs: 3e4 };
var WHATSAPP_FAILURE_REASONS = ["blocked", "expired"];
var SMS_DELIVERED_RATE = 0.96;
var SMS_DELIVERY_DELAY = { minMs: 500, maxMs: 6e3 };
var SMS_CLICKED_RATE = 0.06;
var SMS_CLICK_DELAY = { minMs: 2e3, maxMs: 3e4 };
var SMS_FAILURE_REASONS = ["invalid_number", "carrier_reject"];
var EMAIL_DELIVERED_RATE = 0.9;
var EMAIL_DELIVERY_DELAY = { minMs: 1e3, maxMs: 8e3 };
var EMAIL_READ_RATE = 0.42;
var EMAIL_READ_DELAY = { minMs: 5e3, maxMs: 6e4 };
var EMAIL_CLICKED_RATE = 0.09;
var EMAIL_CLICK_DELAY = { minMs: 2e3, maxMs: 3e4 };
var EMAIL_FAILURE_REASONS = ["bounce", "spam_block"];
var RCS_DELIVERED_RATE = 0.88;
var FUNNELS = {
  WHATSAPP: {
    deliveredRate: WHATSAPP_DELIVERED_RATE,
    deliveryDelay: WHATSAPP_DELIVERY_DELAY,
    readRate: WHATSAPP_READ_RATE,
    readDelay: WHATSAPP_READ_DELAY,
    clickedRate: WHATSAPP_CLICKED_RATE,
    clickDelay: WHATSAPP_CLICK_DELAY,
    failureReasons: WHATSAPP_FAILURE_REASONS
  },
  SMS: {
    deliveredRate: SMS_DELIVERED_RATE,
    deliveryDelay: SMS_DELIVERY_DELAY,
    readRate: null,
    readDelay: null,
    clickedRate: SMS_CLICKED_RATE,
    clickDelay: SMS_CLICK_DELAY,
    failureReasons: SMS_FAILURE_REASONS
  },
  EMAIL: {
    deliveredRate: EMAIL_DELIVERED_RATE,
    deliveryDelay: EMAIL_DELIVERY_DELAY,
    readRate: EMAIL_READ_RATE,
    readDelay: EMAIL_READ_DELAY,
    clickedRate: EMAIL_CLICKED_RATE,
    clickDelay: EMAIL_CLICK_DELAY,
    failureReasons: EMAIL_FAILURE_REASONS
  },
  RCS: {
    deliveredRate: RCS_DELIVERED_RATE,
    deliveryDelay: WHATSAPP_DELIVERY_DELAY,
    readRate: WHATSAPP_READ_RATE,
    readDelay: WHATSAPP_READ_DELAY,
    clickedRate: WHATSAPP_CLICKED_RATE,
    clickDelay: WHATSAPP_CLICK_DELAY,
    failureReasons: WHATSAPP_FAILURE_REASONS
  }
};
function getFunnel(channel) {
  return FUNNELS[channel];
}

// src/receipts.ts
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
var RETRY_BACKOFF_MS2 = [500, 1e3, 2e3, 4e3, 8e3];
var RECEIPTS_PATH = "/api/webhooks/receipts";
function deadLetterPath() {
  try {
    return fileURLToPath(new URL("../dead-letter.log", import.meta.url));
  } catch {
    return join(tmpdir(), "channel-sim-dead-letter.log");
  }
}
function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a !== void 0 && b !== void 0) {
      items[i] = b;
      items[j] = a;
    }
  }
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function postBatch(body, signature) {
  try {
    const res = await fetch(`${config.crmUrl}${RECEIPTS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature
      },
      body
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}
async function deadLetter(body) {
  try {
    await appendFile(deadLetterPath(), `${body}
`, "utf8");
  } catch (err) {
    logger.error("dead-letter append failed", {
      message: err instanceof Error ? err.message : String(err)
    });
  }
}
async function deliverBatch(batch) {
  const body = JSON.stringify(batch);
  const signature = signPayload(config.webhookSecret, body);
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS2.length; attempt += 1) {
    const ok = await postBatch(body, signature);
    if (ok) {
      logger.info("receipts delivered", { count: batch.events.length, attempt: attempt + 1 });
      return;
    }
    const backoff = RETRY_BACKOFF_MS2[attempt];
    if (backoff !== void 0) {
      await sleep2(backoff);
    }
  }
  await deadLetter(body);
  logger.warn("receipts dead-lettered", {
    count: batch.events.length,
    attempts: RETRY_BACKOFF_MS2.length
  });
}
async function deliverReceipts(events) {
  if (events.length === 0) {
    return;
  }
  shuffle(events);
  const batch = ReceiptBatchSchema.parse({
    sentAt: (/* @__PURE__ */ new Date()).toISOString(),
    events
  });
  await deliverBatch(batch);
}

// src/lifecycle.ts
var CONVERSION_MIN_MS = 1e4;
var CONVERSION_MAX_MS = 6e4;
function jitter(range) {
  const raw = range.minMs + Math.random() * (range.maxMs - range.minMs);
  return raw / config.simSpeed;
}
function pick(items, fallback) {
  if (items.length === 0) {
    return fallback;
  }
  const index = Math.floor(Math.random() * items.length);
  return items[index] ?? fallback;
}
function rollLifecycle(record) {
  const funnel = getFunnel(record.channel);
  const deliveryDelay = jitter(funnel.deliveryDelay);
  if (Math.random() >= funnel.deliveredRate) {
    const reason = pick(funnel.failureReasons, "failed");
    return { events: [{ eventType: "failed", delayMs: deliveryDelay, reason }], conversionDelayMs: null };
  }
  const events = [{ eventType: "delivered", delayMs: deliveryDelay }];
  let clickBaseDelay = deliveryDelay;
  if (funnel.readRate !== null && funnel.readDelay !== null) {
    const readRate = record.peakWindow ? Math.min(0.96, funnel.readRate * PEAK_WINDOW_READ_BOOST) : funnel.readRate;
    if (Math.random() < readRate) {
      const readDelay = deliveryDelay + jitter(funnel.readDelay);
      events.push({ eventType: "read", delayMs: readDelay });
      clickBaseDelay = readDelay;
    } else {
      return { events, conversionDelayMs: null };
    }
  }
  if (Math.random() < funnel.clickedRate) {
    const clickDelay = clickBaseDelay + jitter(funnel.clickDelay);
    events.push({ eventType: "clicked", delayMs: clickDelay });
    if (Math.random() < config.conversionRate) {
      const conversionDelayMs = clickDelay + (CONVERSION_MIN_MS + Math.random() * (CONVERSION_MAX_MS - CONVERSION_MIN_MS)) / config.simSpeed;
      return { events, conversionDelayMs };
    }
  }
  return { events, conversionDelayMs: null };
}

// src/simulate.ts
var HEAD_START_MS = 1500;
var BUDGET_MS = 4e4;
var FLUSH_INTERVAL_MS = 800;
var MAX_BATCH_SIZE = 500;
var sleep3 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function simulateBatch(messages2) {
  if (messages2.length === 0) {
    return;
  }
  const entries = [];
  for (const message of messages2) {
    const plan = rollLifecycle(message.record);
    const base = Math.max(0, message.startDelayMs);
    for (const event of plan.events) {
      entries.push({
        at: base + event.delayMs,
        kind: "event",
        event: {
          vendorMessageId: message.vendorMessageId,
          eventType: event.eventType,
          occurredAt: "",
          // stamped at fire time below
          ...event.reason !== void 0 ? { reason: event.reason } : {}
        }
      });
    }
    if (plan.conversionDelayMs !== null) {
      entries.push({ at: base + plan.conversionDelayMs, kind: "conversion", record: message.record });
    }
  }
  if (entries.length === 0) {
    return;
  }
  const maxAt = entries.reduce((max, entry) => Math.max(max, entry.at), 0);
  const lifecycleBudget = BUDGET_MS - HEAD_START_MS;
  const scale = maxAt > lifecycleBudget ? lifecycleBudget / maxAt : 1;
  entries.sort((a, b) => a.at - b.at);
  const buffer = [];
  const inflight = [];
  const startedAt = Date.now();
  let lastFlush = startedAt;
  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    const batch = buffer.splice(0, MAX_BATCH_SIZE);
    lastFlush = Date.now();
    inflight.push(
      deliverReceipts(batch).catch((err) => {
        logger.error("serverless receipt flush failed", {
          message: err instanceof Error ? err.message : String(err)
        });
      })
    );
  };
  for (const entry of entries) {
    const waitMs = startedAt + HEAD_START_MS + entry.at * scale - Date.now();
    if (waitMs > 0) {
      await sleep3(waitMs);
    }
    if (entry.kind === "event") {
      buffer.push({ ...entry.event, occurredAt: (/* @__PURE__ */ new Date()).toISOString() });
      if (buffer.length >= MAX_BATCH_SIZE || Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
        flush();
      }
    } else {
      inflight.push(recordConversion(entry.record));
    }
  }
  flush();
  await Promise.allSettled(inflight);
  logger.info("serverless batch simulated", { messages: messages2.length, events: entries.length });
}

// src/serverless.ts
var app = createApp((messages2) => {
  waitUntil(simulateBatch(messages2));
});
var serverless_default = app;
export {
  serverless_default as default
};
