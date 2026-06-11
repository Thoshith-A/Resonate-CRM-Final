/**
 * Dev-only route warmer. Next.js compiles routes on first request in dev, so
 * the first navigation to a page otherwise stalls a few seconds. This polls
 * the CRM until it's up, then requests each route once so they're already
 * compiled before anyone clicks. No-op against a production build.
 */
const BASE = process.env.WARM_BASE ?? "http://localhost:3000";
const ROUTES = ["/dashboard", "/customers", "/segments", "/segments/new"];
// API routes compile on first hit too; warming the webhook avoids the sim's
// first receipt flush racing a cold compile.
const WARM_GET = ["/api/customers?pageSize=1", "/api/segments", "/api/campaigns"];
const WARM_POST = ["/api/webhooks/receipts", "/api/segments/preview"];
const DEADLINE = Date.now() + 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isUp() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  while (Date.now() < DEADLINE) {
    if (await isUp()) {
      break;
    }
    await sleep(1000);
  }
  const get = async (path) => {
    try {
      await fetch(`${BASE}${path}`);
    } catch {
      // Best-effort.
    }
  };
  // A bare POST compiles the route handler even if it 400s on an empty body.
  const poke = async (path) => {
    try {
      await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      // Best-effort.
    }
  };
  await Promise.all([
    ...ROUTES.map(get),
    ...WARM_GET.map(get),
    ...WARM_POST.map(poke),
  ]);
  console.log("[warm] routes ready");
}

void main();
