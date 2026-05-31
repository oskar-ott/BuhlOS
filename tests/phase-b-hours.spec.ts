import { test, expect } from "@playwright/test";
import { loginAs, qaCredsConfigured, missingCredEnv, type QaRole } from "./helpers/auth";

/**
 * Phase B acceptance tests.
 *
 * The unauthenticated specs assert the route surfaces gate correctly. The
 * authenticated submit / approve / reject flows log in through the REAL
 * /v2/login form using credentials supplied via env (E2E_*_USER / *_PIN) —
 * no backdoor, no hardcoded secret. Seed the matching accounts into a preview
 * Blob store with `scripts/seed-qa-accounts.js`, then point
 * PLAYWRIGHT_BASE_URL at that preview deploy (api/*.js does not run under
 * `next dev`, so the login endpoint is only live on a deploy).
 *
 * When the env credentials are absent each authenticated test skips itself
 * with a message naming the missing vars — so the suite documents the
 * intended assertions and stays green in CI until the seed is wired, rather
 * than being unconditionally `.skip`.
 *
 * Cross-ref: docs/rebuild-audit/19-phase-b-hours-implementation-brief.md §Tests
 *            docs/rebuild-audit/17-testing-and-quality-plan.md §B.5
 *            tests/helpers/auth.ts · scripts/seed-qa-accounts.js
 */

test("unauthenticated /phil/my-day redirects to /v2/login with next param", async ({ page }) => {
  const response = await page.goto("/phil/my-day", { waitUntil: "domcontentloaded" });
  expect(response).not.toBeNull();
  await expect(page).toHaveURL(/\/v2\/login\?next=%2Fphil%2Fmy-day/);
});

test("unauthenticated /phil/hours redirects to /v2/login", async ({ page }) => {
  await page.goto("/phil/hours", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/v2\/login(\?|$)/);
});

test("unauthenticated /hours redirects to /v2/login", async ({ page }) => {
  await page.goto("/hours", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/v2\/login(\?|$)/);
});

test("unauthenticated /hours/approvals redirects to /v2/login", async ({ page }) => {
  await page.goto("/hours/approvals", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/v2\/login(\?|$)/);
});

/** Skip a test (with a precise message) when its roles aren't seeded. */
function requireRoles(roles: ReadonlyArray<QaRole>) {
  test.skip(
    !qaCredsConfigured(roles),
    `Seed QA accounts and set ${missingCredEnv(roles).join(", ")} (and PLAYWRIGHT_BASE_URL → preview) to run this flow.`
  );
}

test.describe("authenticated flows (require seeded QA accounts)", () => {
  test("tradie submits Standard Day in under 15 seconds", async ({ page }) => {
    requireRoles(["tradie"]);
    await loginAs(page, "tradie");
    await page.goto("/phil/my-day", { waitUntil: "domcontentloaded" });
    const standardDay = page.getByRole("button", { name: /^(Resubmit standard day|Standard day)$/i });
    await expect(standardDay).toBeVisible();
    const start = Date.now();
    await standardDay.click();
    await expect(page.getByText(/sent for approval|resubmitted/i)).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - start).toBeLessThan(15_000);
  });

  test("admin sees the submitted-entries queue and approves the top entry", async ({ page }) => {
    requireRoles(["admin"]);
    await loginAs(page, "admin");
    await page.goto("/hours/approvals", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/Submitted entries/i)).toBeVisible();
    const approve = page.getByRole("button", { name: /^Approve$/ }).first();
    await expect(approve).toBeVisible();
    await approve.click();
    // ActionFeedback Card (role="status") confirms the approval.
    await expect(page.getByRole("status")).toContainText(/Approved/i);
  });

  test("admin rejects with a reason via the modal", async ({ page }) => {
    requireRoles(["admin"]);
    await loginAs(page, "admin");
    await page.goto("/hours/approvals", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^Reject$/ }).first().click();
    await page.getByLabel(/Reason \(required\)/i).fill("Wrong job allocation — please reallocate.");
    await page.getByRole("button", { name: /Reject with reason/i }).click();
    await expect(page.getByRole("status")).toContainText(/Rejected/i);
  });

  test("leading hand reaches the staff hours overview", async ({ page }) => {
    requireRoles(["leadingHand"]);
    await loginAs(page, "leadingHand");
    // Staff gating must admit a leading hand to /hours (own-job scope). Full
    // cross-LH isolation needs multi-LH seed data — deferred (see report).
    const res = await page.goto("/hours", { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/v2\/login/);
  });
});
