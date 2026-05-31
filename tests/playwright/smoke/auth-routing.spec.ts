import { expect, test } from "@playwright/test";
import {
  collectConsoleErrors,
  collectNetworkFailures,
  loginAsAdmin,
  logout,
} from "../helpers/auth";
import { adminCredentials } from "../helpers/testData";

test("unauthenticated users are redirected from protected BuhlOS routes", async ({ page }) => {
  await page.goto("/command-centre");
  await expect(page).toHaveURL(/\/v2\/login\?next=%2Fcommand-centre/);
  await expect(page.getByTestId("login-submit")).toBeVisible();
});

test.describe("authenticated admin routing", () => {
  test.skip(!adminCredentials(), "Set BUHLOS_TEST_ADMIN_EMAIL and BUHLOS_TEST_ADMIN_PASSWORD.");

  test("admin reaches the BuhlOS shell and jobs list without obvious runtime failures", async ({
    page,
  }) => {
    const consoleErrors = collectConsoleErrors(page);
    const networkFailures = collectNetworkFailures(page);
    await loginAsAdmin(page);
    await expect(page.getByTestId("buhlos-admin-shell")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "BuhlOS admin" })).toBeVisible();
    await expect(page.getByText("BuhlOS", { exact: true })).toBeVisible();
    await expect(page.locator(".nav-pill")).toHaveCount(0);

    await page.goto("/v2/jobs");
    await expect(page.getByTestId("buhlos-admin-shell")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
    expect(consoleErrors).toEqual([]);
    expect(networkFailures).toEqual([]);
  });

  test("admin is redirected away from Phil and logout preserves a clean login state", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto("/phil/jobs");
    await expect(page).toHaveURL(/\/command-centre(?:\?|$)/);
    await logout(page);
    await expect(page.getByTestId("login-username")).toBeVisible();
    await loginAsAdmin(page);
    await expect(page.getByTestId("buhlos-admin-shell")).toBeVisible();
  });
});
