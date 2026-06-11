import type { MessageStatus } from "@prisma/client";
import { prisma } from "../db";
import { notFound } from "../api";

export type CampaignStatusCounts = Record<MessageStatus, number>;

export type CampaignDetail = {
  id: string;
  name: string;
  objective: string | null;
  segmentId: string;
  segmentName: string;
  channel: string;
  messageTemplate: string;
  status: string;
  audienceSize: number;
  createdAt: string;
  sentAt: string | null;
  statusCounts: CampaignStatusCounts;
};

const ZERO_COUNTS: CampaignStatusCounts = {
  QUEUED: 0,
  SENT: 0,
  FAILED: 0,
  DELIVERED: 0,
  READ: 0,
  CLICKED: 0,
};

/** Campaign with per-status CommunicationLog counts (powers the funnel/feed). */
export async function getCampaign(id: string): Promise<CampaignDetail> {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { segment: { select: { name: true } } },
  });
  if (!campaign) {
    throw notFound(`No campaign with id ${id}`);
  }

  const grouped = await prisma.communicationLog.groupBy({
    by: ["status"],
    where: { campaignId: id },
    _count: { _all: true },
  });
  const statusCounts: CampaignStatusCounts = { ...ZERO_COUNTS };
  for (const row of grouped) {
    statusCounts[row.status] = row._count._all;
  }

  return {
    id: campaign.id,
    name: campaign.name,
    objective: campaign.objective,
    segmentId: campaign.segmentId,
    segmentName: campaign.segment.name,
    channel: campaign.channel,
    messageTemplate: campaign.messageTemplate,
    status: campaign.status,
    audienceSize: campaign.audienceSize,
    createdAt: campaign.createdAt.toISOString(),
    sentAt: campaign.sentAt ? campaign.sentAt.toISOString() : null,
    statusCounts,
  };
}
