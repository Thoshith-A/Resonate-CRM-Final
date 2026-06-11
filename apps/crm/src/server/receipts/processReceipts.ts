import { Prisma } from "@prisma/client";
import type { ReceiptAck, ReceiptBatch } from "@resonate/shared";
import { prisma } from "../db";
import { foldEvents, type CommState, type FoldEvent, type MessageStatus } from "./statusMachine";

type RowUpdate = {
  id: string;
  status: MessageStatus;
  deliveredAt: Date | null;
  readAt: Date | null;
  clickedAt: Date | null;
  failureReason: string | null;
};

/**
 * Ingest a receipt batch idempotently. In ONE transaction:
 *  1. Find which (vendorMessageId, eventType) pairs already exist in the
 *     append-only ReceiptEvent ledger — those are vendor retries/replays.
 *  2. Insert only the fresh events (the unique constraint makes this safe
 *     even under a race).
 *  3. Fold ONLY the fresh events into CommunicationLog via the forward-only
 *     state machine, applied as a SINGLE bulk UPDATE so a 50-event batch is
 *     four round-trips, not fifty (which would blow the txn timeout).
 * Replaying a batch produces zero duplicate state changes.
 */
export async function processReceipts(batch: ReceiptBatch): Promise<ReceiptAck> {
  // Collapse any within-batch duplicates by (vendorMessageId, eventType).
  const byPair = new Map<string, ReceiptBatch["events"][number]>();
  for (const event of batch.events) {
    byPair.set(`${event.vendorMessageId}|${event.eventType}`, event);
  }
  const events = [...byPair.values()];
  const vendorIds = [...new Set(events.map((e) => e.vendorMessageId))];

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.receiptEvent.findMany({
        where: { vendorMessageId: { in: vendorIds } },
        select: { vendorMessageId: true, eventType: true },
      });
      const existingPairs = new Set(
        existing.map((e) => `${e.vendorMessageId}|${e.eventType}`),
      );

      const fresh = events.filter(
        (e) => !existingPairs.has(`${e.vendorMessageId}|${e.eventType}`),
      );
      const duplicates = events.length - fresh.length;

      if (fresh.length === 0) {
        return { accepted: 0, duplicates, failed: 0 };
      }

      await tx.receiptEvent.createMany({
        data: fresh.map((e) => ({
          vendorMessageId: e.vendorMessageId,
          eventType: e.eventType,
          occurredAt: new Date(e.occurredAt),
          payload: e as unknown as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });

      // Group fresh events per message.
      const freshByVendor = new Map<string, FoldEvent[]>();
      for (const e of fresh) {
        const list = freshByVendor.get(e.vendorMessageId) ?? [];
        list.push({
          eventType: e.eventType,
          occurredAt: new Date(e.occurredAt),
          reason: e.reason ?? null,
        });
        freshByVendor.set(e.vendorMessageId, list);
      }

      const logs = await tx.communicationLog.findMany({
        where: { vendorMessageId: { in: [...freshByVendor.keys()] } },
        select: {
          id: true,
          vendorMessageId: true,
          status: true,
          deliveredAt: true,
          readAt: true,
          clickedAt: true,
          failureReason: true,
        },
      });
      const logByVendor = new Map<string, (typeof logs)[number]>();
      for (const log of logs) {
        if (log.vendorMessageId) {
          logByVendor.set(log.vendorMessageId, log);
        }
      }

      const updates: RowUpdate[] = [];
      let accepted = 0;
      let failed = 0;
      for (const [vendorMessageId, vendorEvents] of freshByVendor) {
        const log = logByVendor.get(vendorMessageId);
        if (!log) {
          // Unknown vendorMessageId — recorded in the ledger but unapplicable.
          failed += vendorEvents.length;
          continue;
        }
        const current: CommState = {
          status: log.status as MessageStatus,
          deliveredAt: log.deliveredAt,
          readAt: log.readAt,
          clickedAt: log.clickedAt,
          failureReason: log.failureReason,
        };
        const next = foldEvents(current, vendorEvents);
        updates.push({ id: log.id, ...next });
        accepted += vendorEvents.length;
      }

      if (updates.length > 0) {
        await applyUpdates(tx, updates);
      }

      return { accepted, duplicates, failed };
    },
    { timeout: 20_000, maxWait: 10_000 },
  );
}

/** One bulk UPDATE … FROM (VALUES …) for every folded row in the batch. */
async function applyUpdates(tx: Prisma.TransactionClient, updates: RowUpdate[]): Promise<void> {
  const rows = updates.map(
    (u) =>
      Prisma.sql`(${u.id}, ${u.status}::"MessageStatus", ${u.deliveredAt}::timestamptz, ${u.readAt}::timestamptz, ${u.clickedAt}::timestamptz, ${u.failureReason}::text)`,
  );
  await tx.$executeRaw`
    UPDATE "CommunicationLog" AS cl
    SET "status" = v.status,
        "deliveredAt" = v.delivered_at,
        "readAt" = v.read_at,
        "clickedAt" = v.clicked_at,
        "failureReason" = v.failure_reason,
        "updatedAt" = now()
    FROM (VALUES ${Prisma.join(rows)}) AS v(id, status, delivered_at, read_at, clicked_at, failure_reason)
    WHERE cl.id = v.id
  `;
}
