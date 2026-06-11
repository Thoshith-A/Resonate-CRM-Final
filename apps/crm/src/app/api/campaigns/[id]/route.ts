import { NextResponse } from "next/server";
import { fail } from "@/server/api";
import { getCampaign } from "@/server/campaigns/getCampaign";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const campaign = await getCampaign(id);
    return NextResponse.json(campaign);
  } catch (error) {
    return fail(error);
  }
}
