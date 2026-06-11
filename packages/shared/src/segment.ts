import { z } from "zod";

/**
 * Segment rule AST — the single source of truth validated by the API, the
 * visual builder, and (Phase 3) the AI. Only whitelisted fields and
 * comparators are representable, so a hallucinated field is structurally
 * impossible: zod rejects it before it ever reaches the compiler.
 *
 * Money fields (total_spend, avg_order_value) are integer paise. The
 * *_days_ago fields are relative to "now" and compile to date comparisons.
 */

export const SEGMENT_NUMERIC_FIELDS = [
  "total_spend",
  "order_count",
  "avg_order_value",
  "last_order_days_ago",
  "created_days_ago",
] as const;

export const SEGMENT_FIELDS = [...SEGMENT_NUMERIC_FIELDS, "city", "tags"] as const;
export type SegmentField = (typeof SEGMENT_FIELDS)[number];

export const SEGMENT_COMPARATORS = [
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "neq",
  "in",
  "contains",
] as const;
export type SegmentComparator = (typeof SEGMENT_COMPARATORS)[number];

export const MAX_SEGMENT_DEPTH = 3;

const NumericComparatorSchema = z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]);

const NumericConditionSchema = z.object({
  field: z.enum(SEGMENT_NUMERIC_FIELDS),
  cmp: NumericComparatorSchema,
  value: z.number().int().nonnegative(),
});

const CityConditionSchema = z
  .object({
    field: z.literal("city"),
    cmp: z.enum(["eq", "neq", "in"]),
    value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  })
  .superRefine((condition, ctx) => {
    const isArray = Array.isArray(condition.value);
    if (condition.cmp === "in" && !isArray) {
      ctx.addIssue({ code: "custom", message: "city 'in' requires an array of cities" });
    }
    if (condition.cmp !== "in" && isArray) {
      ctx.addIssue({ code: "custom", message: "city eq/neq require a single city" });
    }
  });

const TagsConditionSchema = z.object({
  field: z.literal("tags"),
  cmp: z.literal("contains"),
  value: z.string().min(1),
});

export const SegmentConditionSchema = z.union([
  NumericConditionSchema,
  CityConditionSchema,
  TagsConditionSchema,
]);
export type SegmentCondition = z.infer<typeof SegmentConditionSchema>;

export type SegmentGroup = { op: "AND" | "OR"; children: SegmentNode[] };
export type SegmentNode = SegmentCondition | SegmentGroup;

export const SegmentGroupSchema: z.ZodType<SegmentGroup> = z.lazy(() =>
  z.object({
    op: z.enum(["AND", "OR"]),
    children: z
      .array(SegmentNodeSchema)
      .min(1, "A group must contain at least one condition"),
  }),
);

export const SegmentNodeSchema: z.ZodType<SegmentNode> = z.lazy(() =>
  z.union([SegmentConditionSchema, SegmentGroupSchema]),
);

/** Deepest group nesting along any path (a bare condition is depth 0). */
export function segmentGroupDepth(node: SegmentNode): number {
  if (!("op" in node)) {
    return 0;
  }
  return 1 + node.children.reduce((max, child) => Math.max(max, segmentGroupDepth(child)), 0);
}

/** Root rules: a condition or group, with the depth cap enforced once. */
export const SegmentRulesSchema = SegmentNodeSchema.superRefine((node, ctx) => {
  if (segmentGroupDepth(node) > MAX_SEGMENT_DEPTH) {
    ctx.addIssue({
      code: "custom",
      message: `Maximum nesting depth is ${MAX_SEGMENT_DEPTH}`,
    });
  }
});
export type SegmentRules = z.infer<typeof SegmentRulesSchema>;

// ── UI / AI metadata ─────────────────────────────────────────────────────

export type SegmentFieldKind = "money" | "count" | "days" | "city" | "tags";

export type SegmentFieldDef = {
  field: SegmentField;
  label: string;
  kind: SegmentFieldKind;
  comparators: readonly SegmentComparator[];
};

const NUMERIC_CMPS = ["gt", "gte", "lt", "lte", "eq", "neq"] as const;

export const SEGMENT_FIELD_DEFS: readonly SegmentFieldDef[] = [
  { field: "total_spend", label: "Total spend", kind: "money", comparators: NUMERIC_CMPS },
  { field: "order_count", label: "Order count", kind: "count", comparators: NUMERIC_CMPS },
  { field: "avg_order_value", label: "Avg order value", kind: "money", comparators: NUMERIC_CMPS },
  { field: "last_order_days_ago", label: "Days since last order", kind: "days", comparators: NUMERIC_CMPS },
  { field: "created_days_ago", label: "Days since signup", kind: "days", comparators: NUMERIC_CMPS },
  { field: "city", label: "City", kind: "city", comparators: ["eq", "neq", "in"] },
  { field: "tags", label: "Tag", kind: "tags", comparators: ["contains"] },
];

export const COMPARATOR_LABELS: Record<SegmentComparator, string> = {
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  eq: "equals",
  neq: "is not",
  in: "is any of",
  contains: "includes",
};
