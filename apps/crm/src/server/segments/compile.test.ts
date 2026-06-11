import { describe, expect, it } from "vitest";
import type { SegmentRules } from "@resonate/shared";
import { compileRules } from "./compile";

const NOW = new Date("2026-06-11T00:00:00.000Z");
const DAY = 86_400_000;

describe("compileRules — numeric comparators", () => {
  const cases: [string, "gt" | "gte" | "lt" | "lte" | "eq" | "neq", object][] = [
    ["gt", "gt", { gt: 500000 }],
    ["gte", "gte", { gte: 500000 }],
    ["lt", "lt", { lt: 500000 }],
    ["lte", "lte", { lte: 500000 }],
    ["eq", "eq", { equals: 500000 }],
    ["neq", "neq", { not: 500000 }],
  ];
  for (const [name, cmp, expected] of cases) {
    it(`total_spend ${name}`, () => {
      const rules: SegmentRules = { field: "total_spend", cmp, value: 500000 };
      expect(compileRules(rules, NOW)).toEqual({ totalSpend: expected });
    });
  }

  it("maps order_count and avg_order_value to their columns", () => {
    expect(compileRules({ field: "order_count", cmp: "eq", value: 0 }, NOW)).toEqual({
      orderCount: { equals: 0 },
    });
    expect(compileRules({ field: "avg_order_value", cmp: "gte", value: 120000 }, NOW)).toEqual({
      avgOrderValue: { gte: 120000 },
    });
  });
});

describe("compileRules — date-relative fields invert the comparison", () => {
  it("last_order_days_ago gt 90 → lastOrderAt before (now - 90d)", () => {
    const rules: SegmentRules = { field: "last_order_days_ago", cmp: "gt", value: 90 };
    expect(compileRules(rules, NOW)).toEqual({
      lastOrderAt: { lt: new Date(NOW.getTime() - 90 * DAY) },
    });
  });

  it("last_order_days_ago lt 30 → lastOrderAt after (now - 30d)", () => {
    const rules: SegmentRules = { field: "last_order_days_ago", cmp: "lt", value: 30 };
    expect(compileRules(rules, NOW)).toEqual({
      lastOrderAt: { gt: new Date(NOW.getTime() - 30 * DAY) },
    });
  });

  it("created_days_ago eq 7 → createdAt within the 24h window 7 days ago", () => {
    const rules: SegmentRules = { field: "created_days_ago", cmp: "eq", value: 7 };
    expect(compileRules(rules, NOW)).toEqual({
      createdAt: {
        gt: new Date(NOW.getTime() - 8 * DAY),
        lte: new Date(NOW.getTime() - 7 * DAY),
      },
    });
  });
});

describe("compileRules — city and tags", () => {
  it("city eq", () => {
    expect(compileRules({ field: "city", cmp: "eq", value: "Mumbai" }, NOW)).toEqual({
      city: "Mumbai",
    });
  });
  it("city neq", () => {
    expect(compileRules({ field: "city", cmp: "neq", value: "Delhi" }, NOW)).toEqual({
      city: { not: "Delhi" },
    });
  });
  it("city in", () => {
    expect(
      compileRules({ field: "city", cmp: "in", value: ["Mumbai", "Delhi"] }, NOW),
    ).toEqual({ city: { in: ["Mumbai", "Delhi"] } });
  });
  it("tags contains → array has", () => {
    expect(compileRules({ field: "tags", cmp: "contains", value: "subscriber" }, NOW)).toEqual({
      tags: { has: "subscriber" },
    });
  });
});

describe("compileRules — nested groups", () => {
  it('compiles the "high spenders gone quiet" tree (AND with nested OR)', () => {
    const rules: SegmentRules = {
      op: "AND",
      children: [
        { field: "total_spend", cmp: "gt", value: 500000 },
        {
          op: "OR",
          children: [
            { field: "last_order_days_ago", cmp: "gt", value: 90 },
            { field: "order_count", cmp: "eq", value: 0 },
          ],
        },
      ],
    };
    expect(compileRules(rules, NOW)).toEqual({
      AND: [
        { totalSpend: { gt: 500000 } },
        {
          OR: [
            { lastOrderAt: { lt: new Date(NOW.getTime() - 90 * DAY) } },
            { orderCount: { equals: 0 } },
          ],
        },
      ],
    });
  });
});
