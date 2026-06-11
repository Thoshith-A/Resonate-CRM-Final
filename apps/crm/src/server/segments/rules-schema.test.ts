import { describe, expect, it } from "vitest";
import { SegmentRulesSchema } from "@resonate/shared";

describe("SegmentRulesSchema — accepts valid rules", () => {
  it("accepts a depth-3 nested tree", () => {
    const ok = SegmentRulesSchema.safeParse({
      op: "AND",
      children: [
        { field: "city", cmp: "in", value: ["Mumbai", "Delhi"] },
        {
          op: "OR",
          children: [
            { field: "total_spend", cmp: "gt", value: 500000 },
            { op: "AND", children: [{ field: "tags", cmp: "contains", value: "subscriber" }] },
          ],
        },
      ],
    });
    expect(ok.success).toBe(true);
  });
});

describe("SegmentRulesSchema — rejects invalid rules", () => {
  it("rejects an unknown (hallucinated) field", () => {
    const result = SegmentRulesSchema.safeParse({
      field: "loves_jazz",
      cmp: "eq",
      value: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty group", () => {
    const result = SegmentRulesSchema.safeParse({ op: "AND", children: [] });
    expect(result.success).toBe(false);
  });

  it("rejects nesting deeper than 3", () => {
    const result = SegmentRulesSchema.safeParse({
      op: "AND",
      children: [
        {
          op: "OR",
          children: [
            {
              op: "AND",
              children: [
                {
                  op: "OR",
                  children: [{ field: "order_count", cmp: "eq", value: 0 }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an illegal comparator for a field (tags must use contains)", () => {
    const result = SegmentRulesSchema.safeParse({ field: "tags", cmp: "eq", value: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects city 'in' with a non-array value", () => {
    const result = SegmentRulesSchema.safeParse({ field: "city", cmp: "in", value: "Mumbai" });
    expect(result.success).toBe(false);
  });
});
