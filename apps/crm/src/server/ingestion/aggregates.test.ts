import { describe, expect, it } from "vitest";
import {
  EMPTY_AGGREGATES,
  aggregateOrders,
  applyOrderToAggregates,
} from "./aggregates";

const d = (iso: string) => new Date(iso);

describe("applyOrderToAggregates", () => {
  it("sets first/last and avg from the first order", () => {
    const result = applyOrderToAggregates(EMPTY_AGGREGATES, {
      amount: 50000,
      placedAt: d("2025-01-10T00:00:00.000Z"),
    });
    expect(result.totalSpend).toBe(50000);
    expect(result.orderCount).toBe(1);
    expect(result.avgOrderValue).toBe(50000);
    expect(result.firstOrderAt).toEqual(d("2025-01-10T00:00:00.000Z"));
    expect(result.lastOrderAt).toEqual(d("2025-01-10T00:00:00.000Z"));
  });

  it("accumulates spend and rounds the average", () => {
    const orders = [
      { amount: 30000, placedAt: d("2025-01-01T00:00:00.000Z") },
      { amount: 30000, placedAt: d("2025-02-01T00:00:00.000Z") },
      { amount: 30001, placedAt: d("2025-03-01T00:00:00.000Z") },
    ];
    const result = aggregateOrders(orders);
    expect(result.totalSpend).toBe(90001);
    expect(result.orderCount).toBe(3);
    expect(result.avgOrderValue).toBe(30000); // 90001/3 = 30000.33 -> 30000
  });

  it("moves firstOrderAt back when an earlier order arrives out of order", () => {
    const afterRecent = applyOrderToAggregates(EMPTY_AGGREGATES, {
      amount: 10000,
      placedAt: d("2025-06-01T00:00:00.000Z"),
    });
    const afterEarlier = applyOrderToAggregates(afterRecent, {
      amount: 10000,
      placedAt: d("2025-01-01T00:00:00.000Z"),
    });
    expect(afterEarlier.firstOrderAt).toEqual(d("2025-01-01T00:00:00.000Z"));
    expect(afterEarlier.lastOrderAt).toEqual(d("2025-06-01T00:00:00.000Z"));
  });

  it("advances lastOrderAt for a newer order", () => {
    const a = applyOrderToAggregates(EMPTY_AGGREGATES, {
      amount: 10000,
      placedAt: d("2025-01-01T00:00:00.000Z"),
    });
    const b = applyOrderToAggregates(a, {
      amount: 10000,
      placedAt: d("2025-12-31T00:00:00.000Z"),
    });
    expect(b.firstOrderAt).toEqual(d("2025-01-01T00:00:00.000Z"));
    expect(b.lastOrderAt).toEqual(d("2025-12-31T00:00:00.000Z"));
  });
});
