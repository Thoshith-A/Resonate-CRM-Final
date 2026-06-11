import type { Campaign, Prisma } from "@prisma/client";
import type { Channel } from "@resonate/shared";
import { prisma } from "../db";
import { badRequest } from "../api";

export type CreateCampaignInput = {
  name: string;
  objective?: string;
  segmentId: string;
  channel: Channel;
  messageTemplate: string;
  variantMeta?: unknown;
};

/** Create a DRAFT campaign against an existing segment. Audience is snapshot
 * at send time, so audienceSize starts at 0. */
export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const segment = await prisma.segment.findUnique({ where: { id: input.segmentId } });
  if (!segment) {
    throw badRequest(`No segment with id ${input.segmentId}`);
  }
  return prisma.campaign.create({
    data: {
      name: input.name,
      objective: input.objective ?? null,
      segmentId: input.segmentId,
      channel: input.channel,
      messageTemplate: input.messageTemplate,
      variantMeta: (input.variantMeta ?? undefined) as Prisma.InputJsonValue | undefined,
      status: "DRAFT",
      audienceSize: 0,
    },
  });
}
