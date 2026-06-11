import { NextResponse } from "next/server";
import { ReceiptBatchSchema, SIGNATURE_HEADER, errorEnvelope } from "@resonate/shared";
import { verifyPayload } from "@resonate/shared/crypto";
import { fail } from "@/server/api";
import { getEnv } from "@/server/env";
import { processReceipts } from "@/server/receipts/processReceipts";

export const dynamic = "force-dynamic";

const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Receipt callback from the channel sim. Verifies the HMAC over the raw
 * body, rejects stale batches (replay-window defense), then ingests
 * idempotently. Returns a per-batch ack.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const env = getEnv();
    const raw = await request.text();
    const signature = request.headers.get(SIGNATURE_HEADER);

    if (!verifyPayload(env.WEBHOOK_SECRET, raw, signature)) {
      return NextResponse.json(
        errorEnvelope("invalid_signature", "Signature verification failed."),
        { status: 401 },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return NextResponse.json(errorEnvelope("bad_request", "Body must be JSON."), {
        status: 400,
      });
    }

    const batch = ReceiptBatchSchema.parse(json);

    const skew = Math.abs(Date.now() - new Date(batch.sentAt).getTime());
    if (skew > MAX_SKEW_MS) {
      return NextResponse.json(
        errorEnvelope("stale_timestamp", "Batch timestamp is outside the 5-minute window."),
        { status: 401 },
      );
    }

    const ack = await processReceipts(batch);
    return NextResponse.json(ack);
  } catch (error) {
    return fail(error);
  }
}
