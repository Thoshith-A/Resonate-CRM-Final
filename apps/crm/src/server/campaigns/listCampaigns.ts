import { prisma } from "../db";

export type CampaignListItem = {
  id: string;
  name: string;
  channel: string;
  status: string;
  audienceSize: number;
  createdAt: string;
  sentAt: string | null;
};

/** Campaigns, most recent first (dashboard + campaigns list). */
export async function listCampaigns(): Promise<CampaignListItem[]> {
  const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: "desc" } });
  return campaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    channel: campaign.channel,
    status: campaign.status,
    audienceSize: campaign.audienceSize,
    createdAt: campaign.createdAt.toISOString(),
    sentAt: campaign.sentAt ? campaign.sentAt.toISOString() : null,
  }));
}
