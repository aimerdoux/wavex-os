import { expect, test } from "@playwright/test";

test("onboarding wizard updates the browser tab title for the active step", async ({ page }) => {
  await page.route("**/api/users/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        user: {
          id: "user-title-regression",
          email: "title@example.com",
          isNewUser: true,
          wizardStep: 1,
          wizardRepo: null,
          wizardCompletedAt: null,
        },
      }),
    });
  });
  await page.route("**/api/github/repos?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ repos: [], total: 0, page: 1, per_page: 30, mock: true }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Connect your repo/i })).toBeVisible();
  await expect(page).toHaveTitle("WaveX OS — Connect your repo");
});
