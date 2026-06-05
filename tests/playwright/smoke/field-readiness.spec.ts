import { expect, test } from "@playwright/test";
import { loginAsAdmin, loginAsField } from "../helpers/auth";
import { adminCredentials, fieldCredentials } from "../helpers/testData";
import {
  assertFieldLockedOutOfAdminBuilder,
  assertPhilJobReadOnly,
  gotoPhilJobsAndAssertCleanList,
  openAssignedActiveJob,
  prepareAttributedStandardDay,
  submitStandardDayAndCaptureAttribution,
} from "../helpers/fieldReadiness";

/**
 * FIELD-READINESS SMOKE — the one deterministic proof of the critical
 * BuhlOS → Phil loop before controlled internal dogfood.
 *
 * It proves, end-to-end in a real browser:
 *   - the target is a guarded preview/local URL, never production;
 *   - a field worker sees ONLY assigned active work and is locked out of admin;
 *   - logging a Standard Day attaches the assigned job (never jobId:null) — the
 *     #77 attribution guarantee, asserted on the real request the UI sends;
 *   - the office can reach the Hours approvals queue where submitted hours carry
 *     job context.
 *
 * Determinism: it leans on the stable seeded fixture QA_SEED_FIELD_ACTIVE_JOB
 * and never writes to the (possibly production-shared) Blob — the hours submit
 * is asserted on the wire and aborted before it reaches the server. See
 * docs/testing/Field-Readiness-Smoke.md for what this does and does not prove.
 *
 * Viewport: runs under the default desktop-chrome project (Phil is responsive);
 * mobile-viewport Phil fidelity is owned by tests/playwright/smoke/phil.spec.ts.
 */

const PRODUCTION_HOSTS = new Set(["buhlos.com", "www.buhlos.com"]);

test.describe("Field-readiness smoke — BuhlOS → Phil critical flow", () => {
  // (URL guard) The canonical guard is scripts/qa/validate-preview-url.js, which
  // Preview Smoke runs BEFORE install (rejecting production, malformed, bad
  // ports, and look-alike hosts). This in-suite check is an additive backstop —
  // it never relaxes the canonical guard. No credentials needed, so it always
  // runs (never silently skipped).
  test("smoke target is a guarded preview/local URL, never production", () => {
    const raw = process.env.PLAYWRIGHT_BASE_URL;
    if (!raw) return; // local default is http://localhost:3000 (allowed)
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      // Malformed URLs are rejected by scripts/qa/validate-preview-url.js before
      // the suite runs; nothing to assert here.
      return;
    }
    expect(
      PRODUCTION_HOSTS.has(host),
      `Refusing to run the Field-readiness smoke against production host "${host}".`
    ).toBe(false);
  });

  test.describe("field worker (Phil)", () => {
    test.skip(
      !fieldCredentials(),
      "Set BUHLOS_TEST_FIELD_EMAIL and BUHLOS_TEST_FIELD_PASSWORD (required in Preview Smoke)."
    );

    test("sees only assigned active work and is locked out of the admin builder", async ({
      page,
    }) => {
      await loginAsField(page);
      await gotoPhilJobsAndAssertCleanList(page);

      const opened = await openAssignedActiveJob(page);
      if (!opened) {
        // Local non-strict only: no assigned active job to open. In strict
        // Preview Smoke openAssignedActiveJob() asserts the fixture and never
        // returns false, so this is never a silent CI skip.
        test.skip(true, "QA field account has no assigned active job (local run).");
        return;
      }
      await assertPhilJobReadOnly(page);
      await assertFieldLockedOutOfAdminBuilder(page);
    });

    test("logging a Standard Day attaches the assigned job (never jobId:null)", async ({
      page,
    }) => {
      await loginAsField(page);
      await prepareAttributedStandardDay(page);
      const jobId = await submitStandardDayAndCaptureAttribution(page);
      expect(
        jobId,
        "the attributed jobId must be a non-empty active assigned job id"
      ).toMatch(/.+/);
    });
  });

  test.describe("office (BuhlOS admin)", () => {
    test.skip(
      !adminCredentials(),
      "Set BUHLOS_TEST_ADMIN_EMAIL and BUHLOS_TEST_ADMIN_PASSWORD (required in Preview Smoke)."
    );

    test("reaches the Hours approvals queue where submitted hours carry job context", async ({
      page,
    }) => {
      await loginAsAdmin(page);
      await page.goto("/hours/approvals");
      await expect(page.getByTestId("buhlos-admin-shell")).toBeVisible();
      // Stable markers that the approver surface rendered (not a blank shell).
      await expect(page.getByRole("heading", { level: 1, name: /Hours · approvals/i })).toBeVisible();
      await expect(page.getByText("Submitted entries")).toBeVisible();
      // Per-entry job context (the enriched job name, or an amber
      // "No job assigned" flag for legacy/unattributed entries) is locked by
      // src/components/admin/HoursApprovalsQueue.render.test.tsx. Asserting a
      // SPECIFIC freshly-submitted entry here would require writing a time entry
      // to the (possibly production-shared) Blob — intentionally deferred to the
      // optional live variant (docs/testing/Field-Readiness-Smoke.md), so the
      // automated smoke leaves production data untouched.
    });
  });
});
