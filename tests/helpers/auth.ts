import { expect, type Page } from "@playwright/test";

/**
 * Real login helper for authenticated E2E flows.
 *
 * There is NO test backdoor and NO hardcoded secret here. Each role's
 * credentials are read from the environment at run time:
 *
 *   tradie       → E2E_TRADIE_USER / E2E_TRADIE_PIN
 *   admin        → E2E_ADMIN_USER  / E2E_ADMIN_PIN
 *   leadingHand  → E2E_LH_USER     / E2E_LH_PIN
 *
 * Provision the matching accounts with `scripts/seed-qa-accounts.js` against a
 * PREVIEW / staging Blob store (never production), then export the same
 * credentials before running Playwright. When the env vars are absent the
 * authenticated specs skip themselves (see qaCredsConfigured) instead of
 * failing — so CI stays green until the seed is wired.
 *
 * Login goes through the real /v2/login form, which POSTs { username, secret }
 * to /api/auth?action=login (src/app/v2/login/login-form.tsx, api/auth.js).
 * Because api/*.js only runs on a Vercel deploy — not under `next dev` — point
 * PLAYWRIGHT_BASE_URL at a preview URL for these flows.
 */

export type QaRole = "tradie" | "admin" | "leadingHand";

const ENV_KEYS: Record<QaRole, { user: string; pin: string }> = {
  tradie: { user: "E2E_TRADIE_USER", pin: "E2E_TRADIE_PIN" },
  admin: { user: "E2E_ADMIN_USER", pin: "E2E_ADMIN_PIN" },
  leadingHand: { user: "E2E_LH_USER", pin: "E2E_LH_PIN" },
};

export function credsFor(role: QaRole): { username: string; secret: string } | null {
  const keys = ENV_KEYS[role];
  const username = process.env[keys.user];
  const secret = process.env[keys.pin];
  if (!username || !secret) return null;
  return { username, secret };
}

/** True only when every listed role has both env vars set. */
export function qaCredsConfigured(roles: ReadonlyArray<QaRole>): boolean {
  return roles.every((r) => credsFor(r) !== null);
}

/** The env vars still missing for the given roles — used in skip messages. */
export function missingCredEnv(roles: ReadonlyArray<QaRole>): string[] {
  const missing: string[] = [];
  for (const r of roles) {
    const keys = ENV_KEYS[r];
    if (!process.env[keys.user]) missing.push(keys.user);
    if (!process.env[keys.pin]) missing.push(keys.pin);
  }
  return missing;
}

/**
 * Log in through the real /v2/login form and wait for the post-login redirect
 * away from the login screen. Throws if creds are missing — guard the call
 * site with qaCredsConfigured() / test.skip() first.
 */
export async function loginAs(page: Page, role: QaRole): Promise<void> {
  const creds = credsFor(role);
  if (!creds) {
    throw new Error(
      `Missing E2E credentials for "${role}" — set ${ENV_KEYS[role].user} and ${ENV_KEYS[role].pin}.`
    );
  }
  await page.goto("/v2/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel(/Email or username/i).fill(creds.username);
  await page.getByLabel(/Password or PIN/i).fill(creds.secret);
  await page.getByRole("button", { name: /Sign in/i }).click();
  // The form hard-navigates on success; wait until we've left the login route.
  await expect(page).not.toHaveURL(/\/v2\/login/, { timeout: 15_000 });
}
