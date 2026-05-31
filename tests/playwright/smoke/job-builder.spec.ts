import { expect, test } from "@playwright/test";
import { loginAsAdmin, parkJobAsDraft, waitForSavedState } from "../helpers/auth";
import { adminCredentials, createSmokeJobName } from "../helpers/testData";

test.describe("job builder lifecycle", () => {
  test.skip(!adminCredentials(), "Set BUHLOS_TEST_ADMIN_EMAIL and BUHLOS_TEST_ADMIN_PASSWORD.");

  test("admin creates, saves, previews, publishes, and parks a smoke job as Draft", async ({
    page,
  }) => {
    const jobName = createSmokeJobName();
    let builderOpened = false;

    await loginAsAdmin(page);
    await page.goto("/v2/jobs");
    await expect(page.getByTestId("jobs-new-job")).toBeVisible();
    await page.getByTestId("jobs-new-job").click();
    await page.getByTestId("job-name").fill(jobName);
    await page.getByTestId("create-draft").click();
    await expect(page).toHaveURL(/\/v2\/jobs\/[^/]+\/builder/);
    builderOpened = true;

    try {
      await expect(page.getByText(/Office-only \(not yet published\)/i)).toBeVisible();
      await page.getByTestId("builder-structure-tab").click();

      await page.getByTestId("add-rough-in-task").click();
      await page.locator('input[placeholder="Task name"]').nth(0).fill("Rough-in power circuits");
      await page.getByTestId("add-fit-off-task").click();
      await page.locator('input[placeholder="Task name"]').nth(1).fill("Fit-off power points");

      await page.getByTestId("add-group").click();
      await page.locator('input[placeholder^="Group name"]').fill("Level 1");
      await page.getByTestId("add-area").click();
      await page.locator('input[placeholder^="Area name"]').fill("Unit 1");
      await waitForSavedState(page);

      await page.reload();
      await page.getByTestId("builder-structure-tab").click();
      await expect(page.locator('input[placeholder^="Group name"]')).toHaveValue("Level 1");
      await expect(page.locator('input[placeholder^="Area name"]')).toHaveValue("Unit 1");
      await expect(page.locator('input[value="Rough-in power circuits"]')).toBeVisible();
      await expect(page.locator('input[value="Fit-off power points"]')).toBeVisible();

      await page.getByTestId("builder-phil-preview-tab").click();
      await expect(page.getByText(/Derived from the saved job structure/i)).toBeVisible();
      await expect(page.getByText(/Not a mock/i)).toBeVisible();
      await expect(page.getByText(/Rough-in power circuits/i)).toBeVisible();

      await page.getByTestId("builder-publish-tab").click();
      await expect(page.getByText(/Errors block publishing; warnings are advisory/i)).toBeVisible();
      await expect(page.getByText(/No blocking issues/i)).toBeVisible();
      await page.getByTestId("publish-to-field").click();
      await expect(page.getByText(/Visible to the field/i)).toBeVisible();
      await expect(page.getByTestId("unpublish-to-draft")).toBeVisible();
    } finally {
      if (builderOpened) await parkJobAsDraft(page);
    }
  });
});
