/**
 * Run a campaign against an EXISTING saved segment (until the campaign UI
 * lands in Phase 5). Usage:
 *   pnpm exec tsx scripts/run-segment.ts "High spenders gone quiet"
 *   pnpm exec tsx scripts/run-segment.ts                # uses the first segment
 * Optional channel as 2nd arg: WHATSAPP (default) | SMS | EMAIL | RCS.
 */
const BASE = "http://localhost:3000";
const nameQuery = (process.argv[2] ?? "").toLowerCase();
const channel = (process.argv[3] ?? "WHATSAPP").toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function json(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const { segments } = await json("/api/segments");
  if (!segments.length) {
    console.log("No saved segments yet — build one at /segments/new first.");
    return;
  }
  const segment = nameQuery
    ? segments.find((s: { name: string }) => s.name.toLowerCase().includes(nameQuery)) ?? segments[0]
    : segments[0];

  console.log(`Running segment: "${segment.name}" (${segment.lastPreviewCount ?? "?"} customers) via ${channel}\n`);

  const campaign = await json("/api/campaigns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `${segment.name} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      objective: "win them back with 15% off",
      segmentId: segment.id,
      channel,
      messageTemplate:
        "Hi {{first_name}}, it's been {{last_order_days_ago}} days since your last Brewline order in {{city}}. Here's 15% off to come back. ☕",
    }),
  });

  const result = await json(`/api/campaigns/${campaign.id}/send`, { method: "POST" });
  console.log(`sent: audience=${result.audienceSize} accepted=${result.sent} rejected=${result.failed}\n`);
  console.log("funnel (Q/S/D/R/C/F):");
  for (let i = 0; i < 8; i += 1) {
    const detail = await json(`/api/campaigns/${campaign.id}`);
    const c = detail.statusCounts;
    console.log(`  t+${i * 4}s  Q:${c.QUEUED} S:${c.SENT} D:${c.DELIVERED} R:${c.READ} C:${c.CLICKED} F:${c.FAILED}`);
    if (i < 7) await sleep(4000);
  }
  console.log(`\nCampaign id: ${campaign.id}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
