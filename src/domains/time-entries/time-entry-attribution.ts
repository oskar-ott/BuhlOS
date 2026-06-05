/**
 * Pure, runner-agnostic validator for the job attribution carried on a
 * POST /api/time-entries body — the #77 guarantee that a field worker's hours
 * attach to the active job they were assigned, never to jobId:null and never to
 * some other job.
 *
 * Extracted from the inline checks in the Field-Readiness Smoke
 * (tests/playwright/helpers/fieldReadiness.ts) so the assertion is the SINGLE
 * source of truth and can be unit-tested in plain vitest (node env) — the
 * credentialed Preview Smoke only EXERCISES it, normal CI never did.
 *
 * Deliberately free of any "@playwright/test" import: the Playwright helper
 * imports THIS, not the other way round, so vitest can load it without pulling
 * in the Playwright runtime.
 *
 * Cross-ref:
 *   tests/playwright/helpers/fieldReadiness.ts — submitStandardDayAndCaptureAttribution (consumer)
 *   src/domains/time-entries/time-entry-attribution-api.test.ts — server-side acceptance/rejection of the same contract
 */

/**
 * Assert that a POST /api/time-entries body attributes every allocation to a
 * real job, and return the attributed jobId.
 *
 * Enforced, at full strength:
 *   - `allocations` exists and is a non-empty array — a missing/empty field is
 *     NOT silently treated as attributed;
 *   - EVERY allocation carries a truthy jobId — so a partial-null regression
 *     like [{ jobId: null }, { jobId: "x" }] fails, not just an all-null body;
 *   - when `expectedJobId` is provided, EVERY allocation's jobId EQUALS it — so
 *     a regression that attributes to the wrong job ({ jobId: "some-other-job" })
 *     fails, not merely an outright jobId:null.
 *
 * Throws an Error with a clear message on any violation; otherwise returns the
 * (first) attributed jobId.
 *
 * @param body         the parsed POST body (unknown — validated here)
 * @param expectedJobId the assigned job's id; when given, every allocation must match it
 */
export function assertTimeEntryPostUsesExpectedJob(
  body: unknown,
  expectedJobId?: string | null,
): string {
  const allocations = (body as { allocations?: unknown } | null | undefined)?.allocations;

  // Allocations must exist explicitly — a non-empty array, not a missing/empty
  // field that an "any truthy jobId" search would silently treat as attributed.
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new Error("Standard Day POST must carry a non-empty allocations array.");
  }

  let attributedJobId: string | undefined;
  for (const allocation of allocations) {
    const jobId = (allocation as { jobId?: unknown } | null | undefined)?.jobId;

    // Never jobId:null when the worker has an active assigned job (#77).
    if (!jobId) {
      throw new Error(
        "Standard Day allocation must attach a non-null jobId — never jobId:null with an active assigned job.",
      );
    }

    // When we know the assigned job, the hours must attribute to THAT job — not
    // merely to some non-null job.
    if (expectedJobId && jobId !== expectedJobId) {
      throw new Error(
        `Standard Day must attribute to the assigned job "${expectedJobId}", got "${String(jobId)}".`,
      );
    }

    attributedJobId ??= String(jobId);
  }

  // Guaranteed set: allocations is non-empty and the first iteration assigned it.
  return attributedJobId as string;
}
