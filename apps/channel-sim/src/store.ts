import type { Channel, SendBatchResponse } from "@resonate/shared";

/**
 * In-memory state for the simulator. This is an acknowledged tradeoff: a
 * restart drops in-flight lifecycles and idempotency history. A real vendor
 * would persist these, but for a demo simulator process-local maps are enough.
 */

/** Everything we need to remember about an accepted, in-flight message. */
export interface MessageRecord {
  readonly channel: Channel;
  readonly clientRef: string;
  /** Retained for the Phase 6 conversion loop (clicked → order). */
  readonly customerId: string;
  readonly campaignId: string;
}

const messages = new Map<string, MessageRecord>();
const idempotency = new Map<string, SendBatchResponse>();

export function putMessage(vendorMessageId: string, record: MessageRecord): void {
  messages.set(vendorMessageId, record);
}

export function getMessage(vendorMessageId: string): MessageRecord | undefined {
  return messages.get(vendorMessageId);
}

export function getCachedBatch(idempotencyKey: string): SendBatchResponse | undefined {
  return idempotency.get(idempotencyKey);
}

export function cacheBatch(idempotencyKey: string, response: SendBatchResponse): void {
  idempotency.set(idempotencyKey, response);
}
