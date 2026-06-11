// Automated QA / test-data identification — shared by the API and the QA
// harness scripts so "what counts as test data" has exactly one definition.
//
// Lives in api/_lib (not scripts/) because api/jobs.js needs it at runtime
// for the test-job DELETE guard, and Vercel only bundle-traces requires
// that stay inside the api/ tree. scripts/qa/* require it from here and
// re-export, so the CLI surface and its unit tests are unchanged.
//
// Keep prefixes in sync with docs/testing/Test-Data-Rules.md.
const QA_PREFIXES = ['SMOKE_TEST_', 'STRESS_TEST_', 'QA_SEED_'];

/** True if a job NAME is automated QA/test data (prefix match, case-sensitive). */
function isQaTestJob(name) {
  const n = String(name || '');
  return QA_PREFIXES.some((p) => n.startsWith(p));
}

// The ONLY QA test job allowed to remain ACTIVE: a stable seeded field fixture
// assigned to QA Field (docs/testing/Seeded-Authenticated-QA.md). Generated
// SMOKE_TEST_/STRESS_TEST_ jobs must NEVER be left Active.
const ALLOWED_ACTIVE_FIXTURES = ['QA_SEED_FIELD_ACTIVE_JOB'];

/** True if a job NAME is the documented stable fixture allowed to be Active. */
function isAllowedActiveFixture(name) {
  return ALLOWED_ACTIVE_FIXTURES.includes(String(name || ''));
}

/**
 * Classify a jobs array into the test-data buckets we care about. Pure — no IO
 * — so it is unit-tested (src/domains/qa/smoke-jobs.test.ts) without the blob.
 * `disallowedActive` is the bucket that must be empty after a smoke run: every
 * ACTIVE test job EXCEPT the one allowed stable fixture.
 */
function classify(jobs) {
  const test = (Array.isArray(jobs) ? jobs : []).filter((j) => j && isQaTestJob(j.name));
  const byStatus = (status) => test.filter((j) => j.status === status);
  const active = byStatus('active');
  return {
    test,
    active,
    allowedActive: active.filter((j) => isAllowedActiveFixture(j.name)),
    disallowedActive: active.filter((j) => !isAllowedActiveFixture(j.name)),
    draft: byStatus('draft'),
    archived: byStatus('archived'),
    other: test.filter((j) => !['active', 'draft', 'archived'].includes(j.status)),
  };
}

/**
 * Deletion guard for DELETE /api/jobs and the purge script. Returns
 * { ok: true } or { ok: false, reason } — reasons are stable strings the
 * API maps to error messages:
 *   'not-test-data' — name has no QA prefix; real jobs are NEVER deletable
 *                     through this path (archive them instead).
 *   'live'          — anything not explicitly parked. Only 'draft' and
 *                     'archived' are deletable: a missing status means
 *                     legacy create-then-live, and complete/on_hold are
 *                     still field-visible (the api/jobs.js GET list gate
 *                     only hides draft+archived) — all of those count as
 *                     live. This inherently protects the allowed Active
 *                     fixture (QA_SEED_FIELD_ACTIVE_JOB).
 */
function testJobDeleteEligibility(job) {
  if (!job || !isQaTestJob(job.name)) return { ok: false, reason: 'not-test-data' };
  if (job.status !== 'draft' && job.status !== 'archived') return { ok: false, reason: 'live' };
  return { ok: true };
}

module.exports = {
  QA_PREFIXES,
  ALLOWED_ACTIVE_FIXTURES,
  isQaTestJob,
  isAllowedActiveFixture,
  classify,
  testJobDeleteEligibility,
};
