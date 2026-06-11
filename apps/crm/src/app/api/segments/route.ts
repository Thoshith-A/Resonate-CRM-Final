import { NextResponse } from "next/server";
import { z } from "zod";
import { SegmentRulesSchema } from "@resonate/shared";
import { fail, parseJson } from "@/server/api";
import { createSegment } from "@/server/segments/createSegment";
import { listSegments } from "@/server/segments/listSegments";

export const dynamic = "force-dynamic";

const CreateBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  rules: SegmentRulesSchema,
  createdByAi: z.boolean().optional(),
});

export async function GET(): Promise<NextResponse> {
  try {
    const segments = await listSegments();
    return NextResponse.json({ segments });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = await parseJson(request, CreateBodySchema);
    const segment = await createSegment(input);
    return NextResponse.json(segment, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
