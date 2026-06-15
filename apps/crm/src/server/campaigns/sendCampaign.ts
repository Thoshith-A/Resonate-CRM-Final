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

export type SendCampaignResult = {
  campaignId: string;
  status: string;
  audienceSize: number;
  sent: number;
  failed: number;
};

type Recipient = MergeCustomer & {
  id: string;
  phone: string;
  email: string;
  orderCount: number;
  tags: string[];
};

type DispatchItem = {
  clientRef: string; // CommunicationLog id
  customerId: string;
  channel: Channel; // per-row channel (== campaign.channel for SINGLE strategy)
  to: string;
  renderedMessage: string;
  routingReason: string | null;
  // Send-Time Intelligence (null for INSTANT campaigns):
  sendWindow: SendWindowName | null;
  windowConfidence: "HIGH" | "LOW" | null;
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
 * Send a campaign. Snapshots the audience into CommunicationLog rows, then
 * dispatches to the channel sim in batches of 100 (concurrency 5) over signed
 * HTTP with a per-batch idempotency key. A send must never crash halfway.
 *
 * Channel strategy: SINGLE uses campaign.channel for all; AI_ROUTED picks a
 * channel per customer (router), stores the distribution, and sets the campaign
 * channel to the plurality winner.
 *
 * Send strategy: INSTANT dispatches everything immediately; SMART_WINDOWS infers
 * each customer's peak window and staggers dispatch across windows (returns
 * SENDING; later windows dispatch after the response and settle the campaign).
 */
export async function sendCampaign(campaignId: string): Promise<SendCampaignResult> {
  const env = getEnv();

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { segment: true },
  });
  if (!campaign) {
    throw notFound(`No campaign with id ${campaignId}`);
  }
  if (campaign.status !== "DRAFT") {
    throw badRequest(`Campaign ${campaignId} is ${campaign.status}, not DRAFT`);
  }

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
  })) as Recipient[];

  if (customers.length === 0) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "COMPLETED", sentAt: new Date(), audienceSize: 0 },
    });
    return { campaignId, status: "COMPLETED", audienceSize: 0, sent: 0, failed: 0 };
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: "SENDING", sentAt: new Date(), audienceSize: customers.length },
  });

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
  const items: DispatchItem[] = customers.map((customer) => {
    const routed = aiRouted ? routeByCustomer.get(customer.id) : undefined;
    const channel: Channel = routed?.channel ?? campaign.channel;
    const win = smartWindows ? windowByCustomer.get(customer.id) : undefined;
    return {
      clientRef: randomUUID(),
      customerId: customer.id,
      channel,
      to: recipientAddress(channel, customer),
      renderedMessage: renderForCustomer(campaign.messageTemplate, customer, now),
      routingReason: routed?.reason ?? null,
      sendWindow: win?.window ?? null,
      windowConfidence: win?.confidence ?? null,
      scheduledFor: win ? new Date(baseTime.getTime() + demoDispatchDelayMs(win.window)) : null,
      peakWindow: win?.confidence === "HIGH",
    };
  });

  await prisma.communicationLog.createMany({
    data: items.map((item) => ({
      id: item.clientRef,
      campaignId,
      customerId: item.customerId,
      channel: item.channel,
      renderedMessage: item.renderedMessage,
      routingReason: item.routingReason,
      sendWindow: item.sendWindow,
      windowConfidence: item.windowConfidence,
      scheduledFor: item.scheduledFor,
      status: "QUEUED",
    })),
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
    for (const item of items) {
      if (item.channel === "WHATSAPP") dist.whatsapp += 1;
      else if (item.channel === "SMS") dist.sms += 1;
      else if (item.channel === "EMAIL") dist.email += 1;
      else if (item.channel === "RCS") dist.rcs += 1;
    }
    meta.routingSummary = { ...dist, model: env.AI_MODEL };
    campaignData.channel = pluralityChannel(dist);
  }
  if (smartWindows) {
    const w = { morning: 0, afternoon: 0, evening: 0, night: 0, highConfidence: 0, lowConfidence: 0 };
    for (const item of items) {
      if (item.sendWindow === "MORNING") w.morning += 1;
      else if (item.sendWindow === "AFTERNOON") w.afternoon += 1;
      else if (item.sendWindow === "EVENING") w.evening += 1;
      else if (item.sendWindow === "NIGHT") w.night += 1;
      if (item.windowConfidence === "HIGH") w.highConfidence += 1;
      else w.lowConfidence += 1;
    }
    meta.windowSummary = w;
    campaignData.scheduledSendAt = baseTime;
  }
  if (aiRouted || smartWindows) {
    campaignData.variantMeta = meta as Prisma.InputJsonValue;
    await prisma.campaign.update({ where: { id: campaignId }, data: campaignData });
  }

  // Dispatch the ENTIRE audience in-request — never via post-response timers,
  // which a serverless function (Vercel) freezes the moment it answers. For
  // SMART_WINDOWS each message carries its own `scheduledFor`, so the always-on
  // channel-sim staggers the funnel across windows on its OWN timers (see
  // channel-sim/src/index.ts dispatchOnTimers); INSTANT messages are due now.
  // Either way the request settles COMPLETED inside maxDuration.
  const batches = chunk(items, BATCH_SIZE);
  await runPool(batches, CONCURRENCY, (batch) => dispatchBatch(campaignId, batch, env));
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: "COMPLETED" } });

  const grouped = await prisma.communicationLog.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { _all: true },
  });
  const failed = grouped.find((g) => g.status === "FAILED")?._count._all ?? 0;
  const sent = customers.length - failed;
  return { campaignId, status: "COMPLETED", audienceSize: customers.length, sent, failed };
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
