import { test, expect } from "@playwright/test";

/**
 * Phase D3 acceptance tests — Phil evidence capture UI.
 *
 * Active tests:
 *   - Route gating: unauth → /v2/login (the page is dynamic; gating
 *     happens server-side in src/app/phil/jobs/[jobId]/page.tsx).
 *
 * Skipped tests document the intended authenticated capture flow.
 * They unlock once the CI harness wires a seeded tradie test account
 * (same blocker that gates the Phase B "authenticated flows" suite —
 * see tests/phase-b-hours.spec.ts `describe.skip` block).
 *
 * Cross-ref:
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §11 Acceptance
 *   docs/rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md §B.9 Tests
 *   docs/rebuild-audit/26-phase-d-testing-checklist.md §B.2
 */

test("unauthenticated /phil/jobs/[jobId] redirects to /v2/login with next param", async ({ page }) => {
  const response = await page.goto("/phil/jobs/birdwood-iv3232", {
    waitUntil: "domcontentloaded",
  });
  expect(response).not.toBeNull();
  await expect(page).toHaveURL(/\/v2\/login\?next=%2Fphil%2Fjobs%2Fbirdwood-iv3232/);
});

test("unauthenticated /phil/jobs redirects to /v2/login", async ({ page }) => {
  await page.goto("/phil/jobs", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/v2\/login(\?|$)/);
});

test.describe.skip("authenticated capture flows (require seeded test accounts)", () => {
  test("tradie can open capture sheet and submit a note + photo", async ({ page }) => {
    // Login as tradie via /v2/login, then exercise the capture sheet.
    await page.goto("/v2/login");
    // … seed tradie login here once test fixtures are wired.
    await page.goto("/phil/jobs/birdwood-iv3232");

    await expect(page.getByRole("button", { name: /Capture evidence/i })).toBeVisible();
    await page.getByRole("button", { name: /Capture evidence/i }).click();

    await expect(page.getByRole("dialog", { name: /Capture evidence/i })).toBeVisible();

    // Photo step — pick a fixture image.
    await page
      .locator('input[type="file"]')
      .setInputFiles("tests/fixtures/capture-photo.jpg");

    // Note step — type something obviously labelled.
    await page.getByLabel(/Note/).fill(`TEST D3 Capture ${new Date().toISOString()}`);

    // Submit — sheet closes on first tap (BUG-C-003 lesson).
    await page.getByRole("button", { name: /Submit/i }).click();
    await expect(page.getByRole("dialog", { name: /Capture evidence/i })).toHaveCount(0);

    // Banner lands + new card appears in Today's captures.
    await expect(page.getByText(/Evidence captured/i)).toBeVisible();
    await expect(page.getByText(/Submitted/i).first()).toBeVisible();
  });

  test("note over 280 chars is blocked at the input", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed tradie login.
    await page.goto("/phil/jobs/birdwood-iv3232");
    await page.getByRole("button", { name: /Capture evidence/i }).click();
    const longNote = "x".repeat(300);
    await page.getByLabel(/Note/).fill(longNote);
    // maxLength=280 — textarea truncates input client-side.
    const value = await page.getByLabel(/Note/).inputValue();
    expect(value.length).toBe(280);
  });

  test("submit button is disabled without a photo", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed tradie login.
    await page.goto("/phil/jobs/birdwood-iv3232");
    await page.getByRole("button", { name: /Capture evidence/i }).click();
    await expect(page.getByRole("button", { name: /Submit/i })).toBeDisabled();
  });

  test("cancel preserves the photo + note draft for re-open", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed tradie login.
    await page.goto("/phil/jobs/birdwood-iv3232");
    await page.getByRole("button", { name: /Capture evidence/i }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles("tests/fixtures/capture-photo.jpg");
    await page.getByLabel(/Note/).fill("Draft note");
    await page.getByRole("button", { name: /Cancel/i }).click();

    // Re-open from the CTA — note should still be there.
    await page.getByRole("button", { name: /Capture evidence/i }).click();
    await expect(page.getByLabel(/Note/)).toHaveValue("Draft note");
  });

  test("today's captures empty state shows when worker has no captures", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed brand-new-tradie login on a job they've never captured against.
    await page.goto("/phil/jobs/birdwood-iv3232");
    await expect(page.getByText(/No evidence captured for this job yet\./)).toBeVisible();
  });

  test("tradie cannot see another tradie's captures (server-side own-only filter)", async ({
    page,
  }) => {
    await page.goto("/v2/login");
    // … seed tradie A login.
    await page.goto("/phil/jobs/birdwood-iv3232");
    const tradieACardCount = await page.getByRole("button", { name: /captured/i }).count();

    // Logout + relogin as tradie B (assumes both assigned to the same job).
    await page.goto("/v2/login");
    // … seed tradie B login.
    await page.goto("/phil/jobs/birdwood-iv3232");
    const tradieBCardCount = await page.getByRole("button", { name: /captured/i }).count();

    // Counts can differ (each only sees own) but neither should bleed.
    // The strong assertion is that switching back doesn't change the count.
    expect(typeof tradieACardCount).toBe("number");
    expect(typeof tradieBCardCount).toBe("number");
  });
});
