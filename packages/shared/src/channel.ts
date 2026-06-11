import { z } from "zod";

/**
 * Channel API + webhook contracts shared by the CRM and the channel
 * simulator. The CRM dispatches signed message batches to the sim; the sim
 * posts back signed, batched, shuffled receipt events. Both sides validate
 * against these exact schemas, so the wire format can never silently drift.
 */

export const ChannelSchema = z.enum(["WHATSAPP", "SMS", "EMAIL", "RCS"]);
export type Channel = z.infer<typeof ChannelSchema>;

// ── CRM → sim: dispatch a batch ──────────────────────────────────────────
export const SendMessageItemSchema = z.object({
  /** CommunicationLog id — echoed back so the CRM can resolve the row. */
  clientRef: z.string().min(1),
  customerId: z.string().min(1),
  campaignId: z.string().min(1),
  channel: ChannelSchema,
  /** Phone (WhatsApp/SMS/RCS) or email (EMAIL). */
  to: z.string().min(1),
  renderedMessage: z.string().min(1),
});
export type SendMessageItem = z.infer<typeof SendMessageItemSchema>;

export const SendBatchRequestSchema = z.object({
  messages: z.array(SendMessageItemSchema).min(1).max(100),
});
export type SendBatchRequest = z.infer<typeof SendBatchRequestSchema>;

export const SendResultSchema = z.object({
  clientRef: z.string(),
  /** Present when accepted; null when synchronously rejected. */
  vendorMessageId: z.string().nullable(),
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().optional(),
});
export type SendResult = z.infer<typeof SendResultSchema>;

export const SendBatchResponseSchema = z.object({
  results: z.array(SendResultSchema),
});
export type SendBatchResponse = z.infer<typeof SendBatchResponseSchema>;

// ── sim → CRM: receipt webhook ───────────────────────────────────────────
export const ReceiptEventTypeSchema = z.enum(["delivered", "read", "clicked", "failed"]);
export type ReceiptEventType = z.infer<typeof ReceiptEventTypeSchema>;

export const ReceiptEventPayloadSchema = z.object({
  vendorMessageId: z.string().min(1),
  eventType: ReceiptEventTypeSchema,
  occurredAt: z.string().datetime(),
  /** Failure reason for `failed` events (blocked, bounce, …). */
  reason: z.string().optional(),
});
export type ReceiptEventPayload = z.infer<typeof ReceiptEventPayloadSchema>;

export const ReceiptBatchSchema = z.object({
  /** Flush timestamp — the CRM rejects batches older than the skew window. */
  sentAt: z.string().datetime(),
  events: z.array(ReceiptEventPayloadSchema).min(1),
});
export type ReceiptBatch = z.infer<typeof ReceiptBatchSchema>;

export const ReceiptAckSchema = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  failed: z.number().int(),
});
export type ReceiptAck = z.infer<typeof ReceiptAckSchema>;

/** Header names for the signed transport. */
export const SIGNATURE_HEADER = "x-signature";
export const IDEMPOTENCY_HEADER = "idempotency-key";
