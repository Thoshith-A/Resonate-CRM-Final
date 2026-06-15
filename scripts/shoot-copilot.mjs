import { chromium } from "playwright-core";

const BASE = "http://localhost:3000";
const OUT = "C:/Users/thoshith.a/CRM/.shots";

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

// Open the Copilot panel.
await page.getByRole("button", { name: /copilot/i }).first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/copilot-empty.png`, fullPage: false });
console.log("shot copilot-empty.png");

// Fire the first suggestion chip and wait for the assistant + tool chip.
try {
  await page.getByText(/high spenders in Mumbai/i).first().click();
  // Wait for the tool chip summary — "Previewed …" / "Drafted …" only appear
  // in the copilot panel, never on the dashboard behind it.
  await page
    .getByText(/Previewed|Drafted|Created &|Couldn't map/i)
    .first()
    .waitFor({ timeout: 45000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/copilot-turn.png`, fullPage: false });
  console.log("shot copilot-turn.png");
} catch (err) {
  await page.screenshot({ path: `${OUT}/copilot-turn.png`, fullPage: false });
  console.log("shot copilot-turn.png (partial:", err.message, ")");
}

await browser.close();
