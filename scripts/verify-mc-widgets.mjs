#!/usr/bin/env node
/** Headless-Chromium E2E proof that the Mission Control widgets render
 *  in Paperclip's dashboard. Reports exactly which slots painted, which
 *  failed, plus a screenshot per company. */

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PAPERCLIP = "http://127.0.0.1:5174";
const OUT_DIR = "/tmp/mc-verify";
mkdirSync(OUT_DIR, { recursive: true });

const COMPANIES = [
  { id: "d348fd29-d35b-446f-9a42-cd7fef98ec80", label: "demo (seeded)" },
  { id: "ec353da0-f158-4451-ba61-2d9425f2373e", label: "ricoma (real onboarding)" },
];

const MC_WIDGET_LABELS = [
  "Mission Control — Activity Stream",
  "Mission Control — Deliverables",
  "Mission Control — KPI Scoreboard",
  "Mission Control — Node Profile",
  "Mission Control — Accountability Graph",
  "Mission Control — Chief of Staff",
  "Mission Control — Operations",
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await ctx.newPage();

// Surface any console errors / network failures so we can see plugin
// bundle / bridge problems that would otherwise be silent in the UI.
const consoleErrors = [];
const networkErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("requestfailed", (req) => {
  networkErrors.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
});
page.on("response", (res) => {
  if (res.status() >= 400 && res.url().includes("/plugins")) {
    networkErrors.push(`${res.status()} ${res.url()}`);
  }
});

for (const company of COMPANIES) {
  console.log(`\n=== ${company.label} (${company.id.slice(0, 8)}) ===`);

  // Land on the dashboard for this specific company. Paperclip uses
  // slug-based URLs internally; the API exposes the company by id, so
  // load the root and then drive the company picker if needed.
  await page.goto(`${PAPERCLIP}/companies/${company.id}/dashboard`, {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // Give plugin bundles time to lazy-load + render
  await page.waitForTimeout(3000);

  const url = page.url();
  console.log(`  landed at:        ${url}`);

  // Plugin slot outlets render with a wrapper; the manifest's
  // displayName ends up as a section heading or aria-label. Try multiple
  // selectors so we find them whichever wrapping the host uses.
  const found = {};
  for (const label of MC_WIDGET_LABELS) {
    let count = 0;
    // Attempt 1: aria-label match
    count += await page.locator(`[aria-label="${label}"]`).count();
    // Attempt 2: text content anywhere on page
    count += await page.getByText(label, { exact: false }).count();
    found[label] = count;
  }

  const present = Object.entries(found).filter(([, c]) => c > 0);
  console.log(`  MC widgets found: ${present.length} / ${MC_WIDGET_LABELS.length}`);
  for (const [label, count] of Object.entries(found)) {
    console.log(`    ${count > 0 ? "✓" : "✗"} ${label.replace("Mission Control — ", "")}${count > 0 ? ` (${count})` : ""}`);
  }

  // Capture screenshot for visual confirmation
  const shot = join(OUT_DIR, `${company.id.slice(0, 8)}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`  screenshot:       ${shot}`);

  // Also probe for the native wavex KPI panel + native dashboard tiles
  // — if those don't render either, the company route itself is broken.
  const hasNativeDashboard =
    (await page.getByText("Agents Enabled", { exact: false }).count()) > 0;
  const hasWavexPanel =
    (await page.getByText("WaveX KPI", { exact: false }).count()) +
    (await page.getByText("WaveX", { exact: false }).count());
  console.log(`  native dashboard tiles present: ${hasNativeDashboard ? "yes" : "NO"}`);
  console.log(`  wavex KPI panel mentions:        ${hasWavexPanel}`);
}

console.log("\n=== console errors ===");
if (consoleErrors.length === 0) console.log("  (none)");
else for (const e of consoleErrors.slice(0, 10)) console.log(`  - ${e.slice(0, 240)}`);

console.log("\n=== network errors ===");
if (networkErrors.length === 0) console.log("  (none)");
else for (const e of networkErrors.slice(0, 10)) console.log(`  - ${e}`);

await browser.close();
console.log(`\nDone. Screenshots in ${OUT_DIR}/`);
