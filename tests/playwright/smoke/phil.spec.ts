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

  test("field user can open the global Capture launcher from the bottom nav", async ({
    page,
  }) => {
    await loginAsField(page);
    await expect(page.getByTestId("phil-shell")).toBeVisible();

    // The centre Capture FAB is the universal field action — present on every
    // Phil screen (src/components/phil/PhilTabBar.tsx), aria-label="Capture".
    const fab = page.getByRole("button", { name: "Capture", exact: true });
    await expect(fab).toBeVisible();
    await fab.click();

    // Tapping it opens the camera-first capture launcher (the same tap fires
    // the hidden camera input — headless browsers don't open an OS picker, so
    // the sheet shows its empty-tray state). READ-ONLY: the launcher only
    // lists the worker's jobs (GET /api/jobs); it never uploads a photo or
    // writes anything, so it is safe to run against a (possibly
    // production-shared) preview Blob — nothing is mutated.
    const launcher = page.getByRole("dialog", { name: "Capture", exact: true });
    await expect(launcher).toBeVisible();
    // The tray's camera affordance is always the lead element of an empty
    // sheet; the destination step ("Where does this go?") must NOT exist
    // until a photo is actually in the tray.
    await expect(launcher.getByText("Take a photo", { exact: true })).toBeVisible();
    await expect(launcher.getByText("Where does this go?")).toHaveCount(0);
    // No-photo logging resolves honestly: the log-something entry, an explicit
    // no-jobs state, or the loading line. Never a fabricated confirmation.
    await expect(
      launcher.getByText(
        /Log something without a photo|No jobs assigned|Loading your jobs/i
      )
    ).toBeVisible();

    // Esc closes the launcher without writing anything.
    await page.keyboard.press("Escape");
    await expect(launcher).toBeHidden();
  });

  test("tapping a week-strip day preselects that date in the hours form", async ({
    page,
  }) => {
    await loginAsField(page);
    await page.goto("/phil/my-day");
    await expect(page.getByTestId("phil-shell")).toBeVisible();

    // The "This week" strip links today + past days to ?fixDate=<date>
    // (src/components/phil/PhilWeekStrip.tsx). The FIRST such link in DOM
    // order is Monday — always today-or-past, so always present. READ-ONLY:
    // this clicks a link and reads the date input; nothing is submitted.
    const dayLink = page.locator('a[href*="/phil/my-day?fixDate="]').first();
    await expect(dayLink).toBeVisible();
    const href = await dayLink.getAttribute("href");
    const date = href?.split("fixDate=")[1] ?? "";
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await dayLink.click();
    await expect(page).toHaveURL(new RegExp(`fixDate=${date}`));
    // The regression this guards: a SAME-PAGE soft navigation must actually
    // move the form's date. The sheet seeds its date in a useState initialiser,
    // so without the key={fixDate} remount on the page, React keeps the old
    // instance and the tap changes the URL but not the form (the date input is
    // the same selector the field-readiness helper drives).
    await expect(page.locator('input[type="date"]')).toHaveValue(date);
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
    await expect(page.getByText(/Save changes|Publish to field/i)).toHaveCount(0);

    // The basic job view (2026-08 job-page rebuild): the job screen is just
    // the facts — hero (name + status pill) and, when the job has site
    // context, the Site details reference card. The former work/capture/
    // tags/ITP sections must leave NO trace beyond the labelled coming-soon
    // room placeholders. (Site details isn't asserted — the seeded fixture
    // may carry no site fields, and the card honestly hides itself then.)
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Capture evidence/i })).toHaveCount(0);
    await expect(page.getByTestId("open-tag-register")).toHaveCount(0);
  });
});
