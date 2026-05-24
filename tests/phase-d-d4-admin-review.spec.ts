import { test, expect } from "@playwright/test";

/**
 * Phase D4 acceptance tests — admin evidence review surface.
 *
 * Active tests:
 *   - Route gating: unauth → /v2/login with next param.
 *
 * Skipped tests document the intended authenticated review flow.
 * They unlock once the CI harness wires seeded admin + LH test
 * accounts — same blocker as the Phase B + D3 authenticated suites.
 *
 * Cross-ref:
 *   docs/rebuild-audit/30-phase-d4-admin-evidence-review-spec.md §11 Acceptance
 *   docs/rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md §C.7 Tests
 *   docs/rebuild-audit/26-phase-d-testing-checklist.md §B.4
 */

test("unauthenticated /v2/jobs/[jobId]/evidence redirects to /v2/login", async ({ page }) => {
  const response = await page.goto("/v2/jobs/birdwood-iv3232/evidence", {
    waitUntil: "domcontentloaded",
  });
  expect(response).not.toBeNull();
  await expect(page).toHaveURL(
    /\/v2\/login\?next=%2Fv2%2Fjobs%2Fbirdwood-iv3232%2Fevidence/
  );
});

test("unauthenticated /v2/jobs (root) redirects to /v2/login", async ({ page }) => {
  // Defensive: catches matcher regressions where the /v2/jobs prefix is
  // mis-claimed by middleware.
  await page.goto("/v2/jobs/anything/evidence", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/v2\/login(\?|$)/);
});

test.describe.skip("authenticated review flows (require seeded test accounts)", () => {
  test("admin marks an evidence item reviewed", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed admin login here.
    await page.goto("/v2/jobs/birdwood-iv3232/evidence");
    await expect(page.getByRole("heading", { name: /Evidence review/i })).toBeVisible();
    // First Review button in the queue.
    await page.getByRole("button", { name: /Review$/i }).first().click();
    await expect(page.getByText(/Reviewed —/)).toBeVisible();
  });

  test("admin rejects with reason; modal blocks empty reason", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed admin login.
    await page.goto("/v2/jobs/birdwood-iv3232/evidence");
    await page.getByRole("button", { name: /Reject$/i }).first().click();
    await expect(page.getByRole("dialog", { name: /Reject/i })).toBeVisible();
    // Submit blocked while reason is empty.
    await expect(page.getByRole("button", { name: /Reject with reason/i })).toBeDisabled();
    await page.getByLabel(/Reason/).fill(`TEST D4 Review ${new Date().toISOString()}`);
    await page.getByRole("button", { name: /Reject with reason/i }).click();
    await expect(page.getByText(/Rejected with reason/)).toBeVisible();
  });

  test("bulk Mark N reviewed flips N rows", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed admin login on a job with ≥ 2 submitted captures.
    await page.goto("/v2/jobs/birdwood-iv3232/evidence");
    const checkboxes = page.getByRole("checkbox", { name: /Select .* captured/ });
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    await page.getByRole("button", { name: /Mark 2 reviewed/i }).click();
    await expect(page.getByText(/Marked 2 reviewed/)).toBeVisible();
  });

  test("filter to status=Reviewed hides submitted rows", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed admin login.
    await page.goto("/v2/jobs/birdwood-iv3232/evidence");
    await page.getByLabel("Status").selectOption("reviewed");
    await expect(page.getByText(/Submitted/).first()).toHaveCount(0);
  });

  test("LH sees rows but no Mark reviewed / Reject buttons", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed LH login.
    await page.goto("/v2/jobs/birdwood-iv3232/evidence");
    await expect(page.getByText(/Read-only — leading hand/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Review$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Reject$/i })).toHaveCount(0);
  });

  test("drawer opens with full photo + note + status + history-UC", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed admin login.
    await page.goto("/v2/jobs/birdwood-iv3232/evidence");
    await page.getByRole("button", { name: /Photo|Note/i }).first().click();
    await expect(page.getByRole("dialog", { name: /Evidence detail/i })).toBeVisible();
    // History section renders the UC placeholder until audit-log read endpoint ships.
    await expect(page.getByText(/audit-log read endpoint ships/)).toBeVisible();
  });
});
