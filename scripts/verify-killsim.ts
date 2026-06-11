import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  process.loadEnvFile(resolve("apps/crm/.env"));
}
const BASE = "http://localhost:3000";
const prisma = new PrismaClient();

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  // Small audience so the dead-sim retries finish quickly.
  const segment = await post("/api/segments", {
    name: `QA killsim ${Date.now()}`,
    rules: { field: "city", cmp: "eq", value: "Surat" },
  });
  const campaign = await post("/api/campaigns", {
    name: "QA killsim",
    segmentId: segment.id,
    channel: "SMS",
    messageTemplate: "Hi {{first_name}}, a note from Brewline.",
  });
  console.log(`segment ${segment.lastPreviewCount} customers; sending with the sim DOWN…`);

  const result = await post(`/api/campaigns/${campaign.id}/send`, {});
  console.log(`send result: ${JSON.stringify(result)}`);

  const detail = await (await fetch(`${BASE}/api/campaigns/${campaign.id}`)).json();
  const c = detail.statusCounts;
  const sampleFailed = await prisma.communicationLog.findFirst({
    where: { campaignId: campaign.id, status: "FAILED" },
    select: { failureReason: true },
  });

  console.log(`status: ${detail.status}`);
  console.log(`counts: Q:${c.QUEUED} S:${c.SENT} D:${c.DELIVERED} F:${c.FAILED}`);
  console.log(`sample failureReason: ${sampleFailed?.failureReason}`);

  const consistent =
    detail.status === "COMPLETED" &&
    c.QUEUED === 0 &&
    c.FAILED === detail.audienceSize &&
    sampleFailed?.failureReason === "channel_unreachable";
  console.log(`CONSISTENT (no zombies, all channel_unreachable, COMPLETED): ${consistent ? "YES ✓" : "NO ✗"}`);
}

main()
  .catch((e) => {
    console.error("KILLSIM VERIFY FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
