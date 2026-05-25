import { test, expect } from "@playwright/test";

/**
 * Phase D6 acceptance tests — admin jobs index surface.
 *
 * Active tests:
 *   - Route gating: unauth /v2/jobs → /v2/login with next param.
 *
 * Skipped tests document the intended authenticated flow. They unlock
 * once the CI harness wires seeded admin + LH test accounts — same
 * blocker as the Phase B / D3 / D4 authenticated suites.
 *
 * Cross-ref:
 *   src/app/v2/jobs/page.tsx
 *   src/components/admin/JobsList.tsx
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §6.2 Admin
 */

test("unauthenticated /v2/jobs redirects to /v2/login with next param", async ({ page }) => {
  const response = await page.goto("/v2/jobs", {
    waitUntil: "domcontentloaded",
  });
  expect(response).not.toBeNull();
  await expect(page).toHaveURL(/\/v2\/login\?next=%2Fv2%2Fjobs/);
});

test.describe.skip("authenticated admin jobs index (require seeded test accounts)", () => {
  test("admin sees jobs list with evidence + snags chips", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed admin login here.
    await page.goto("/v2/jobs");
    await expect(page.getByRole("heading", { name: /Jobs/i }).first()).toBeVisible();
    // Each row deep-links into the per-job evidence + snags surfaces.
    const evidenceChip = page
      .getByRole("link", { name: /pending evidence for/i })
      .first();
    await expect(evidenceChip).toBeVisible();
    await evidenceChip.click();
    await expect(page).toHaveURL(/\/v2\/jobs\/[^/]+\/evidence/);
  });

  test("search filter narrows the list", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed admin login.
    await page.goto("/v2/jobs");
    await page.getByLabel(/Filter jobs/i).fill("birdwood");
    // Birdwood IV3232 is the canonical seeded job.
    await expect(page.getByText(/Birdwood/i).first()).toBeVisible();
    await page.getByLabel(/Filter jobs/i).fill("no-such-job-zzz");
    await expect(page.getByText(/No jobs match/i)).toBeVisible();
  });

  test("LH role sees the same list (read-only enforced at child pages)", async ({
    page,
  }) => {
    await page.goto("/v2/login");
    // … seed LH login.
    await page.goto("/v2/jobs");
    // LH gets to discover the queue surfaces; the per-job page renders
    // the read-only badge instead of action buttons.
    await expect(page.getByRole("link", { name: /Open evidence for/i }).first()).toBeVisible();
  });
});
