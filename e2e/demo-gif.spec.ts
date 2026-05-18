/**
 * Demo GIF recorder — produces docs/images/demo.gif via Playwright recordVideo.
 *
 * Walks the current chat-first onboarding UI (/onboarding-chat?t0=1) in
 * fast mode so no Claude CLI or API keys are required.
 *
 * Run:
 *   WAVEX_E2E_DEMO=1 pnpm test:e2e e2e/demo-gif.spec.ts
 *
 * After run, convert output:
 *   WEBM=$(ls demo-output/*.webm | head -1)
 *   ffmpeg -i "$WEBM" -vf "fps=12,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
 *     -loop 0 docs/images/demo.gif
 *
 * Skipped by default to keep out of CI. Set WAVEX_E2E_DEMO=1 to run.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const RUN = process.env.WAVEX_E2E_DEMO === "1";
const OUT_DIR = "demo-output";

test("wizard demo walkthrough", async ({ browser }) => {
  test.skip(!RUN, "Set WAVEX_E2E_DEMO=1 to run (takes ~60s, records video)");
  test.setTimeout(5 * 60 * 1000);
  mkdirSync(OUT_DIR, { recursive: true });

  const ctx = await browser.newContext({
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  // ── Gateway — mode selection ──────────────────────────────────────────────
  await page.goto("/onboarding-chat?t0=1");
  await expect(page.getByRole("heading", { name: /Welcome to WaveX OS/i })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2000); // hold on gateway

  // Click "Solo Founder — Build my full org"
  await page.getByRole("button", { name: /Build my full org/i }).click();

  // ── Hero input ────────────────────────────────────────────────────────────
  await expect(page.getByRole("heading", { name: /What do you want to build/i })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1200); // hold on welcome input

  const heroInput = page.getByPlaceholder(/Ask anything/i);
  await heroInput.fill("WaveX Demo Co — AI agent company OS for solopreneurs, pre-revenue, product-led growth");
  await page.waitForTimeout(800);
  await heroInput.press("Enter");

  // ── Pillar 1 confirm card ─────────────────────────────────────────────────
  await expect(page.getByRole("button", { name: /Looks right.*keep going|Update.*continue/i }))
    .toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3000); // hold — this is the money shot

  await page.getByRole("button", { name: /Looks right.*keep going|Update.*continue/i }).click();

  // ── Scope picker ──────────────────────────────────────────────────────────
  await expect(page.getByText(/Sounds like you want to focus|How big should this team be/i))
    .toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500); // hold on scope card
  await page.getByRole("button", { name: /^Continue/ }).last().click();

  // ── Pillar 3 — product stage ──────────────────────────────────────────────
  await expect(page.getByText(/Where are you in the product journey/i)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /No product yet|pre.?product|Early/i }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /^Continue/ }).last().click();

  // ── Pillar 4 — GTM ────────────────────────────────────────────────────────
  await expect(page.getByText(/How do leads come in/i)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /Inbound|content|organic/i }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /Self.?serve|PLG|product.?led/i }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /^Continue/ }).last().click();

  // ── Pillar 5 — comms ──────────────────────────────────────────────────────
  await expect(page.getByText(/How do you want your board to talk to you/i)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /^Telegram$/i }).click().catch(() => null); // default; may already be selected
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /^Continue/ }).last().click();

  // ── Connector picker ──────────────────────────────────────────────────────
  await expect(page.getByRole("button", { name: /These look right.*plug them in/i }))
    .toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000); // hold on connector card
  await page.getByRole("button", { name: /These look right.*plug them in/i }).click();

  // ── Credentials — skip all required ──────────────────────────────────────
  await expect(page.getByRole("heading", { name: /Credentials/i })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  let safety = 15;
  while (safety-- > 0) {
    const skip = page.getByRole("button", { name: /^Skip$/ }).first();
    if (!(await skip.isVisible().catch(() => false))) break;
    await skip.click();
    await page.getByRole("button", { name: /Confirm skip/i }).first().click();
    await page.waitForTimeout(200);
  }
  await page.getByRole("button", { name: /Done.*continue to swarm/i }).click();

  // ── Swarm Studio ─────────────────────────────────────────────────────────
  await expect(page.getByRole("button", { name: /These look right.*wire them up/i }))
    .toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000); // hold on swarm org chart

  await page.getByRole("button", { name: /These look right.*wire them up/i }).click();

  // ── Imprint Theater ───────────────────────────────────────────────────────
  const launch = page.getByRole("button", { name: /Let's launch/i });
  await expect(launch).toBeEnabled({ timeout: 90_000 });
  await page.waitForTimeout(2000); // hold on imprint
  await launch.click();

  // ── Pricing → Skip ────────────────────────────────────────────────────────
  const skipPricing = page.getByRole("button", { name: /Skip.*continue without subscription/i });
  if (await skipPricing.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await skipPricing.click();
  }

  // ── Mission Control ───────────────────────────────────────────────────────
  await expect(page.getByRole("button", { name: /Open Mission Control/i }))
    .toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(4000); // cinematic hold on final screen

  await ctx.close(); // finalises the video file
});
