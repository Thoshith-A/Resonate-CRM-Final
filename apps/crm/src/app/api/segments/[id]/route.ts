import { NextResponse } from "next/server";
import { fail } from "@/server/api";
import { getSegment } from "@/server/segments/getSegment";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const segment = await getSegment(id);
    return NextResponse.json(segment);
  } catch (error) {
    return fail(error);
  }
}
