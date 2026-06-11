import { NextResponse } from "next/server";
import { z } from "zod";
import { ChannelSchema } from "@resonate/shared";
import { fail, parseJson } from "@/server/api";
import { createCampaign } from "@/server/campaigns/createCampaign";
import { listCampaigns } from "@/server/campaigns/listCampaigns";

export const dynamic = "force-dynamic";

const CreateBodySchema = z.object({
  name: z.string().min(1).max(120),
  objective: z.string().max(500).optional(),
  segmentId: z.string().min(1),
  channel: ChannelSchema,
  messageTemplate: z.string().min(1).max(2000),
  variantMeta: z.unknown().optional(),
});

export async function GET(): Promise<NextResponse> {
  try {
    const campaigns = await listCampaigns();
    return NextResponse.json({ campaigns });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = await parseJson(request, CreateBodySchema);
    const campaign = await createCampaign(input);
    return NextResponse.json(campaign, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
