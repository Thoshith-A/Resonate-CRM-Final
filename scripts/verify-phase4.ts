import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { signPayload } from "@resonate/shared/crypto";

if (!process.env.DATABASE_URL || !process.env.WEBHOOK_SECRET) {
  process.loadEnvFile(resolve("apps/crm/.env"));
}

const BASE = "http://localhost:3000";
const SECRET = process.env.WEBHOOK_SECRET ?? "dev-webhook-secret-change-me";
const prisma = new PrismaClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  // 1) Segment (~Mumbai audience)
  const segment = await post("/api/segments", {
    name: `QA Mumbai ${Date.now()}`,
    rules: { field: "city", cmp: "eq", value: "Mumbai" },
  });
  console.log(`segment: ${segment.name} → ${segment.lastPreviewCount} customers`);

  // 2) Campaign
  const campaign = await post("/api/campaigns", {
    name: "QA winback",
    objective: "win them back with 15% off",
    segmentId: segment.id,
    channel: "WHATSAPP",
    messageTemplate:
      "Hi {{first_name}}, your last {{city}} order was {{last_order_days_ago}} days ago — ₹{{total_spend_rupees}} of great coffee. 15% off to come back?",
  });
  console.log(`campaign: ${campaign.id}`);

  // 3) Send
  const sendResult = await post(`/api/campaigns/${campaign.id}/send`, {});
  console.log(`send: audience=${sendResult.audienceSize} sent=${sendResult.sent} failed=${sendResult.failed} status=${sendResult.status}`);

  // 4) Watch the funnel flow
  console.log("\nfunnel (QUEUED/SENT/DELIVERED/READ/CLICKED/FAILED):");
  for (let i = 0; i < 8; i += 1) {
    const detail = await (await fetch(`${BASE}/api/campaigns/${campaign.id}`)).json();
    const c = detail.statusCounts;
    console.log(`  t+${i * 4}s  Q:${c.QUEUED} S:${c.SENT} D:${c.DELIVERED} R:${c.READ} C:${c.CLICKED} F:${c.FAILED}`);
    if (i < 7) await sleep(4000);
  }

  // 5) Replay idempotency: post the SAME receipt batch twice.
  const sentRow = await prisma.communicationLog.findFirst({
    where: { campaignId: campaign.id, vendorMessageId: { not: null } },
    select: { id: true, vendorMessageId: true },
  });
  if (!sentRow?.vendorMessageId) {
    throw new Error("no SENT row with a vendorMessageId to replay");
  }
  const batch = {
    sentAt: new Date().toISOString(),
    events: [
      { vendorMessageId: sentRow.vendorMessageId, eventType: "delivered", occurredAt: new Date().toISOString() },
      { vendorMessageId: sentRow.vendorMessageId, eventType: "clicked", occurredAt: new Date().toISOString() },
    ],
  };
  const raw = JSON.stringify(batch);
  const sig = signPayload(SECRET, raw);
  const send = () =>
    fetch(`${BASE}/api/webhooks/receipts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": sig },
      body: raw,
    }).then((r) => r.json());

  const ack1 = await send();
  const after1 = await prisma.communicationLog.findUnique({ where: { id: sentRow.id }, select: { status: true } });
  const ack2 = await send();
  const after2 = await prisma.communicationLog.findUnique({ where: { id: sentRow.id }, select: { status: true } });

  console.log("\nreplay idempotency:");
  console.log(`  batch 1 ack: ${JSON.stringify(ack1)}  → status ${after1?.status}`);
  console.log(`  batch 2 ack: ${JSON.stringify(ack2)}  → status ${after2?.status}`);
  const idempotent = ack2.accepted === 0 && ack2.duplicates === batch.events.length && after1?.status === after2?.status;
  console.log(`  IDEMPOTENT: ${idempotent ? "YES ✓ (zero duplicate state changes)" : "NO ✗"}`);

  // 6) Reconcile DB vs API counts
  const dbCounts = await prisma.communicationLog.groupBy({
    by: ["status"],
    where: { campaignId: campaign.id },
    _count: { _all: true },
  });
  console.log(`\nDB rows for campaign: ${dbCounts.map((g) => `${g.status}=${g._count._all}`).join(" ")}`);
}

main()
  .catch((e) => {
    console.error("VERIFY FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
