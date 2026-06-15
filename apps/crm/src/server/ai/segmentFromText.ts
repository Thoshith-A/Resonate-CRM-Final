import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import {
  COMPARATOR_LABELS,
  SEGMENT_COMPARATORS,
  SEGMENT_FIELDS,
  SEGMENT_FIELD_DEFS,
  SegmentRulesSchema,
  type SegmentRules,
} from "@resonate/shared";
import { getAiModel } from "./provider";

export type AiSegmentResult = {
  rules: SegmentRules | null;
  explanation: string;
  suggestedName: string;
};

/**
 * AI output schema. A condition is a single flat object (so the JSON schema
 * sent to the model stays simple across providers); groups nest up to depth
 * 3 without recursion. The model's output is then re-validated against the
 * canonical SegmentRulesSchema — the single source of truth — which enforces
 * the strict per-field comparator/value rules. `rules` is nullable so the
 * model can decline an unmappable request gracefully.
 */
const AiConditionSchema = z.object({
  field: z.enum(SEGMENT_FIELDS),
  cmp: z.enum(SEGMENT_COMPARATORS),
  value: z.union([z.number(), z.string(), z.array(z.string())]),
});
const group = <T extends z.ZodTypeAny>(child: T) =>
  z.object({ op: z.enum(["AND", "OR"]), children: z.array(child).min(1) });
const depth3 = group(AiConditionSchema);
const depth2 = group(z.union([AiConditionSchema, depth3]));
const depth1 = group(z.union([AiConditionSchema, depth2]));
const AiRulesSchema = z.union([AiConditionSchema, depth1]);

const AiOutputSchema = z.object({
  rules: AiRulesSchema.nullable(),
  explanation: z.string().max(500),
  suggestedName: z.string().max(80),
});

function fieldReference(): string {
  return SEGMENT_FIELD_DEFS.map((def) => {
    const cmps = def.comparators.map((c) => `${c} (${COMPARATOR_LABELS[c]})`).join(", ");
    const valueHint =
      def.kind === "money"
        ? "value: integer PAISE (₹1 = 100 paise; ₹5,000 → 500000)"
        : def.kind === "days"
          ? "value: integer number of days"
          : def.kind === "count"
            ? "value: integer count"
            : def.kind === "city"
              ? "value: a city string, or an array of strings for `in`"
              : "value: a single tag string";
    return `- ${def.field} — ${def.label}; comparators: ${cmps}; ${valueHint}`;
  }).join("\n");
}

const SYSTEM_PROMPT = `You translate a marketer's plain-English audience description into a structured segment rule tree for an Indian D2C coffee brand (Brewline).

Output a JSON object: { "rules": <rule tree | null>, "explanation": string, "suggestedName": string }.

A rule tree is either a single condition { "field", "cmp", "value" } or a group { "op": "AND" | "OR", "children": [...] }. Groups may nest up to 3 levels deep.

ONLY these fields and comparators are allowed:
${fieldReference()}

Hard rules:
- Use ONLY the fields above. Never invent a field. Money values are integer paise (multiply rupees by 100).
- "haven't ordered in N days" / "lapsed N days" → last_order_days_ago gt N. "ordered in the last N days" → last_order_days_ago lt N.
- "never ordered" → order_count eq 0. Multiple cities → city in [..]. A tag → tags contains "tag".
- If the request mentions something that maps to NO allowed field (e.g. music taste, gender, favourite product they didn't buy), and nothing else is mappable, return "rules": null and explain what IS available. If only PART is unmappable, build rules from the mappable part and note the dropped part in the explanation.
- explanation: one or two sentences, plain English. suggestedName: a short title (≤ 6 words).

Examples:

Input: "people in Mumbai or Delhi who spent over ₹5,000 but haven't ordered in 90 days"
Output: { "rules": { "op": "AND", "children": [ { "field": "city", "cmp": "in", "value": ["Mumbai", "Delhi"] }, { "field": "total_spend", "cmp": "gt", "value": 500000 }, { "field": "last_order_days_ago", "cmp": "gt", "value": 90 } ] }, "explanation": "High-spending customers in Mumbai or Delhi who have gone quiet for over 90 days.", "suggestedName": "Lapsed metro VIPs" }

Input: "subscribers who have never placed an order"
Output: { "rules": { "op": "AND", "children": [ { "field": "tags", "cmp": "contains", "value": "subscriber" }, { "field": "order_count", "cmp": "eq", "value": 0 } ] }, "explanation": "Subscribers with zero orders so far.", "suggestedName": "Subscribers, no orders" }

Input: "customers who love jazz"
Output: { "rules": null, "explanation": "There's no attribute for music taste. You can segment by total spend, order count, average order value, days since last order, days since signup, city, or tags.", "suggestedName": "" }`;

async function attempt(model: LanguageModel, prompt: string): Promise<AiSegmentResult> {
  const { object } = await generateObject({
    model,
    schema: AiOutputSchema,
    system: SYSTEM_PROMPT,
    prompt,
  });

  if (object.rules === null) {
    return { rules: null, explanation: object.explanation, suggestedName: object.suggestedName };
  }
  // Canonical validation — the one validator the whole app trusts.
  const parsed = SegmentRulesSchema.safeParse(object.rules);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }
  return { rules: parsed.data, explanation: object.explanation, suggestedName: object.suggestedName };
}

// ── Deterministic fallback parser ──────────────────────────────────────────
// When the model is unavailable (e.g. provider outage / depleted credits), we
// still turn the common audience phrasings into real rules in pure code, so the
// builder keeps working. Output is validated by the same SegmentRulesSchema, so
// it can never produce an invalid or hallucinated field.

const KNOWN_CITIES = [
  "Mumbai", "Delhi", "Bangalore", "Bengaluru", "Pune", "Hyderabad",
  "Chennai", "Kolkata", "Ahmedabad", "Jaipur", "Surat", "Lucknow",
];

/** Parse a rupee amount ("₹5,000", "5000", "5k", "1 lakh") to integer paise. */
function rupeesToPaise(text: string): number | null {
  const m = text.match(/(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|cr|crores?)?/i);
  if (!m?.[1]) return null;
  let n = parseFloat(m[1].replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand") n *= 1_000;
  else if (unit.startsWith("lakh")) n *= 100_000;
  else if (unit.startsWith("cr")) n *= 10_000_000;
  return Math.round(n * 100);
}

function firstDays(text: string): number | null {
  const m = text.match(/(\d+)\s*\+?\s*days?/);
  return m?.[1] ? parseInt(m[1], 10) : null;
}

/** Rule-based NL→segment for the common phrasings (used only when AI is down). */
function parseSegmentLocally(text: string): AiSegmentResult | null {
  const t = ` ${text.toLowerCase()} `;
  const children: Array<Record<string, unknown>> = [];
  const labels: string[] = [];

  const cities = KNOWN_CITIES.filter((c) => t.includes(c.toLowerCase()));
  if (cities.length === 1) {
    children.push({ field: "city", cmp: "eq", value: cities[0] });
    labels.push(cities[0]!);
  } else if (cities.length > 1) {
    children.push({ field: "city", cmp: "in", value: cities });
    labels.push(cities.join("/"));
  }

  if (/spen[dt]|high.?spender|big.?spender|vip|premium|valuable|whales?/.test(t)) {
    const cmp = /under|less than|below|fewer|low.?spender/.test(t) ? "lt" : "gt";
    children.push({ field: "total_spend", cmp, value: rupeesToPaise(t) ?? 500_000 });
    labels.push(cmp === "lt" ? "low spend" : "high spenders");
  }

  if (/never ordered|no orders|zero orders|haven'?t (placed|bought|ordered yet)|new sign|just signed/.test(t)) {
    children.push({ field: "order_count", cmp: "eq", value: 0 });
    labels.push("no orders");
  } else if (/repeat|loyal|frequent|regular|multiple orders/.test(t)) {
    children.push({ field: "order_count", cmp: "gt", value: 1 });
    labels.push("repeat buyers");
  } else {
    const m = t.match(/more than (\d+)\s*orders?/);
    if (m?.[1]) {
      children.push({ field: "order_count", cmp: "gt", value: parseInt(m[1], 10) });
      labels.push(`${m[1]}+ orders`);
    }
  }

  if (/haven'?t ordered|not ordered|hasn'?t ordered|lapsed|gone quiet|quiet|dormant|inactive|churn|win.?back|miss(ed|ing)?|comeback/.test(t)) {
    children.push({ field: "last_order_days_ago", cmp: "gt", value: firstDays(t) ?? 90 });
    labels.push("lapsed");
  } else if (/ordered (in )?(the )?last|recent|active recently/.test(t)) {
    children.push({ field: "last_order_days_ago", cmp: "lt", value: firstDays(t) ?? 30 });
    labels.push("recently active");
  }

  for (const tag of ["subscriber", "wholesale"]) {
    if (t.includes(tag)) {
      children.push({ field: "tags", cmp: "contains", value: tag });
      labels.push(`${tag}s`);
    }
  }

  if (children.length === 0) return null;
  const candidate = children.length === 1 ? children[0] : { op: "AND", children };
  const parsed = SegmentRulesSchema.safeParse(candidate);
  if (!parsed.success) return null;

  const name = labels
    .slice(0, 3)
    .join(" · ")
    .replace(/(^| )(\w)/g, (s) => s.toUpperCase());
  return {
    rules: parsed.data,
    explanation: `Matched on ${labels.join(", ")}. Refine any condition in the builder below.`,
    suggestedName: name.slice(0, 60),
  };
}

/**
 * NL → segment. One AI attempt, then one retry with the validation error
 * appended; if the model is unavailable, a deterministic parser handles the
 * common phrasings; only a truly unmappable request returns rules: null. Never
 * throws to the route for a model/validation problem.
 */
export async function segmentFromText(userPrompt: string): Promise<AiSegmentResult> {
  // Resolve the provider first; a missing key surfaces as a 503, not a
  // "couldn't map" fallback.
  const model = getAiModel();
  try {
    return await attempt(model, userPrompt);
  } catch (firstError) {
    const reason = firstError instanceof Error ? firstError.message : String(firstError);
    try {
      return await attempt(
        model,
        `${userPrompt}\n\nYour previous attempt produced invalid rules (${reason}). Use only the allowed fields and value types, or return rules: null.`,
      );
    } catch (secondError) {
      // AI failures degrade — first try the deterministic parser, then a hint.
      console.error("[ai] segment-from-text failed:", secondError instanceof Error ? secondError.message : secondError);
      const local = parseSegmentLocally(userPrompt);
      if (local) return local;
      return {
        rules: null,
        explanation:
          "I couldn't turn that into segment rules. Try describing spend, orders, average order value, recency, signup date, city, or tags.",
        suggestedName: "",
      };
    }
  }
}
