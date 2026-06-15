import { NextResponse } from "next/server";
import { getEnv } from "@/server/env";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Wake the channel-sim ahead of a send. Render's free dyno spins down when idle,
 * so the first request after that pays a long cold-start. The campaign builder
 * fires this (best-effort) when the marketer reaches the message/review steps,
 * so by the time they hit "Create & send" the sim is warm and the dispatch
 * finishes inside the serverless budget. Never throws — warming is optional.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const env = getEnv();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(`${env.CHANNEL_SIM_URL}/health`, { signal: controller.signal });
      return NextResponse.json({ ok: res.ok });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return NextResponse.json({ ok: false });
  }
}
