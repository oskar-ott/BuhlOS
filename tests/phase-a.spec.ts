import { test, expect } from "@playwright/test";

/**
 * Phase A acceptance tests.
 *
 * Per docs/rebuild-audit/08-next-claude-code-prompt.md §H:
 *   1. Unauthenticated GET /v2/phil → redirect to /v2/login
 *      (the audit spec used "/" but in dev that's still rewritten to legacy
 *       login.html via vercel.json so we exercise a Next.js-owned route.)
 *   2. /v2/login renders the new sign-in form.
 *   3. /command-centre is gated — unauthenticated visitors are bounced.
 *
 * Authenticated flows (admin → /command-centre, tradie → /v2/phil) are
 * deferred until Phase B has real test fixtures; Phase A only verifies
 * the public surfaces and gating.
 */

test("unauthenticated /v2/phil redirects to /v2/login", async ({ page }) => {
  const response = await page.goto("/v2/phil", { waitUntil: "domcontentloaded" });
  expect(response).not.toBeNull();
  await expect(page).toHaveURL(/\/v2\/login(\?|$)/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("/v2/login renders the new sign-in form", async ({ page }) => {
  await page.goto("/v2/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email or username")).toBeVisible();
  await expect(page.getByLabel("Password or PIN")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("unauthenticated /command-centre redirects to /v2/login", async ({ page }) => {
  await page.goto("/command-centre", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/v2\/login(\?|$)/);
});

test("demo-mode banner is NOT visible on /v2/login (Phase B real wiring)", async ({ page }) => {
  // Updated post-Phase-B-hardening: src/lib/flags.ts fixtures.isDemoMode()
  // now returns false because the timesheets domain wires real
  // /api/time-entries* endpoints. The banner was misleading workers into
  // thinking their real submissions were demo data.
  await page.goto("/v2/login");
  await expect(page.getByText(/Demo mode/i)).toHaveCount(0);
});
