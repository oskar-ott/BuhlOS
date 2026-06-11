/**
 * QA test-data identification — TypeScript mirror of api/_lib/test-data.js.
 *
 * The server module is CommonJS inside api/ (Vercel function tree) and the
 * Next.js app shouldn't import across that boundary at runtime, so the two
 * constants are deliberately duplicated here. A parity unit test
 * (src/domains/jobs/test-data.test.ts) loads the CJS module via
 * createRequire and pins both sides to the same values — change one without
 * the other and the suite fails.
 *
 * Used by the admin jobs index to label test-data rows and to decide which
 * jobs the "clean up test jobs" control may offer for deletion. The server
 * re-checks everything (DELETE /api/jobs guard) — this is display logic,
 * not the enforcement point.
 */
export const QA_TEST_JOB_PREFIXES = ["SMOKE_TEST_", "STRESS_TEST_", "QA_SEED_"] as const;

/** True if a job NAME is automated QA/test data (prefix match, case-sensitive). */
export function isQaTestJobName(name: string | null | undefined): boolean {
  const n = String(name ?? "");
  return QA_TEST_JOB_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * True if DELETE /api/jobs would accept this job: QA-prefixed AND
 * explicitly parked (draft) or archived. Mirrors testJobDeleteEligibility
 * server-side — anything else (active, complete, on_hold, or a missing
 * legacy status) is still field-visible and must be parked first, which
 * inherently protects the allowed stable fixture QA_SEED_FIELD_ACTIVE_JOB.
 */
export function isDeletableTestJob(job: { name: string; status?: string | null }): boolean {
  return isQaTestJobName(job.name) && (job.status === "draft" || job.status === "archived");
}
