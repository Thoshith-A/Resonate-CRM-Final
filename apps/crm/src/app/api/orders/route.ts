import { NextResponse } from "next/server";
import { OrderInputSchema } from "@resonate/shared";
import { fail, parseJson } from "@/server/api";
import { ingestOrder } from "@/server/ingestion/ingestOrder";

export const dynamic = "force-dynamic";

/**
 * Public ingestion endpoint. Also the channel simulator's conversion front
 * door: it posts CAMPAIGN-sourced orders here with attribution ids.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = await parseJson(request, OrderInputSchema);
    const order = await ingestOrder(input);
    return NextResponse.json(order, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
