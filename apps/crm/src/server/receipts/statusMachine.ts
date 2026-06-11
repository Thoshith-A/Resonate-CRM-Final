import type { ReceiptEventType } from "@resonate/shared";

/**
 * Forward-only delivery state machine. Out-of-order, duplicated, and
 * partial receipt batches must never corrupt a message's status, so status
 * only ever advances along a precedence ladder; FAILED is terminal and only
 * reachable from QUEUED/SENT. Pure and exhaustively unit-tested.
 *
 * QUEUED(0) < SENT(1) < DELIVERED(2) < READ(3) < CLICKED(4). FAILED is off
 * the ladder. A CLICKED arriving before DELIVERED still lands at CLICKED
 * with both timestamps stamped — order does not matter.
 */
export type MessageStatus =
  | "QUEUED"
  | "SENT"
  | "FAILED"
  | "DELIVERED"
  | "READ"
  | "CLICKED";

const PRECEDENCE: Record<Exclude<MessageStatus, "FAILED">, number> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  CLICKED: 4,
};

const STATUS_BY_PRECEDENCE: Exclude<MessageStatus, "FAILED">[] = [
  "QUEUED",
  "SENT",
  "DELIVERED",
  "READ",
  "CLICKED",
];

export type CommState = {
  status: MessageStatus;
  deliveredAt: Date | null;
  readAt: Date | null;
  clickedAt: Date | null;
  failureReason: string | null;
};

export type FoldEvent = {
  eventType: ReceiptEventType;
  occurredAt: Date;
  reason?: string | null;
};

/**
 * Fold a set of receipt events into the current state. Order-independent:
 * the result depends only on which event types are present, not their
 * arrival order.
 */
export function foldEvents(current: CommState, events: readonly FoldEvent[]): CommState {
  // FAILED is terminal — nothing reopens a failed message.
  if (current.status === "FAILED") {
    return current;
  }

  let deliveredAt = current.deliveredAt;
  let readAt = current.readAt;
  let clickedAt = current.clickedAt;
  let failureReason = current.failureReason;
  let sawFailed = false;

  for (const event of events) {
    switch (event.eventType) {
      case "delivered":
        deliveredAt = event.occurredAt;
        break;
      case "read":
        readAt = event.occurredAt;
        break;
      case "clicked":
        clickedAt = event.occurredAt;
        break;
      case "failed":
        sawFailed = true;
        failureReason = event.reason ?? failureReason ?? "failed";
        break;
    }
  }

  // Furthest forward progress = max of current status + any stamped timestamps.
  const reached = Math.max(
    PRECEDENCE[current.status],
    deliveredAt ? PRECEDENCE.DELIVERED : -1,
    readAt ? PRECEDENCE.READ : -1,
    clickedAt ? PRECEDENCE.CLICKED : -1,
  );

  // A failure only wins if the message never got past SENT. If it also has a
  // delivered/read/clicked event, that real progress takes precedence
  // (a "failed" after delivery is contradictory and is ignored for status).
  if (sawFailed && reached <= PRECEDENCE.SENT) {
    return {
      status: "FAILED",
      deliveredAt,
      readAt,
      clickedAt,
      failureReason: failureReason ?? "failed",
    };
  }

  return {
    status: STATUS_BY_PRECEDENCE[reached],
    deliveredAt,
    readAt,
    clickedAt,
    failureReason,
  };
}
