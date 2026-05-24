import { test, expect } from "@playwright/test";

/**
 * Phase B acceptance tests.
 *
 * Asserts the Phase B route surfaces gate correctly for unauthenticated
 * visitors and that the Standard Day button + admin queue render the right
 * labels. End-to-end submit / approve / reject flows need fixture worker /
 * admin accounts that the legacy auth seed provides; those test bodies are
 * marked .skip until the CI harness wires the seed, so they document the
 * intended assertions without flaking.
 *
 * Cross-ref: docs/rebuild-audit/19-phase-b-hours-implementation-brief.md §Tests
 *            docs/rebuild-audit/17-testing-and-quality-plan.md §B.5
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

test.describe.skip("authenticated flows (require seeded test accounts)", () => {
  test("tradie submits Standard Day in under 15 seconds", async ({ page }) => {
    // Login as tradie via /v2/login, then time the Standard Day tap.
    await page.goto("/v2/login");
    // … seed login here once test fixtures are wired.
    await page.goto("/phil/my-day");
    const start = Date.now();
    await page.getByRole("button", { name: /Standard day/i }).click();
    await expect(page.getByText(/sent for approval/i)).toBeVisible();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(15_000);
  });

  test("admin sees submitted entry in queue and approves it", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed admin login here.
    await page.goto("/hours/approvals");
    await expect(page.getByText(/Submitted entries/i)).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).first().click();
    await expect(page.getByText(/Approved/i)).toBeVisible();
  });

  test("admin rejects with reason; worker sees reason in history", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed admin login here.
    await page.goto("/hours/approvals");
    await page.getByRole("button", { name: "Reject" }).first().click();
    await page.getByLabel(/Reason/i).fill("Wrong job allocation");
    await page.getByRole("button", { name: /Reject with reason/i }).click();
    await expect(page.getByText(/Rejected/)).toBeVisible();
  });

  test("LH visibility: leading hand sees only own-crew entries", async ({ page }) => {
    await page.goto("/v2/login");
    // … seed LH login here.
    await page.goto("/hours/approvals");
    // Assert no other-LH submissions visible.
    await expect(page.getByText(/leadingHand/i)).toHaveCount(0);
  });
});
