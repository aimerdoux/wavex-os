/**
 * Focused Playwright spec: navigate to seeded company → Activate fleet
 * Company b2b-saas-company has all phases seeded via API.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOT_DIR = "/tmp/wavex-qa-422-activate";
mkdirSync(SHOT_DIR, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });

const COMPANY_ID = "b2b-saas-company";

test("QA-422: navigate seeded company → Activate fleet", async ({ page }) => {
  test.setTimeout(120_000);

  const errors: string[] = [];
  const net500s: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("response", async (resp) => {
    if (resp.status() >= 500) {
      net500s.push(`${resp.request().method()} ${resp.url()} → ${resp.status()}`);
    }
  });

  // Navigate to the seeded company with t0 fast mode
  await page.goto(`/onboarding-chat?companyId=${COMPANY_ID}&t0=1`);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
  await shot(page, "01_initial");

  console.log(`URL: ${page.url()}`);
  const bodyText1 = await page.locator("body").textContent().catch(() => "");
  console.log(`Page text preview: ${bodyText1?.slice(0, 300)}`);

  // Look for Activate fleet button directly
  const activateBtn = page.getByRole("button", { name: /Activate fleet/i });
  const activateVisible = await activateBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  console.log(`Activate fleet visible immediately: ${activateVisible}`);

  if (!activateVisible) {
    // Try navigating to the finalize/activation view
    // Check if there's a phase nav we can use
    const finalizeBtn = page.getByRole("button", { name: /^Finalize$/i });
    const finalizePhaseBtnVisible = await finalizeBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    console.log(`Finalize phase button visible: ${finalizePhaseBtnVisible}`);
    await shot(page, "02_before_navigate");

    // Try the direct finalize URL
    await page.goto(`/onboarding-chat?companyId=${COMPANY_ID}&t0=1&phase=finalize`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
    await shot(page, "03_finalize_url");
    console.log(`After finalize URL: ${page.url()}`);
  }

  await shot(page, "04_state");
  const bodyText2 = await page.locator("body").textContent().catch(() => "");
  console.log(`Page text after navigate: ${bodyText2?.slice(0, 500)}`);

  // Look for any phase nav buttons
  const phaseNav = await page.locator("button:visible").filter({ hasText: /finalize|activate|swarm|workflow|connector/i }).all();
  for (const btn of phaseNav) {
    const label = await btn.textContent().catch(() => "");
    console.log(`Phase nav button: "${label?.trim()}"`);
  }

  // Try clicking Finalize in phase nav if visible
  const finalizeNavBtn = page.locator("button").filter({ hasText: /^Finalize$/i }).first();
  if (await finalizeNavBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    console.log("Clicking Finalize phase nav button");
    await finalizeNavBtn.click();
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
    await shot(page, "05_after_finalize_nav");
  }

  // Final check for Activate fleet
  const activateFinal = page.getByRole("button", { name: /Activate fleet/i });
  const activateFinalVisible = await activateFinal.isVisible({ timeout: 10_000 }).catch(() => false);
  console.log(`Activate fleet visible after navigation: ${activateFinalVisible}`);
  await shot(page, "06_activate_check");

  if (activateFinalVisible) {
    // Wait up to 20s for it to become enabled
    for (let w = 0; w < 20; w++) {
      if (await activateFinal.isEnabled().catch(() => false)) break;
      await page.waitForTimeout(1_000);
    }
    const enabled = await activateFinal.isEnabled().catch(() => false);
    console.log(`Activate fleet enabled: ${enabled}`);

    await activateFinal.click();
    console.log("Clicked Activate fleet →");
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => null);
    await page.waitForTimeout(5_000);
    await shot(page, "07_after_activate");

    const afterText = (await page.locator("body").textContent().catch(() => "")) ?? "";
    const successMatch = afterText.match(/Activated[^.]*(?:written to db|agents)/i);
    const openMC = await page.getByRole("button", { name: /Open Mission Control/i }).isVisible().catch(() => false);
    const activateFailed = /Activation failed/i.test(afterText);

    console.log("=== ACTIVATE RESULT ===");
    console.log(`Success text: ${successMatch?.[0] ?? "none"}`);
    console.log(`Open Mission Control visible: ${openMC}`);
    console.log(`Activation failed: ${activateFailed}`);
    console.log(`500 errors: ${JSON.stringify(net500s)}`);
    console.log(`JS errors: ${JSON.stringify(errors)}`);
    console.log("======================");

    if (activateFailed) {
      throw new Error(`Activation failed. Body: ${afterText.slice(0, 400)}`);
    }

    await expect(
      page.getByText(/Activated.*agents/i).or(
        page.getByRole("button", { name: /Open Mission Control/i })
      )
    ).toBeVisible({ timeout: 30_000 });

    console.log("VERDICT: GO ✓");
  } else {
    await shot(page, "99_no_activate_btn");
    const finalText = await page.locator("body").textContent().catch(() => "");
    console.log(`VERDICT: NO-GO — Activate fleet button not found`);
    console.log(`Final page text: ${finalText?.slice(0, 500)}`);
    throw new Error(`Activate fleet button not found. URL: ${page.url()}`);
  }
});
