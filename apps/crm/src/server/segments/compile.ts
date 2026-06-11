import type { Prisma } from "@prisma/client";
import type {
  SegmentCondition,
  SegmentComparator,
  SegmentNode,
  SegmentRules,
} from "@resonate/shared";

/**
 * Compile a validated segment AST into a Prisma `where` clause. Pure and
 * total — `now` is injected so date-relative fields are deterministic and
 * unit-testable. Assumes the AST already passed `SegmentRulesSchema`
 * (the API validates at the boundary), so every branch is exhaustive.
 */
export function compileRules(
  rules: SegmentRules,
  now: Date = new Date(),
): Prisma.CustomerWhereInput {
  return compileNode(rules, now);
}

const DAY_MS = 86_400_000;

function compileNode(node: SegmentNode, now: Date): Prisma.CustomerWhereInput {
  if ("op" in node) {
    const children = node.children.map((child) => compileNode(child, now));
    return node.op === "AND" ? { AND: children } : { OR: children };
  }
  return compileCondition(node, now);
}

function compileCondition(
  condition: SegmentCondition,
  now: Date,
): Prisma.CustomerWhereInput {
  switch (condition.field) {
    case "total_spend":
      return { totalSpend: numericFilter(condition.cmp, condition.value) };
    case "order_count":
      return { orderCount: numericFilter(condition.cmp, condition.value) };
    case "avg_order_value":
      return { avgOrderValue: numericFilter(condition.cmp, condition.value) };
    case "last_order_days_ago":
      return daysAgoFilter("lastOrderAt", condition.cmp, condition.value, now);
    case "created_days_ago":
      return daysAgoFilter("createdAt", condition.cmp, condition.value, now);
    case "city":
      return cityFilter(condition);
    case "tags":
      return { tags: { has: condition.value } };
  }
}

function numericFilter(cmp: SegmentComparator, value: number): Prisma.IntFilter {
  switch (cmp) {
    case "gt":
      return { gt: value };
    case "gte":
      return { gte: value };
    case "lt":
      return { lt: value };
    case "lte":
      return { lte: value };
    case "eq":
      return { equals: value };
    case "neq":
      return { not: value };
    default:
      // `in`/`contains` are not valid for numeric fields (schema rejects them).
      throw new Error(`Unsupported numeric comparator: ${cmp}`);
  }
}

/**
 * `*_days_ago` inverts the comparison: a larger "days ago" means an older
 * date. `eq X` is the 24h window ending X days before now; `neq` is its
 * complement. NULL dates (e.g. a customer who never ordered) are excluded —
 * they have no "days ago" value to compare.
 */
function daysAgoFilter(
  column: "lastOrderAt" | "createdAt",
  cmp: SegmentComparator,
  days: number,
  now: Date,
): Prisma.CustomerWhereInput {
  const upper = new Date(now.getTime() - days * DAY_MS); // boundary for "X days ago"
  const lower = new Date(now.getTime() - (days + 1) * DAY_MS);

  switch (cmp) {
    case "gt":
      return { [column]: { lt: upper } };
    case "gte":
      return { [column]: { lte: upper } };
    case "lt":
      return { [column]: { gt: upper } };
    case "lte":
      return { [column]: { gte: upper } };
    case "eq":
      return { [column]: { gt: lower, lte: upper } };
    case "neq":
      return { OR: [{ [column]: { lte: lower } }, { [column]: { gt: upper } }] };
    default:
      throw new Error(`Unsupported days-ago comparator: ${cmp}`);
  }
}

function cityFilter(
  condition: Extract<SegmentCondition, { field: "city" }>,
): Prisma.CustomerWhereInput {
  if (condition.cmp === "in") {
    const cities = Array.isArray(condition.value) ? condition.value : [condition.value];
    return { city: { in: cities } };
  }
  const city = Array.isArray(condition.value) ? condition.value[0] : condition.value;
  return condition.cmp === "neq" ? { city: { not: city } } : { city };
}
