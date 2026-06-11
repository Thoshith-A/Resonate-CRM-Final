import {
  COMPARATOR_LABELS,
  SEGMENT_FIELD_DEFS,
  type SegmentCondition,
  type SegmentNode,
} from "@resonate/shared";
import { formatRupees } from "./format";

function valueText(condition: SegmentCondition): string {
  const def = SEGMENT_FIELD_DEFS.find((d) => d.field === condition.field);
  if (def?.kind === "money") {
    return formatRupees(Number(condition.value));
  }
  if (def?.kind === "days") {
    return `${condition.value} days`;
  }
  if (Array.isArray(condition.value)) {
    return condition.value.join(", ");
  }
  return String(condition.value);
}

function describeCondition(condition: SegmentCondition): string {
  const def = SEGMENT_FIELD_DEFS.find((d) => d.field === condition.field);
  return `${def?.label ?? condition.field} ${COMPARATOR_LABELS[condition.cmp]} ${valueText(condition)}`;
}

/** Human-readable one-liner for a rule tree (list cards + builder header). */
export function describeRules(node: SegmentNode): string {
  if (!("op" in node)) {
    return describeCondition(node);
  }
  const parts = node.children.map((child) =>
    "op" in child ? `(${describeRules(child)})` : describeRules(child),
  );
  return parts.join(` ${node.op} `);
}
