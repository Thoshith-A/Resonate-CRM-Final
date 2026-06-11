import { z } from "zod";

/**
 * Ingestion contracts shared by the CRM API and the channel simulator's
 * conversion loop (which posts orders back through `POST /api/orders`).
 * Money is always integer paise — never floats.
 */

export const OrderSourceSchema = z.enum(["ORGANIC", "CAMPAIGN"]);
export type OrderSource = z.infer<typeof OrderSourceSchema>;

export const OrderItemSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  qty: z.number().int().positive(),
  /** Unit price in integer paise. */
  price: z.number().int().nonnegative(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const CustomerInputSchema = z.object({
  externalId: z.string().min(1).optional(),
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  city: z.string().min(1),
  tags: z.array(z.string()).default([]),
});
export type CustomerInput = z.infer<typeof CustomerInputSchema>;

export const OrderInputSchema = z
  .object({
    /** Resolve the buyer by internal id or external id — at least one. */
    customerId: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
    /** Total order amount in integer paise. */
    amount: z.number().int().positive(),
    currency: z.string().default("INR"),
    items: z.array(OrderItemSchema).min(1),
    /** ISO-8601 timestamp. */
    placedAt: z.string().datetime(),
    source: OrderSourceSchema.default("ORGANIC"),
    attributedCampaignId: z.string().min(1).optional(),
    attributedCommunicationId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.customerId ?? value.externalId), {
    message: "Either customerId or externalId is required",
    path: ["customerId"],
  });
export type OrderInput = z.infer<typeof OrderInputSchema>;
