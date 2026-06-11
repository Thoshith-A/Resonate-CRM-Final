import { NextResponse } from "next/server";
import { fail } from "@/server/api";
import { sendCampaign } from "@/server/campaigns/sendCampaign";

export const dynamic = "force-dynamic";
// Audiences ≤ ~10k are dispatched synchronously in batches; at real scale
// this becomes an outbox + worker queue (see docs/decisions.md).
export const maxDuration = 60;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const result = await sendCampaign(id);
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
