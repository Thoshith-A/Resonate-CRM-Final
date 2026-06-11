/**
 * Denormalized customer aggregates, maintained on every order ingest. Pure
 * and side-effect-free so it can be unit-tested and reused by both the
 * ingest transaction and the seed script. Money is integer paise.
 */

export type CustomerAggregates = {
  totalSpend: number;
  orderCount: number;
  avgOrderValue: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
};

export type OrderFacts = {
  amount: number;
  placedAt: Date;
};

export const EMPTY_AGGREGATES: CustomerAggregates = {
  totalSpend: 0,
  orderCount: 0,
  avgOrderValue: 0,
  firstOrderAt: null,
  lastOrderAt: null,
};

/**
 * Fold a single order into existing aggregates. Order-independent: a late
 * order with an earlier `placedAt` still moves `firstOrderAt` back, so
 * out-of-order ingestion is correct.
 */
export function applyOrderToAggregates(
  prev: CustomerAggregates,
  order: OrderFacts,
): CustomerAggregates {
  const totalSpend = prev.totalSpend + order.amount;
  const orderCount = prev.orderCount + 1;
  return {
    totalSpend,
    orderCount,
    avgOrderValue: Math.round(totalSpend / orderCount),
    firstOrderAt:
      prev.firstOrderAt && prev.firstOrderAt <= order.placedAt
        ? prev.firstOrderAt
        : order.placedAt,
    lastOrderAt:
      prev.lastOrderAt && prev.lastOrderAt >= order.placedAt
        ? prev.lastOrderAt
        : order.placedAt,
  };
}

/** Aggregate a full set of orders from scratch (used by the seed). */
export function aggregateOrders(orders: readonly OrderFacts[]): CustomerAggregates {
  return orders.reduce(applyOrderToAggregates, EMPTY_AGGREGATES);
}
