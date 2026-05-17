import pkg from "/Users/dylanriedweg/wavex-os/packages/core/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pkg;
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "/tmp/mc-verify";
mkdirSync(OUT, { recursive: true });

// Port 3100 — Paperclip serves its UI directly via dev middleware, and
// /_plugins/* lands on the real plugin asset route. Port 5174 is vite
// dev proxy and only forwards /api, not /_plugins.
const BASE = "http://127.0.0.1:3100";

const COMPANIES = [
  { prefix: "MIS", label: "Mission Control Demo" },
  { prefix: "WAV", label: "wavex-os/ricoma-live-001" },
];

const MC_LABELS = [
  "Activity Stream", "Deliverables", "KPI Scoreboard",
  "Node Profile", "Accountability Graph", "Chief of Staff", "Operations",
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
const page = await ctx.newPage();
const consoleMsgs = [];
const netFails = [];
page.on("console", (m) => { if (m.type() === "error") consoleMsgs.push(m.text().slice(0, 280)); });
page.on("requestfailed", (r) => netFails.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) netFails.push(`${r.status()} ${r.url()}`); });

for (const c of COMPANIES) {
  console.log(`\n=== ${c.label} (/${c.prefix}/dashboard) ===`);
  await page.goto(`${BASE}/${c.prefix}/dashboard`, { waitUntil: "networkidle", timeout: 30000 }).catch(e => console.log("  goto error:", e.message));
  console.log("  landed:", page.url());
  console.log("  title: ", await page.title());
  await page.waitForTimeout(5000); // let plugins lazy-load

  for (const label of MC_LABELS) {
    const count = await page.getByText(`Mission Control — ${label}`, { exact: false }).count();
    console.log(`  ${count > 0 ? "✓" : "✗"} ${label} (${count})`);
  }

  const hasNative = (await page.getByText("Agents Enabled", { exact: false }).count()) > 0;
  console.log(`  native dashboard tiles: ${hasNative ? "yes" : "NO"}`);

  const sectionCount = await page.locator("section[aria-label]").count();
  console.log(`  section[aria-label] count: ${sectionCount}`);
  if (sectionCount > 0 && sectionCount < 30) {
    const labels = await page.locator("section[aria-label]").evaluateAll(els =>
      els.map(el => el.getAttribute("aria-label")).filter(Boolean)
    );
    for (const l of labels) console.log(`    - ${l}`);
  }

  await page.screenshot({ path: join(OUT, `${c.prefix}.png`), fullPage: true });
  console.log("  screenshot:", join(OUT, `${c.prefix}.png`));
}

console.log("\n=== console errors (first 12) ===");
if (consoleMsgs.length === 0) console.log("  (none)");
for (const m of consoleMsgs.slice(0, 12)) console.log("  -", m);
console.log("\n=== network failures (first 12) ===");
if (netFails.length === 0) console.log("  (none)");
for (const m of netFails.slice(0, 12)) console.log("  -", m);

await browser.close();
