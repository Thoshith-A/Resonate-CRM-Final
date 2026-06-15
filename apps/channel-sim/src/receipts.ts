import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReceiptBatchSchema,
  SIGNATURE_HEADER,
  type ReceiptBatch,
  type ReceiptEventPayload,
} from "@resonate/shared";
import { signPayload } from "@resonate/shared/crypto";
import { config } from "./config";
import { logger } from "./logger";

/**
 * Receipt buffer + flusher (SPEC §7). Lifecycle timers enqueue events; a 3s
 * interval drains the buffer in shuffled batches, signs them, and POSTs to the
 * CRM webhook. Sends retry with backoff out-of-band so a slow/failing flush
 * never blocks the next tick, loses events, or double-sends a batch.
 */

// Tuned for a fast (<20s) demo: receipts flush every 1s in large batches so the
// live feed keeps up with SIM_SPEED. The out-of-order shuffle is still applied.
const FLUSH_INTERVAL_MS = 1000;
const MAX_BATCH_SIZE = 500;
const RETRY_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
const RECEIPTS_PATH = "/api/webhooks/receipts";

/**
 * Resolve the dead-letter path lazily and defensively. `import.meta.url` is
 * only valid in an ESM context; if the bundle is ever evaluated as CJS (some
 * serverless runtimes) referencing it at module load would crash the whole
 * function. Falling back to the OS temp dir also covers serverless, where the
 * deploy dir is read-only but the temp dir is writable.
 */
function deadLetterPath(): string {
  try {
    return fileURLToPath(new URL("../dead-letter.log", import.meta.url));
  } catch {
    return join(tmpdir(), "channel-sim-dead-letter.log");
  }
}

const buffer: ReceiptEventPayload[] = [];

export function enqueueReceipt(event: ReceiptEventPayload): void {
  buffer.push(event);
}

function shuffle<T>(items: T[]): void {
  // Fisher–Yates: out-of-order receipt delivery is an intentional feature.
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a !== undefined && b !== undefined) {
      items[i] = b;
      items[j] = a;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postBatch(body: string, signature: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.crmUrl}${RECEIPTS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature,
      },
      body,
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

async function deadLetter(body: string): Promise<void> {
  try {
    await appendFile(deadLetterPath(), `${body}\n`, "utf8");
  } catch (err) {
    logger.error("dead-letter append failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Sends an already-spliced batch with exponential backoff. The events are
 * owned by this task — they are no longer in the shared buffer — so on terminal
 * failure they are written to the dead-letter log rather than dropped.
 */
async function deliverBatch(batch: ReceiptBatch): Promise<void> {
  const body = JSON.stringify(batch);
  const signature = signPayload(config.webhookSecret, body);

  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt += 1) {
    const ok = await postBatch(body, signature);
    if (ok) {
      logger.info("receipts delivered", { count: batch.events.length, attempt: attempt + 1 });
      return;
    }
    const backoff = RETRY_BACKOFF_MS[attempt];
    if (backoff !== undefined) {
      await sleep(backoff);
    }
  }

  await deadLetter(body);
  logger.warn("receipts dead-lettered", {
    count: batch.events.length,
    attempts: RETRY_BACKOFF_MS.length,
  });
}

/**
 * Delivers an ad-hoc set of events as one signed batch (shuffled, retried,
 * dead-lettered on terminal failure) — the same guarantees as the periodic
 * flusher. Used by the serverless simulator, which owns its receipts per
 * request instead of draining the shared buffer. No-op on an empty set.
 */
export async function deliverReceipts(events: ReceiptEventPayload[]): Promise<void> {
  if (events.length === 0) {
    return;
  }
  shuffle(events);
  const batch = ReceiptBatchSchema.parse({
    sentAt: new Date().toISOString(),
    events,
  });
  await deliverBatch(batch);
}

function flushTick(): void {
  if (buffer.length === 0) {
    return;
  }
  // Splice atomically so this batch is owned by the delivery task and can never
  // be re-drained by a later tick.
  const events = buffer.splice(0, MAX_BATCH_SIZE);
  shuffle(events);
  const batch = ReceiptBatchSchema.parse({
    sentAt: new Date().toISOString(),
    events,
  });
  // Fire-and-forget: the interval keeps draining while retries play out.
  void deliverBatch(batch);
}

/** Starts the periodic flusher; returns the handle so it can be cleared. */
export function startReceiptFlusher(): NodeJS.Timeout {
  return setInterval(flushTick, FLUSH_INTERVAL_MS);
}
