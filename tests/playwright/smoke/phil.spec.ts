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
    if ((await jobs.count()) === 0) {
      // In strict Preview Smoke (BUHLOS_SMOKE_STRICT) the seeded fixture MUST
      // exist — no silent Phil data-skip. Locally it's allowed to skip.
      if (process.env.BUHLOS_SMOKE_STRICT) {
        throw new Error(
          "QA Field has no assigned ACTIVE job. Seed the stable fixture QA_SEED_FIELD_ACTIVE_JOB " +
            "and assign QA Field to it (docs/testing/Seeded-Authenticated-QA.md) — strict Preview " +
            "Smoke must not silently skip Phil coverage."
        );
      }
      test.skip(true, "QA field account has no assigned active jobs (local run).");
    }

    await jobs.first().click();
    await expect(page.getByTestId("phil-shell")).toBeVisible();
    await expect(page.getByRole("button", { name: /Capture evidence/i })).toBeVisible();
    await expect(page.getByText(/Save changes|Publish to field/i)).toHaveCount(0);
  });
});
