import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  SendBatchResponseSchema,
  demoDispatchDelayMs,
  type Channel,
  type SegmentRules,
  type SendBatchResponse,
  type SendWindowName,
} from "@resonate/shared";
import { signPayload } from "@resonate/shared/crypto";
import { prisma } from "../db";
import { getEnv } from "../env";
import { ApiError, badRequest, notFound } from "../api";
import { compileRules } from "../segments/compile";
import { renderForCustomer, type MergeCustomer } from "./template";
import { routeChannelsRuleBased, type CustomerWithAggregates } from "./routeChannel";
import { inferSendWindow } from "./inferSendWindows";

const BATCH_SIZE = 100;
const CONCURRENCY = 5;
// One /send drains the QUEUED outbox in waves until empty OR this budget is hit,
// then returns (still SENDING) so the serverless function never approaches its
// 60s maxDuration. The campaign page polls and re-invokes /send (see
// campaign-insights.tsx) to drain the rest — an in-band, resumable outbox.
const DRAIN_BUDGET_MS = 50_000;
// Wake a possibly-idle channel-sim (Render free dyno cold-starts ~30-60s) on the
// cheap /health endpoint BEFORE dispatching, so the batches that actually carry
// messages hit a warm server instead of eating the request budget on a cold one.
const WARMUP_BUDGET_MS = 25_000;

export type SendCampaignResult = {
  campaignId: string;
  status: string;
  audienceSize: number;
  sent: number;
  failed: number;
};

/** A message ready to hand to the channel-sim, rebuilt from a QUEUED log row. */
type DispatchItem = {
  clientRef: string; // CommunicationLog id
  customerId: string;
  channel: Channel; // per-row channel (== campaign.channel for SINGLE strategy)
  to: string;
  renderedMessage: string;
  // Send-Time Intelligence (null for INSTANT campaigns):
  scheduledFor: Date | null;
  peakWindow: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recipientAddress(channel: Channel, customer: { phone: string; email: string }): string {
  return channel === "EMAIL" ? customer.email : customer.phone;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/** Run async tasks with a bounded concurrency pool. */
async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index]!);
    }
  });
  await Promise.all(workers);
}

function pluralityChannel(dist: {
  whatsapp: number;
  sms: number;
  email: number;
  rcs: number;
}): Channel {
  const entries: Array<[Channel, number]> = [
    ["WHATSAPP", dist.whatsapp],
    ["RCS", dist.rcs],
    ["EMAIL", dist.email],
    ["SMS", dist.sms],
  ];
  return entries.reduce((best, current) => (current[1] > best[1] ? current : best))[0];
}

/**
 * Wake the channel-sim before dispatching. Render's free dyno spins down when
 * idle; the first request after that pays a long cold-start. Paying it here, on
 * the trivial /health endpoint, means the batches that carry real messages hit a
 * warm server. Bounded by WARMUP_BUDGET_MS and best-effort: if the sim never
 * answers in time we proceed anyway and the drain budget + resume cover it.
 */
async function warmChannelSim(simUrl: string): Promise<void> {
  const deadline = Date.now() + WARMUP_BUDGET_MS;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const remaining = deadline - Date.now();
    const timer = setTimeout(() => controller.abort(), Math.min(10_000, remaining));
    try {
      const res = await fetch(`${simUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return; // sim is awake
    } catch {
      clearTimeout(timer);
    }
    await sleep(1000);
  }
}

/** Live per-status counts → the SendCampaignResult contract. */
async function summarize(campaignId: string, status: string): Promise<SendCampaignResult> {
  const grouped = await prisma.communicationLog.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { _all: true },
  });
  const count = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const audienceSize = grouped.reduce((sum, g) => sum + g._count._all, 0);
  const failed = count("FAILED");
  const queued = count("QUEUED");
  // "sent" = everything that left the outbox and wasn't rejected (SENT and every
  // later funnel stage all imply a successful send).
  const sent = audienceSize - failed - queued;
  return { campaignId, status, audienceSize, sent, failed };
}

/**
 * Drain QUEUED rows for a campaign in concurrent waves, dispatching each to the
 * channel-sim, until the outbox is empty (returns true) or the time budget is
 * exhausted (returns false). Reading the outbox from the DB each wave — rather
 * than from an in-memory list — is what makes a send resumable: a request that
 * runs out of budget (or is killed) leaves the undispatched rows QUEUED, and the
 * next /send picks up exactly where it left off.
 */
async function drainQueued(campaignId: string, env: ReturnType<typeof getEnv>, startedAt: number): Promise<boolean> {
  while (true) {
    if (Date.now() - startedAt > DRAIN_BUDGET_MS) return false;
    const rows = await prisma.communicationLog.findMany({
      where: { campaignId, status: "QUEUED" },
      take: BATCH_SIZE * CONCURRENCY,
      select: {
        id: true,
        customerId: true,
        channel: true,
        renderedMessage: true,
        scheduledFor: true,
        windowConfidence: true,
        customer: { select: { phone: true, email: true } },
      },
    });
    if (rows.length === 0) return true;
    const items: DispatchItem[] = rows.map((row) => ({
      clientRef: row.id,
      customerId: row.customerId,
      channel: row.channel,
      to: recipientAddress(row.channel, row.customer),
      renderedMessage: row.renderedMessage,
      scheduledFor: row.scheduledFor,
      peakWindow: row.windowConfidence === "HIGH",
    }));
    const batches = chunk(items, BATCH_SIZE);
    await runPool(batches, CONCURRENCY, (batch) => dispatchBatch(campaignId, batch, env));
  }
}

/**
 * Send (or resume sending) a campaign. A DRAFT is first snapshotted into QUEUED
 * CommunicationLog rows (the outbox) with per-customer channel + send window;
 * then the outbox is drained to the channel-sim over signed HTTP in batches of
 * 100 (concurrency 5) with a per-batch idempotency key.
 *
 * The drain is BUDGETED and RESUMABLE: rather than dispatch the whole audience
 * in one request (which a large audience + a cold sim can push past the 60s
 * serverless limit → 504, killing the request mid-send), each call drains for at
 * most DRAIN_BUDGET_MS and returns. If rows remain QUEUED it stays SENDING and
 * the caller (campaign page) re-invokes /send to continue. A send therefore
 * always settles — never 504s — regardless of audience size or sim cold-start.
 *
 * Channel strategy: SINGLE uses campaign.channel for all; AI_ROUTED picks a
 * channel per customer (router), stores the distribution, and sets the campaign
 * channel to the plurality winner.
 *
 * Send strategy: INSTANT dispatches everything immediately; SMART_WINDOWS stamps
 * each row's scheduledFor so the always-on channel-sim staggers its lifecycle
 * across windows on its own timers.
 */
export async function sendCampaign(campaignId: string): Promise<SendCampaignResult> {
  const requestStart = Date.now();
  const env = getEnv();
  // Kick the sim awake immediately; awaited (capped) below, after the snapshot,
  // so the cold-start overlaps the DB work instead of adding to it.
  const warmup = warmChannelSim(env.CHANNEL_SIM_URL);

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { segment: true },
  });
  if (!campaign) {
    throw notFound(`No campaign with id ${campaignId}`);
  }
  // Already settled: a late resume poll is a harmless no-op.
  if (campaign.status === "COMPLETED" || campaign.status === "FAILED") {
    return summarize(campaignId, campaign.status);
  }
  // Only DRAFT (fresh send) or SENDING (resume an in-flight drain) proceed.
  if (campaign.status !== "DRAFT" && campaign.status !== "SENDING") {
    throw badRequest(`Campaign ${campaignId} is ${campaign.status}, not sendable`);
  }

  // ── Snapshot (DRAFT only) — build the QUEUED outbox once. ──
  if (campaign.status === "DRAFT") {
    const where = compileRules(campaign.segment.rules as unknown as SegmentRules);
    const customers = (await prisma.customer.findMany({
      where,
      select: {
        id: true,
        name: true,
        city: true,
        phone: true,
        email: true,
        lastOrderAt: true,
        totalSpend: true,
        orderCount: true,
        tags: true,
      },
    })) as Array<MergeCustomer & { id: string; orderCount: number; tags: string[] }>;

    if (customers.length === 0) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: "COMPLETED", sentAt: new Date(), audienceSize: 0 },
      });
      return { campaignId, status: "COMPLETED", audienceSize: 0, sent: 0, failed: 0 };
    }

    // ── Per-customer channel (SINGLE vs AI_ROUTED) ──
    const aiRouted = campaign.channelStrategy === "AI_ROUTED";
    const routeByCustomer = new Map<string, { channel: Channel; reason: string }>();
    if (aiRouted) {
      // Deterministic, in-process routing (no LLM) so a full-audience send always
      // finishes inside the serverless budget. The AI router powers the sampled,
      // cached routing PREVIEW shown in the builder; here we apply the same rules.
      const decisions = routeChannelsRuleBased(
        customers.map<CustomerWithAggregates>((c) => ({
          id: c.id,
          city: c.city,
          orderCount: c.orderCount,
          totalSpend: c.totalSpend,
          tags: c.tags,
        })),
      );
      for (const d of decisions) routeByCustomer.set(d.customerId, { channel: d.channel, reason: d.reason });
    }

    // ── Per-customer send window (INSTANT vs SMART_WINDOWS) ──
    const smartWindows = campaign.sendStrategy === "SMART_WINDOWS";
    const baseTime = new Date();
    const windowByCustomer = new Map<string, ReturnType<typeof inferSendWindow>>();
    if (smartWindows) {
      const orders = await prisma.order.findMany({
        where: { customerId: { in: customers.map((c) => c.id) } },
        select: { customerId: true, placedAt: true },
      });
      const ordersByCustomer = new Map<string, { placedAt: Date }[]>();
      for (const o of orders) {
        const list = ordersByCustomer.get(o.customerId) ?? [];
        list.push({ placedAt: o.placedAt });
        ordersByCustomer.set(o.customerId, list);
      }
      for (const c of customers) {
        windowByCustomer.set(c.id, inferSendWindow(ordersByCustomer.get(c.id) ?? []));
      }
    }

    const now = new Date();
    type SnapshotRow = {
      id: string;
      customerId: string;
      channel: Channel;
      renderedMessage: string;
      routingReason: string | null;
      sendWindow: SendWindowName | null;
      windowConfidence: "HIGH" | "LOW" | null;
      scheduledFor: Date | null;
    };
    const snapshot: SnapshotRow[] = customers.map((customer) => {
      const routed = aiRouted ? routeByCustomer.get(customer.id) : undefined;
      const channel: Channel = routed?.channel ?? campaign.channel;
      const win = smartWindows ? windowByCustomer.get(customer.id) : undefined;
      return {
        id: randomUUID(),
        customerId: customer.id,
        channel,
        renderedMessage: renderForCustomer(campaign.messageTemplate, customer, now),
        routingReason: routed?.reason ?? null,
        sendWindow: win?.window ?? null,
        windowConfidence: win?.confidence ?? null,
        scheduledFor: win ? new Date(baseTime.getTime() + demoDispatchDelayMs(win.window)) : null,
      };
    });

    await prisma.communicationLog.createMany({
      data: snapshot.map((row) => ({
        id: row.id,
        campaignId,
        customerId: row.customerId,
        channel: row.channel,
        renderedMessage: row.renderedMessage,
        routingReason: row.routingReason,
        sendWindow: row.sendWindow,
        windowConfidence: row.windowConfidence,
        scheduledFor: row.scheduledFor,
        status: "QUEUED",
      })),
    });

    // Move to SENDING up front so the page reflects progress immediately, even
    // if this request only drains part of the outbox.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "SENDING", sentAt: new Date(), audienceSize: customers.length },
    });

    // ── Accumulate variantMeta (routing + window summaries) and campaign fields ──
    const existingMeta =
      campaign.variantMeta && typeof campaign.variantMeta === "object" && !Array.isArray(campaign.variantMeta)
        ? (campaign.variantMeta as Record<string, unknown>)
        : {};
    const meta: Record<string, unknown> = { ...existingMeta };
    const campaignData: Prisma.CampaignUpdateInput = {};

    if (aiRouted) {
      const dist = { whatsapp: 0, sms: 0, email: 0, rcs: 0 };
      for (const row of snapshot) {
        if (row.channel === "WHATSAPP") dist.whatsapp += 1;
        else if (row.channel === "SMS") dist.sms += 1;
        else if (row.channel === "EMAIL") dist.email += 1;
        else if (row.channel === "RCS") dist.rcs += 1;
      }
      meta.routingSummary = { ...dist, model: env.AI_MODEL };
      campaignData.channel = pluralityChannel(dist);
    }
    if (smartWindows) {
      const w = { morning: 0, afternoon: 0, evening: 0, night: 0, highConfidence: 0, lowConfidence: 0 };
      for (const row of snapshot) {
        if (row.sendWindow === "MORNING") w.morning += 1;
        else if (row.sendWindow === "AFTERNOON") w.afternoon += 1;
        else if (row.sendWindow === "EVENING") w.evening += 1;
        else if (row.sendWindow === "NIGHT") w.night += 1;
        if (row.windowConfidence === "HIGH") w.highConfidence += 1;
        else w.lowConfidence += 1;
      }
      meta.windowSummary = w;
      campaignData.scheduledSendAt = baseTime;
    }
    if (aiRouted || smartWindows) {
      campaignData.variantMeta = meta as Prisma.InputJsonValue;
      await prisma.campaign.update({ where: { id: campaignId }, data: campaignData });
    }
  }

  // ── Drain the outbox (DRAFT-just-snapshotted or a resumed SENDING). ──
  await warmup; // capped wait so the dispatch below hits a warm sim
  const drained = await drainQueued(campaignId, env, requestStart);
  if (drained) {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "COMPLETED" } });
  }
  return summarize(campaignId, drained ? "COMPLETED" : "SENDING");
}

async function dispatchBatch(
  campaignId: string,
  batch: DispatchItem[],
  env: ReturnType<typeof getEnv>,
): Promise<void> {
  const body = JSON.stringify({
    messages: batch.map((item) => ({
      clientRef: item.clientRef,
      customerId: item.customerId,
      campaignId,
      channel: item.channel,
      to: item.to,
      renderedMessage: item.renderedMessage,
      ...(item.scheduledFor ? { scheduledFor: item.scheduledFor.toISOString() } : {}),
      ...(item.peakWindow ? { peakWindow: true } : {}),
    })),
  });
  const signature = signPayload(env.WEBHOOK_SECRET, body);
  const idempotencyKey = randomUUID();

  const response = await postBatch(env.CHANNEL_SIM_URL, body, signature, idempotencyKey);

  if (!response) {
    await prisma.communicationLog.updateMany({
      where: { id: { in: batch.map((item) => item.clientRef) } },
      data: { status: "FAILED", failureReason: "channel_unreachable" },
    });
    return;
  }

  const sentAt = new Date();
  const accepted: Array<{ clientRef: string; vendorMessageId: string }> = [];
  const rejected: Array<{ clientRef: string; reason: string }> = [];
  for (const result of response.results) {
    if (result.status === "accepted" && result.vendorMessageId) {
      accepted.push({ clientRef: result.clientRef, vendorMessageId: result.vendorMessageId });
    } else {
      rejected.push({ clientRef: result.clientRef, reason: result.reason ?? "rejected" });
    }
  }

  // Bulk-apply accepted rows in ONE UPDATE … FROM (VALUES) — keeping per-row
  // vendorMessageId — so a 100-message batch is one round-trip, not 100 (the
  // per-row loop dominated send latency under Neon connection-pool pressure).
  if (accepted.length > 0) {
    const rows = accepted.map((a) => Prisma.sql`(${a.clientRef}::text, ${a.vendorMessageId}::text)`);
    await prisma.$executeRaw`
      UPDATE "CommunicationLog" AS cl
      SET "status" = 'SENT'::"MessageStatus",
          "vendorMessageId" = v.vid,
          "sentAt" = ${sentAt}::timestamptz,
          "actualSentAt" = ${sentAt}::timestamptz,
          "updatedAt" = now()
      FROM (VALUES ${Prisma.join(rows)}) AS v(id, vid)
      WHERE cl.id = v.id
    `;
  }
  if (rejected.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const r of rejected) {
      const list = byReason.get(r.reason) ?? [];
      list.push(r.clientRef);
      byReason.set(r.reason, list);
    }
    for (const [reason, ids] of byReason) {
      await prisma.communicationLog.updateMany({
        where: { id: { in: ids } },
        data: { status: "FAILED", failureReason: reason },
      });
    }
  }
}

/** POST a batch with one retry + backoff. Returns null if both attempts fail. */
async function postBatch(
  simUrl: string,
  body: string,
  signature: string,
  idempotencyKey: string,
): Promise<SendBatchResponse | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(`${simUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signature,
          [IDEMPOTENCY_HEADER]: idempotencyKey,
        },
        body,
      });
      if (!res.ok) {
        throw new ApiError(res.status, "channel_error", `Sim responded ${res.status}`);
      }
      return SendBatchResponseSchema.parse(await res.json());
    } catch {
      if (attempt === 0) {
        await sleep(500);
      }
    }
  }
  return null;
}
