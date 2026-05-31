import { expect, type Page } from "@playwright/test";
import { adminCredentials, fieldCredentials, type TestCredentials } from "./testData";

async function login(page: Page, creds: TestCredentials) {
  await page.goto("/v2/login");
  await page.getByTestId("login-username").fill(creds.username);
  await page.getByTestId("login-password").fill(creds.password);
  await page.getByTestId("login-submit").click();
}

export async function loginAsAdmin(page: Page) {
  const creds = adminCredentials();
  if (!creds) throw new Error("Admin smoke credentials are not configured.");
  await login(page, creds);
  await expect(page).toHaveURL(/\/command-centre(?:\?|$)/);
}

export async function loginAsField(page: Page) {
  const creds = fieldCredentials();
  if (!creds) throw new Error("Field smoke credentials are not configured.");
  await login(page, creds);
  await expect(page).toHaveURL(/\/phil\/my-day(?:\?|$)/);
}

export async function logout(page: Page) {
  await page.getByTestId("logout").click();
  await expect(page).toHaveURL(/\/v2\/login(?:\?|$)/);
}

export async function waitForSavedState(page: Page) {
  await expect(page.getByTestId("save-state")).toHaveText(/Unsaved changes/i);
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/jobs") && response.request().method() === "PUT" && response.ok()
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
    failures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`);
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
