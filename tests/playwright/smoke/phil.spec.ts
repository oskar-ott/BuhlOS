import { expect, test } from "@playwright/test";
import { loginAsField } from "../helpers/auth";
import { fieldCredentials } from "../helpers/testData";

test.describe("Phil field smoke", () => {
  test.skip(!fieldCredentials(), "Set BUHLOS_TEST_FIELD_EMAIL and BUHLOS_TEST_FIELD_PASSWORD.");

  test("field user reaches Phil, sees field navigation, and cannot enter the admin builder", async ({
    page,
  }) => {
    await loginAsField(page);
    await expect(page.getByTestId("phil-shell")).toBeVisible();
    await page.goto("/phil/jobs");
    await expect(page.getByTestId("phil-shell")).toBeVisible();
    await expect(page.getByText("Draft", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Today" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Jobs" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Gear" })).toBeVisible();

    await page.goto("/v2/jobs/not-a-real-job/builder");
    await expect(page).toHaveURL(/\/phil\/my-day(?:\?|$)/);
  });

  test("field user can open an assigned active job when the QA account has one", async ({
    page,
  }) => {
    await loginAsField(page);
    await page.goto("/phil/jobs");
    const jobs = page.locator('a[href^="/phil/jobs/"]');
    test.skip((await jobs.count()) === 0, "QA field account has no assigned active jobs.");

    await jobs.first().click();
    await expect(page.getByTestId("phil-shell")).toBeVisible();
    await expect(page.getByRole("button", { name: /Capture evidence/i })).toBeVisible();
    await expect(page.getByText(/Save changes|Publish to field/i)).toHaveCount(0);
  });
});
