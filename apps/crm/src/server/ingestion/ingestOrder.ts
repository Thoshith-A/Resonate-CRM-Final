import type { Order, Prisma } from "@prisma/client";
import type { OrderInput } from "@resonate/shared";
import { prisma } from "../db";
import { ApiError, notFound } from "../api";
import { applyOrderToAggregates, type CustomerAggregates } from "./aggregates";

/**
 * Ingest an order and maintain the buyer's denormalized aggregates in ONE
 * transaction, so a customer's totalSpend / orderCount / firstOrderAt /
 * lastOrderAt can never drift from their orders. Resolves the buyer by
 * internal id or externalId.
 */
export async function ingestOrder(input: OrderInput): Promise<Order> {
  const placedAt = new Date(input.placedAt);

  return prisma.$transaction(async (tx) => {
    const customer = await resolveCustomer(tx, input);

    const order = await tx.order.create({
      data: {
        customerId: customer.id,
        amount: input.amount,
        currency: input.currency,
        items: input.items as unknown as Prisma.InputJsonValue,
        placedAt,
        source: input.source,
        attributedCampaignId: input.attributedCampaignId ?? null,
        attributedCommunicationId: input.attributedCommunicationId ?? null,
      },
    });

    const prev: CustomerAggregates = {
      totalSpend: customer.totalSpend,
      orderCount: customer.orderCount,
      avgOrderValue: customer.avgOrderValue,
      firstOrderAt: customer.firstOrderAt,
      lastOrderAt: customer.lastOrderAt,
    };
    const next = applyOrderToAggregates(prev, { amount: input.amount, placedAt });

    await tx.customer.update({
      where: { id: customer.id },
      data: {
        totalSpend: next.totalSpend,
        orderCount: next.orderCount,
        avgOrderValue: next.avgOrderValue,
        firstOrderAt: next.firstOrderAt,
        lastOrderAt: next.lastOrderAt,
      },
    });

    return order;
  });
}

async function resolveCustomer(
  tx: Prisma.TransactionClient,
  input: OrderInput,
): Promise<{
  id: string;
  totalSpend: number;
  orderCount: number;
  avgOrderValue: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
}> {
  const select = {
    id: true,
    totalSpend: true,
    orderCount: true,
    avgOrderValue: true,
    firstOrderAt: true,
    lastOrderAt: true,
  } as const;

  if (input.customerId) {
    const byId = await tx.customer.findUnique({ where: { id: input.customerId }, select });
    if (!byId) {
      throw notFound(`No customer with id ${input.customerId}`);
    }
    return byId;
  }

  if (input.externalId) {
    const byExternal = await tx.customer.findUnique({
      where: { externalId: input.externalId },
      select,
    });
    if (!byExternal) {
      throw notFound(`No customer with externalId ${input.externalId}`);
    }
    return byExternal;
  }

  // Unreachable: the zod schema guarantees one identifier is present.
  throw new ApiError(400, "bad_request", "Either customerId or externalId is required");
}
