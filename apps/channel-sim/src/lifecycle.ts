import type { Channel, ReceiptEventType } from "@resonate/shared";
import { config } from "./config";
import { getFunnel, type DelayRange } from "./funnels";
import { enqueueReceipt } from "./receipts";

/**
 * Rolls a message through its channel funnel and schedules the resulting
 * receipt events on jittered timers (SPEC §7). Every delay is divided by
 * config.simSpeed, so SIM_SPEED=4 plays the whole funnel out ~4x faster.
 */

function jitter(range: DelayRange): number {
  const raw = range.minMs + Math.random() * (range.maxMs - range.minMs);
  return raw / config.simSpeed;
}

function pick<T>(items: readonly T[], fallback: T): T {
  if (items.length === 0) {
    return fallback;
  }
  const index = Math.floor(Math.random() * items.length);
  return items[index] ?? fallback;
}

/**
 * Schedules a single receipt event to fire `delayMs` from now, stamping
 * occurredAt with the actual fire time.
 */
function scheduleEvent(
  vendorMessageId: string,
  eventType: ReceiptEventType,
  delayMs: number,
  reason?: string,
): void {
  setTimeout(() => {
    enqueueReceipt({
      vendorMessageId,
      eventType,
      occurredAt: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    });
  }, delayMs);
}

export function scheduleLifecycle(vendorMessageId: string, channel: Channel): void {
  const funnel = getFunnel(channel);
  const deliveryDelay = jitter(funnel.deliveryDelay);

  // 1. Delivered vs failed.
  if (Math.random() >= funnel.deliveredRate) {
    const reason = pick(funnel.failureReasons, "failed");
    scheduleEvent(vendorMessageId, "failed", deliveryDelay, reason);
    return;
  }

  scheduleEvent(vendorMessageId, "delivered", deliveryDelay);

  // 2. Read (channels without a read signal — e.g. SMS — roll clicks off
  //    delivery instead).
  let clickBaseDelay = deliveryDelay;
  if (funnel.readRate !== null && funnel.readDelay !== null) {
    if (Math.random() < funnel.readRate) {
      const readDelay = deliveryDelay + jitter(funnel.readDelay);
      scheduleEvent(vendorMessageId, "read", readDelay);
      clickBaseDelay = readDelay;
    } else {
      // Not read → no click follows a read that never happened.
      return;
    }
  }

  // 3. Clicked, off whichever base step applies.
  if (Math.random() < funnel.clickedRate) {
    scheduleEvent(vendorMessageId, "clicked", clickBaseDelay + jitter(funnel.clickDelay));
  }
}
