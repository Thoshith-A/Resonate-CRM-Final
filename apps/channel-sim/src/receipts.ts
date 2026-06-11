import { appendFile } from "node:fs/promises";
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

const FLUSH_INTERVAL_MS = 3000;
const MAX_BATCH_SIZE = 50;
const RETRY_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
const RECEIPTS_PATH = "/api/webhooks/receipts";

const DEAD_LETTER_PATH = fileURLToPath(new URL("../dead-letter.log", import.meta.url));

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
    return res.ok;
  } catch {
    return false;
  }
}

async function deadLetter(body: string): Promise<void> {
  try {
    await appendFile(DEAD_LETTER_PATH, `${body}\n`, "utf8");
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
