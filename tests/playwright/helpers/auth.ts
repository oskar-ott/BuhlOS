import { expect, type Page } from "@playwright/test";
import { adminCredentials, fieldCredentials, type TestCredentials } from "./testData";

/**
 * Log in at /v2/login and assert the role landed on the EXPECTED surface, with
 * diagnostics that distinguish the three failure modes seeded-QA cares about
 * (docs/testing/Seeded-Authenticated-QA.md):
 *   - missing credentials  → thrown by the caller before we reach here
 *   - bad credentials      → still on /v2/login after submit
 *   - wrong role / surface → authenticated, but landed somewhere else
 * Never logs the password value.
 */
async function loginExpectingSurface(
  page: Page,
  creds: TestCredentials,
  label: string,
  envPrefix: string,
  expected: RegExp,
  surfaceName: string
) {
  await page.goto("/v2/login");
  await page.getByTestId("login-username").fill(creds.username);
  await page.getByTestId("login-password").fill(creds.password);
  await page.getByTestId("login-submit").click();
  // Wait for the post-login redirect to leave the login page (or time out).
  await page
    .waitForURL((url) => !/\/v2\/login(?:\?|$)/.test(new URL(url).pathname), { timeout: 15_000 })
    .catch(() => {});
  const path = new URL(page.url()).pathname;
  if (/^\/v2\/login(?:\/|$)/.test(path)) {
    throw new Error(
      `${label} login REJECTED: still on /v2/login after submit — ${envPrefix}_EMAIL / ` +
        `${envPrefix}_PASSWORD do not match a valid account (bad credentials). Point them at a ` +
        `dedicated QA ${surfaceName} account (docs/testing/Seeded-Authenticated-QA.md).`
    );
  }
  if (!expected.test(path)) {
    throw new Error(
      `${label} login landed on "${path}", expected ${surfaceName}. The account authenticated ` +
        `but its ROLE does not grant ${surfaceName} access (wrong role / wrong surface). Use a ` +
        `dedicated QA ${surfaceName} account for ${envPrefix}_*.`
    );
  }
}

export async function loginAsAdmin(page: Page) {
  const creds = adminCredentials();
  if (!creds) {
    throw new Error(
      "Admin smoke credentials are not configured — set BUHLOS_TEST_ADMIN_EMAIL and BUHLOS_TEST_ADMIN_PASSWORD."
    );
  }
  await loginExpectingSurface(
    page,
    creds,
    "Admin",
    "BUHLOS_TEST_ADMIN",
    /^\/command-centre(?:\/|$)/,
    "BuhlOS admin (/command-centre)"
  );
}

export async function loginAsField(page: Page) {
  const creds = fieldCredentials();
  if (!creds) {
    throw new Error(
      "Field smoke credentials are not configured — set BUHLOS_TEST_FIELD_EMAIL and BUHLOS_TEST_FIELD_PASSWORD."
    );
  }
  await loginExpectingSurface(
    page,
    creds,
    "Field",
    "BUHLOS_TEST_FIELD",
    /^\/phil\/my-day(?:\/|$)/,
    "Phil field (/phil/my-day)"
  );
}

export async function logout(page: Page) {
  await page.getByTestId("logout").click();
  await expect(page).toHaveURL(/\/v2\/login(?:\?|$)/);
}

export async function waitForSavedState(page: Page) {
  await expect(page.getByTestId("save-state")).toHaveText(/Unsaved changes/i);
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/jobs") && response.request().method() === "PUT" && response.ok(),
    // A cold preview deployment can take well over 10s to return the save PUT,
    // so give it a generous ceiling — a cold serverless start shouldn't flake
    // the save step.
    { timeout: 30_000 }
  );
  await page.getByTestId("save-changes").click();
  await saved;
  await expect(page.getByTestId("save-state")).toHaveText(/All changes saved/i);
}

export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

export function collectNetworkFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "";
    // net::ERR_ABORTED is a cancellation, not a failure: the Next.js App Router
    // aborts in-flight RSC prefetches on navigation, and Vercel preview
    // protection (/.well-known/vercel/jwe) + service-worker probes abort
    // routinely. Don't treat those as runtime failures — genuine transport
    // failures (DNS / connection / TLS) and >=500 responses are still collected.
    if (errorText.includes("ERR_ABORTED")) return;
    failures.push(`${request.method()} ${request.url()} ${errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return failures;
}

export async function parkJobAsDraft(page: Page) {
  await page.getByTestId("builder-publish-tab").click();
  const unpublish = page.getByTestId("unpublish-to-draft");
  if (await unpublish.isVisible().catch(() => false)) {
    const parked = page.waitForResponse(
      (response) =>
        response.url().includes("/api/jobs") &&
        response.request().method() === "PUT" &&
        response.ok()
    );
    await unpublish.click();
    await parked;
  }
  await expect(page.getByText(/Office-only \(not yet published\)/i)).toBeVisible();
}
