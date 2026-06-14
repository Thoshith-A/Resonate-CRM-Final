import { chromium } from "playwright-core";

const BASE = "http://localhost:3000";
const OUT = "C:/Users/thoshith.a/CRM/.shots";
const OLD = "cmqe543j30001qckgeaa3qx99"; // deleted by reset → should show not-found
const NEW = "cmqefogjz0002qcgcasddr0c0"; // freshly sent → live

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* next */
    }
  }
  return chromium.launch({ headless: true });
}

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto(`${BASE}/campaigns/${OLD}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/fix-notfound.png`, fullPage: true });
console.log("shot fix-notfound.png");

await page.goto(`${BASE}/campaigns/${NEW}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/fix-live.png`, fullPage: true });
console.log("shot fix-live.png");

await browser.close();
