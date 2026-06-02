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
    const fixtureName = "QA_SEED_FIELD_ACTIVE_JOB";
    const jobs = page.locator('a[href^="/phil/jobs/"]');
    // EXACT accessible-name match. The Phil job link is aria-label="Open <name>"
    // (src/components/phil/PhilJobsList.tsx), so { exact: true } means a substring
    // look-alike like "QA_SEED_FIELD_ACTIVE_JOB_2" ("Open …_2") does NOT satisfy
    // strict mode — only the exact fixture does.
    const fixtureLink = page.getByRole("link", { name: `Open ${fixtureName}`, exact: true });

    if (process.env.BUHLOS_SMOKE_STRICT) {
      // Strict Preview Smoke is deterministic: the EXACT named fixture must be
      // present + active + assigned to QA Field — not "any job happens to exist"
      // (which could otherwise pass against an incidental production-style job).
      await expect(
        fixtureLink,
        `Strict Preview Smoke requires the exact seeded fixture "${fixtureName}" active + assigned to QA Field (docs/testing/Seeded-Authenticated-QA.md).`
      ).toHaveCount(1);
      await fixtureLink.first().click();
    } else if ((await fixtureLink.count()) > 0) {
      await fixtureLink.first().click();
    } else if ((await jobs.count()) > 0) {
      // Local non-strict runs may be more permissive: open any assigned job.
      await jobs.first().click();
    } else {
      test.skip(true, "QA field account has no assigned active job (local run).");
    }
    await expect(page.getByTestId("phil-shell")).toBeVisible();
    await expect(page.getByRole("button", { name: /Capture evidence/i })).toBeVisible();
    await expect(page.getByText(/Save changes|Publish to field/i)).toHaveCount(0);
  });
});
