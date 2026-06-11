import { randomUUID } from "node:crypto";
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  SendBatchResponseSchema,
  type Channel,
  type SegmentRules,
  type SendBatchResponse,
} from "@resonate/shared";
import { signPayload } from "@resonate/shared/crypto";
import { prisma } from "../db";
import { getEnv } from "../env";
import { ApiError, badRequest, notFound } from "../api";
import { compileRules } from "../segments/compile";
import { renderForCustomer, type MergeCustomer } from "./template";

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
};

type DispatchItem = {
  clientRef: string; // CommunicationLog id
  customerId: string;
  to: string;
  renderedMessage: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recipientAddress(channel: Channel, customer: Recipient): string {
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
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * Send a campaign. Snapshots the audience into CommunicationLog rows, then
 * dispatches to the channel sim in batches of 100 (concurrency 5) over
 * signed HTTP with a per-batch idempotency key. A send must never crash
 * halfway: a batch that can't reach the sim (after one retry) marks its
 * rows FAILED("channel_unreachable") and the run continues. The campaign
 * settles to COMPLETED once every row has left QUEUED.
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

  // Re-evaluate the segment and snapshot the audience.
  const where = compileRules(campaign.segment.rules as unknown as SegmentRules);
  const customers = (await prisma.customer.findMany({
    where,
    select: { id: true, name: true, city: true, phone: true, email: true, lastOrderAt: true, totalSpend: true },
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

  const now = new Date();
  const items: (DispatchItem & { channel: Channel })[] = customers.map((customer) => {
    const clientRef = randomUUID();
    return {
      clientRef,
      customerId: customer.id,
      channel: campaign.channel,
      to: recipientAddress(campaign.channel, customer),
      renderedMessage: renderForCustomer(campaign.messageTemplate, customer, now),
    };
  });

  // One QUEUED CommunicationLog row per recipient (the snapshot).
  await prisma.communicationLog.createMany({
    data: items.map((item) => ({
      id: item.clientRef,
      campaignId,
      customerId: item.customerId,
      channel: campaign.channel,
      renderedMessage: item.renderedMessage,
      status: "QUEUED",
    })),
  });

  const batches = chunk(items, BATCH_SIZE);
  await runPool(batches, CONCURRENCY, (batch) => dispatchBatch(campaignId, campaign.channel, batch, env));

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
  channel: Channel,
  batch: (DispatchItem & { channel: Channel })[],
  env: ReturnType<typeof getEnv>,
): Promise<void> {
  const body = JSON.stringify({
    messages: batch.map((item) => ({
      clientRef: item.clientRef,
      customerId: item.customerId,
      campaignId,
      channel,
      to: item.to,
      renderedMessage: item.renderedMessage,
    })),
  });
  const signature = signPayload(env.WEBHOOK_SECRET, body);
  const idempotencyKey = randomUUID();

  const response = await postBatch(env.CHANNEL_SIM_URL, body, signature, idempotencyKey);

  if (!response) {
    // Sim unreachable after a retry — fail this batch's rows and keep going.
    await prisma.communicationLog.updateMany({
      where: { id: { in: batch.map((item) => item.clientRef) } },
      data: { status: "FAILED", failureReason: "channel_unreachable" },
    });
    return;
  }

  const sentAt = new Date();
  await Promise.all(
    response.results.map((result) => {
      if (result.status === "accepted" && result.vendorMessageId) {
        return prisma.communicationLog.update({
          where: { id: result.clientRef },
          data: { status: "SENT", vendorMessageId: result.vendorMessageId, sentAt },
        });
      }
      return prisma.communicationLog.update({
        where: { id: result.clientRef },
        data: { status: "FAILED", failureReason: result.reason ?? "rejected" },
      });
    }),
  );
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
