import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const SHOT_DIR = "/tmp/wavex-qa-422";
mkdirSync(SHOT_DIR, { recursive: true });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });

test("WAVAAAA-422: wizard flow → Activate fleet", async ({ page }) => {
  test.setTimeout(240_000);

  const errors: string[] = [];
  const net500s: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  page.on("response", async (resp) => {
    if (resp.status() >= 500) {
      net500s.push(`${resp.request().method()} ${resp.url()} → ${resp.status()}`);
    }
  });

  // ── 1. Landing page ─────────────────────────────────────────────────
  await page.goto("/onboarding-chat?t0=1");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
  await shot(page, "01_landing");

  // If "Discard local changes" is visible, click it to start fresh
  const discardBtn = page.getByRole("button", { name: /Discard local changes/i });
  if (await discardBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await discardBtn.click();
    console.log("[setup] Discarded local changes");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => null);
    await shot(page, "01b_after_discard");
  }

  // ── 2. Account type → Solo Founder ──────────────────────────────────
  await expect(page.getByRole("button", { name: /Build my full org/i }))
    .toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Build my full org/i }).click();
  await shot(page, "02_after_solo_founder");

  // ── 3. Welcome textarea → submit ────────────────────────────────────
  const textarea = page.locator("textarea, input[type='text']").first();
  await expect(textarea).toBeVisible({ timeout: 10_000 });
  await textarea.fill(
    "B2B SaaS company for AI-assisted code review. Two founders. $50K MRR. Goal: first enterprise customer in 90 days."
  );
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => null);
  await page.waitForTimeout(2_000);
  await shot(page, "03_after_submit");

  // Helper: click the first chip in a chip group that hasn't been selected yet.
  // "Chip groups" are sets of inline-flex buttons inside a card. We identify
  // unselected chips as those that lack a visually-selected CSS class.
  async function selectFirstChipIfNeeded(page: Page): Promise<number> {
    let selected = 0;
    // Chips are <button> elements with short text (≤ 40 chars) that are NOT
    // the primary CTA (Continue / Next / etc.).
    const chipButtons = await page
      .locator("button:visible")
      .filter({ hasNotText: /continue|next|submit|reset|back|cancel|discard|launch|activate|wire|plug|done|redo|skip|help/i })
      .all();

    for (const btn of chipButtons) {
      const label = (await btn.textContent().catch(() => "")) ?? "";
      const trimmed = label.trim();
      // Only short-label chips (not nav links, not long descriptions)
      if (trimmed.length === 0 || trimmed.length > 50) continue;
      // Check if the button is inside an active/selected state by checking aria or class
      const isSelected =
        (await btn.getAttribute("aria-pressed").catch(() => null)) === "true" ||
        (await btn.evaluate((el) => el.classList.contains("selected") || el.classList.contains("active") || el.classList.contains("chip--selected")).catch(() => false));
      if (!isSelected) {
        await btn.click().catch(() => null);
        selected++;
        await page.waitForTimeout(200);
        // Only click one chip per group to avoid over-selecting
        break;
      }
    }
    return selected;
  }

  // ── Heuristic step loop up to 45 steps ──────────────────────────────
  for (let step = 1; step <= 45; step++) {
    await page.waitForTimeout(600);
    await shot(page, `step_${String(step).padStart(2, "0")}_a`);

    // ── Check for Activate fleet button ─────────────────────────────
    const activateBtn = page.getByRole("button", { name: /Activate fleet/i });
    if (await activateBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      console.log(`[step ${step}] ✓ Found "Activate fleet" button`);
      await shot(page, `step_${String(step).padStart(2, "0")}_activate_visible`);

      // Wait up to 15s for it to become enabled
      for (let w = 0; w < 15 && !(await activateBtn.isEnabled().catch(() => false)); w++) {
        await page.waitForTimeout(1_000);
      }
      const enabled = await activateBtn.isEnabled().catch(() => false);
      console.log(`[step ${step}] Button enabled: ${enabled}`);

      await activateBtn.click();
      console.log(`[step ${step}] Clicked "Activate fleet →"`);
      await page.waitForLoadState("networkidle", { timeout: 90_000 }).catch(() => null);
      await page.waitForTimeout(5_000);
      await shot(page, `step_${String(step).padStart(2, "0")}_after_activate`);

      const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? "";
      const successMatch = bodyText.match(/Activated[^.]*(?:written to db|agents)/i);
      const openMC = await page.getByRole("button", { name: /Open Mission Control/i }).isVisible().catch(() => false);
      const activateFailed = /Activation failed/i.test(bodyText);

      console.log("=== ACTIVATE RESULT ===");
      console.log(`Success text: ${successMatch?.[0] ?? "none"}`);
      console.log(`Open Mission Control visible: ${openMC}`);
      console.log(`Activation failed: ${activateFailed}`);
      console.log(`500 errors: ${JSON.stringify(net500s)}`);
      console.log(`JS errors: ${JSON.stringify(errors)}`);
      console.log("======================");

      if (activateFailed) {
        console.log("VERDICT: NO-GO — activation failed");
        throw new Error(`Activation failed. Body snippet: ${bodyText.slice(0, 300)}`);
      }

      await expect(
        page.getByText(/Activated.*agents/i).or(
          page.getByRole("button", { name: /Open Mission Control/i })
        )
      ).toBeVisible({ timeout: 30_000 });

      console.log("VERDICT: GO ✓");
      return;
    }

    // ── Fill empty text inputs / textareas ──────────────────────────
    const inputs = await page.locator("input[type='text']:visible, textarea:visible").all();
    for (const inp of inputs) {
      const val = await inp.inputValue().catch(() => "");
      if (val) continue;
      const ph = ((await inp.getAttribute("placeholder").catch(() => "")) ?? "").toLowerCase();
      let v = "QA Test";
      if (/email/.test(ph)) v = "qa@wavex-test.local";
      else if (/url|website|domain/.test(ph)) v = "https://example.com";
      else if (/context|describe|tell|paste/.test(ph))
        v = "SaaS for AI code review. $50K MRR. 90-day goal: first enterprise customer.";
      await inp.fill(v).catch(() => null);
    }

    // ── Find advance button ──────────────────────────────────────────
    const nextBtn = page
      .locator("button:visible")
      .filter({
        hasText: /continue|next|submit|looks right|these look right|done.*continue|launch|wire them up|plug them in|finish|→/i,
      })
      .filter({ hasNotText: /reset|back|cancel|discard|choose|avatar|hybrid|builder/i })
      .last();

    const visible = await nextBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!visible) {
      console.log(`[step ${step}] No advance button — halting`);
      const bodyText = await page.locator("body").textContent().catch(() => "");
      console.log(`Page text: ${bodyText?.slice(0, 300)}`);
      break;
    }

    // If button is disabled, try selecting chips first
    if (!(await nextBtn.isEnabled().catch(() => false))) {
      // Try clicking the first unselected chip in any visible chip group
      // For multi-select groups, click more chips until Continue enables
      let tries = 0;
      while (tries < 15 && !(await nextBtn.isEnabled().catch(() => false))) {
        // Click ALL unselected chips in the current card (some groups require multiple)
        const chipBtns = await page
          .locator("button:visible")
          .filter({ hasNotText: /continue|next|submit|reset|back|cancel|discard|launch|activate|wire|plug|done|redo|skip|help|build|avatar|hybrid|choose/i })
          .all();

        let clicked = 0;
        for (const btn of chipBtns) {
          const lbl = ((await btn.textContent().catch(() => "")) ?? "").trim();
          if (lbl.length === 0 || lbl.length > 50) continue;
          const isSelected = await btn.evaluate((el) =>
            el.classList.contains("selected") ||
            el.classList.contains("active") ||
            el.classList.contains("chip--selected") ||
            el.getAttribute("aria-pressed") === "true" ||
            el.getAttribute("data-selected") === "true" ||
            window.getComputedStyle(el).borderColor === "rgb(97, 218, 251)" || // teal border = selected
            window.getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)"
          ).catch(() => false);

          if (!isSelected) {
            await btn.click().catch(() => null);
            clicked++;
            await page.waitForTimeout(150);
            // After clicking the first chip in a group, check if Continue enables
            if (await nextBtn.isEnabled().catch(() => false)) break;
          }
        }
        if (clicked === 0) break; // no more chips to click
        tries++;
      }
    }

    if (!(await nextBtn.isEnabled().catch(() => false))) {
      const lbl = (await nextBtn.textContent().catch(() => "")) ?? "";
      console.log(`[step ${step}] "${lbl.trim()}" still disabled after chip selection`);
      await shot(page, `step_${String(step).padStart(2, "0")}_blocked`);

      // Wait longer (async T2 call may be in flight)
      let unblocked = false;
      for (let w = 0; w < 6; w++) {
        await page.waitForTimeout(5_000);
        if (await nextBtn.isEnabled().catch(() => false)) { unblocked = true; break; }
      }
      if (!unblocked) {
        console.log(`[step ${step}] Still blocked after 30s`);
        break;
      }
    }

    const label = (await nextBtn.textContent().catch(() => "")) ?? "";
    await nextBtn.click();
    console.log(`[step ${step}] Clicked "${label.trim()}"`);
    await page.waitForLoadState("networkidle", { timeout: 90_000 }).catch(() => null);
  }

  // Report if we didn't reach Activate fleet
  await shot(page, "99_final");
  const finalText = await page.locator("body").textContent().catch(() => "");
  console.log(`NEVER REACHED "Activate fleet". Final URL: ${page.url()}`);
  console.log(`Final text: ${finalText?.slice(0, 400)}`);
  console.log(`500 errors: ${JSON.stringify(net500s)}`);
  console.log(`JS errors: ${JSON.stringify(errors)}`);
  throw new Error(`Did not reach Activate fleet. Final URL: ${page.url()}`);
});
