import { NextResponse } from "next/server";
import { z } from "zod";
import { SegmentRulesSchema } from "@resonate/shared";
import { fail, parseJson } from "@/server/api";
import { previewSegment } from "@/server/segments/previewSegment";

export const dynamic = "force-dynamic";

const PreviewBodySchema = z.object({ rules: SegmentRulesSchema });

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { rules } = await parseJson(request, PreviewBodySchema);
    const preview = await previewSegment(rules);
    return NextResponse.json(preview);
  } catch (error) {
    return fail(error);
  }
}
