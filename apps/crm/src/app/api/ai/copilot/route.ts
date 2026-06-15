import { NextResponse } from "next/server";
import { z } from "zod";
import { fail, parseJson } from "@/server/api";
import { runCopilot } from "@/server/ai/copilot";

export const dynamic = "force-dynamic";
// A turn may preview → draft → send (a full campaign dispatch) in one call.
export const maxDuration = 60;

const BodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(40),
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { messages } = await parseJson(request, BodySchema);
    const result = await runCopilot(messages);
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
