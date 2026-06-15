import { generateObject, type LanguageModel } from "ai";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  CHANNEL_CTR,
  ChannelRoutingDecisionSchema,
  RoutePreviewResponseSchema,
  type ChannelRoutingDecision,
  type RoutePreviewResponse,
  type SegmentRules,
} from "@resonate/shared";
import { prisma } from "../db";
import { notFound } from "../api";
import { compileRules } from "../segments/compile";
import { getAiModel } from "../ai/provider";

/**
 * AI Channel Router. Picks the best channel (WhatsApp / Email / SMS / RCS) for
 * EACH customer to maximise click-through. To avoid 1000+ API calls we batch
 * customers and make ONE generateObject call per batch, with bounded concurrency.
 */

export const ROUTE_BATCH_SIZE = 25;
export const ROUTE_CONCURRENCY = 3;
export const ROUTE_PREVIEW_SAMPLE = 50;

const TIER1_CITIES = new Set(["Mumbai", "Delhi", "Bangalore", "Pune", "Hyderabad", "Chennai"]);
const HIGH_SPEND_PAISE = 1_000_000; // ₹10,000

export type CustomerWithAggregates = {
  id: string;
  city: string;
  orderCount: number;
  /** Integer paise (converted to rupees before it reaches the model). */
  totalSpend: number;
  tags: string[];
};

export type ChannelRoutingResult = ChannelRoutingDecision;

// Wrap the array in an object — a top-level array root trips Gemini's structured
// JSON-schema subset (same lesson as the segment AST in Phase 3).
const BatchSchema = z.object({ decisions: z.array(ChannelRoutingDecisionSchema) });

const benchmarkLine = (Object.keys(CHANNEL_CTR) as Array<keyof typeof CHANNEL_CTR>)
  .map((c) => `${c} ${CHANNEL_CTR[c]}%`)
  .join(", ");

const SYSTEM_PROMPT = `You are the channel router for Brewline, an Indian specialty-coffee D2C brand. For EACH customer, choose the single channel most likely to earn a click.

Baseline click-through benchmarks (use as the default, then adjust with the signals below): ${benchmarkLine}.

Signals that OVERRIDE the benchmark, in PRIORITY ORDER (earlier wins ties):
1. City tier — tier-1 cities (Mumbai, Delhi, Bangalore, Pune, Hyderabad, Chennai) have high smartphone penetration → prefer WHATSAPP or RCS over SMS.
2. Cold customer (orderCount = 0) → EMAIL (low friction, no opt-in needed).
3. High spender (totalSpend > ₹10,000) → RCS (rich cards, premium feel).
4. tags include "wholesale" → EMAIL (B2B pattern).
5. tags include "subscriber" → WHATSAPP (recurring, high-engagement relationship).
6. Otherwise → WHATSAPP if the city is tier-1, else SMS.

For every customer return: customerId (echo exactly), channel (WHATSAPP|SMS|EMAIL|RCS), reason (ONE short sentence citing the deciding signal), confidence (0–1). Return a decision for every customer in the input.`;

/**
 * Minimal fixed-N concurrency limiter. Hand-rolled instead of installing
 * `p-limit` to keep the dependency footprint at zero (SPEC §12 — no new
 * packages); we only need simple bounded fan-out over a known list.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function fallbackDecision(customerId: string): ChannelRoutingResult {
  return { customerId, channel: "WHATSAPP", reason: "routing_fallback", confidence: 0.2 };
}

async function routeBatch(
  model: LanguageModel,
  batch: CustomerWithAggregates[],
): Promise<ChannelRoutingResult[]> {
  try {
    const { object } = await generateObject({
      model,
      schema: BatchSchema,
      system: SYSTEM_PROMPT,
      // Only the signal fields — never PII (no name/email/phone). Spend in rupees.
      prompt: JSON.stringify(
        batch.map((c) => ({
          id: c.id,
          city: c.city,
          tier1: TIER1_CITIES.has(c.city),
          orderCount: c.orderCount,
          spendRupees: Math.round(c.totalSpend / 100),
          highSpender: c.totalSpend > HIGH_SPEND_PAISE,
          tags: c.tags,
        })),
      ),
    });
    // The model may miss or duplicate ids — map by id and fall back per gap.
    const byId = new Map(object.decisions.map((d) => [d.customerId, d]));
    return batch.map((c) => byId.get(c.id) ?? fallbackDecision(c.id));
  } catch (error) {
    console.error(
      "[ai] route-channel batch failed:",
      error instanceof Error ? error.message : error,
    );
    return batch.map((c) => fallbackDecision(c.id));
  }
}

/**
 * Route a whole audience. Batches of {@link ROUTE_BATCH_SIZE}, fanned out at
 * {@link ROUTE_CONCURRENCY}. A failed batch degrades to WHATSAPP for its
 * members (reason "routing_fallback") — a routing hiccup never blocks a send.
 */
export async function routeChannels(
  customers: CustomerWithAggregates[],
): Promise<ChannelRoutingResult[]> {
  if (customers.length === 0) return [];
  const model = getAiModel(); // throws ApiError(503) if no provider key
  const batches = chunk(customers, ROUTE_BATCH_SIZE);
  const perBatch = await runWithConcurrency(batches, ROUTE_CONCURRENCY, (batch) =>
    routeBatch(model, batch),
  );
  return perBatch.flat();
}

/**
 * Deterministic, LLM-free channel routing — applies the SAME priority rules the
 * AI router is instructed to follow (see SYSTEM_PROMPT), in pure code. Used by
 * the SEND path so a full-audience send completes well inside the serverless
 * function budget (Vercel Hobby = 60s) regardless of audience size or AI billing
 * state — routing a 900+ audience via the LLM is ~38 sequential calls and blows
 * the limit. The AI router still powers the (sampled, cached) routing PREVIEW in
 * the campaign builder, which is where its nuance is showcased.
 */
export function routeChannelsRuleBased(
  customers: CustomerWithAggregates[],
): ChannelRoutingResult[] {
  return customers.map((c) => {
    const tier1 = TIER1_CITIES.has(c.city);
    const tags = c.tags ?? [];
    // Priority order matches the AI router's prompt (earlier wins ties).
    if (c.orderCount === 0)
      return { customerId: c.id, channel: "EMAIL", reason: "Cold customer (no orders) — email is low-friction.", confidence: 0.7 };
    if (c.totalSpend > HIGH_SPEND_PAISE)
      return { customerId: c.id, channel: "RCS", reason: "High spender — RCS rich cards for a premium feel.", confidence: 0.8 };
    if (tags.includes("wholesale"))
      return { customerId: c.id, channel: "EMAIL", reason: "Wholesale account — email fits the B2B pattern.", confidence: 0.75 };
    if (tags.includes("subscriber"))
      return { customerId: c.id, channel: "WHATSAPP", reason: "Subscriber — WhatsApp suits the recurring relationship.", confidence: 0.8 };
    if (tier1)
      return { customerId: c.id, channel: "WHATSAPP", reason: "Tier-1 city — high smartphone penetration favours WhatsApp.", confidence: 0.7 };
    return { customerId: c.id, channel: "SMS", reason: "Non-tier-1 — SMS for the widest reliable reach.", confidence: 0.6 };
  });
}

function tallyDistribution(decisions: ChannelRoutingResult[]): {
  whatsapp: number;
  sms: number;
  email: number;
  rcs: number;
} {
  const dist = { whatsapp: 0, sms: 0, email: 0, rcs: 0 };
  for (const d of decisions) {
    if (d.channel === "WHATSAPP") dist.whatsapp += 1;
    else if (d.channel === "SMS") dist.sms += 1;
    else if (d.channel === "EMAIL") dist.email += 1;
    else if (d.channel === "RCS") dist.rcs += 1;
  }
  return dist;
}

/**
 * Preview the routing for a segment WITHOUT sending: route a sample (≤ 50) of
 * the audience and summarise the distribution + a blended CTR estimate using the
 * shared benchmarks. Powers the "Routing preview" card in the campaign builder.
 *
 * The result is cached on the segment (`Segment.routePreview`) so repeat visits
 * render instantly instead of re-running the router's LLM calls. Pass
 * `{ refresh: true }` to recompute and overwrite the cache.
 */
export async function previewRouting(
  segmentId: string,
  options?: { refresh?: boolean },
): Promise<RoutePreviewResponse> {
  const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
  if (!segment) {
    throw notFound(`No segment with id ${segmentId}`);
  }

  // Instant path: serve the cached preview unless a refresh was requested.
  if (!options?.refresh && segment.routePreview != null) {
    const cached = RoutePreviewResponseSchema.safeParse(segment.routePreview);
    if (cached.success) {
      return cached.data;
    }
  }

  const where = compileRules(segment.rules as unknown as SegmentRules);
  // Natural DB order (not by spend) keeps the sample representative of the whole
  // segment, so the preview distribution mirrors what the full send will produce.
  const sample = await prisma.customer.findMany({
    where,
    take: ROUTE_PREVIEW_SAMPLE,
    select: { id: true, city: true, orderCount: true, totalSpend: true, tags: true },
  });

  const decisions = await routeChannels(sample);
  const distribution = tallyDistribution(decisions);
  const total = decisions.length || 1;
  const blended =
    (distribution.whatsapp * CHANNEL_CTR.WHATSAPP +
      distribution.sms * CHANNEL_CTR.SMS +
      distribution.email * CHANNEL_CTR.EMAIL +
      distribution.rcs * CHANNEL_CTR.RCS) /
    total;

  const result: RoutePreviewResponse = {
    distribution,
    sampleReasons: decisions
      .slice(0, 5)
      .map((d) => ({ customerId: d.customerId, channel: d.channel, reason: d.reason })),
    estimatedBlendedCtr: Math.round(blended * 10) / 10,
  };

  // Persist for instant subsequent loads. Best-effort: a cache write failure
  // must never fail the preview itself.
  await prisma.segment
    .update({
      where: { id: segmentId },
      data: { routePreview: result as unknown as Prisma.InputJsonValue },
    })
    .catch(() => {});

  return result;
}
