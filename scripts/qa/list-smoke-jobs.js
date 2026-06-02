#!/usr/bin/env node
// QA harness — list automated-test jobs and flag any that are still ACTIVE.
//
//   node scripts/qa/list-smoke-jobs.js
//   npm run qa:list-smoke-jobs
//
// READ-ONLY. Reads jobs.json through the existing blob helper (which uses the
// BLOB_READ_WRITE_TOKEN from the environment — this script never reads, prints,
// or stores that token or any credential). It does NOT mutate anything.
//
// Purpose (docs/testing/Seeded-Authenticated-QA.md): authenticated preview
// smoke creates SMOKE_TEST_<run> jobs and parks them as Draft. This gives a
// deterministic way to answer "did any test job get left ACTIVE?" without
// logging in or trusting the test's own cleanup.
//
// Exit codes:
//   0 — no DISALLOWED test jobs are Active (clean)
//   2 — at least one DISALLOWED test job is Active (any Active test job except the
//       documented stable fixture QA_SEED_FIELD_ACTIVE_JOB — needs parking)
//   1 — could not read jobs (e.g. BLOB_READ_WRITE_TOKEN not set) — NOT a clean result
//
// Test data prefixes (keep in sync with docs/testing/Test-Data-Rules.md).
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

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error(
      'ERROR: BLOB_READ_WRITE_TOKEN is not set — cannot read jobs.json. ' +
        'This is NOT a clean result; set the token (do not paste it here) and re-run.'
    );
    process.exit(1);
  }
  let jobs;
  try {
    // Lazy-require so importing this module for unit tests never touches the blob SDK.
    const { readBlobFresh } = require('../../api/_lib/blob.js');
    const data = await readBlobFresh('jobs.json', { jobs: [] });
    jobs = (data && data.jobs) || [];
  } catch (e) {
    console.error('ERROR reading jobs.json:', (e && e.message) || String(e));
    process.exit(1);
  }

  const { test, active, allowedActive, disallowedActive, draft, archived, other } = classify(jobs);
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  console.log(`QA/test jobs found: ${test.length} (of ${jobs.length} total)`);
  for (const j of test) {
    let flag = '';
    if (j.status === 'active') {
      flag = isAllowedActiveFixture(j.name)
        ? '  (allowed stable fixture)'
        : '  <-- ACTIVE (must be parked)';
    }
    console.log(`  ${pad(j.status || '(none)', 9)} ${pad(j.id, 28)} ${j.name}${flag}`);
  }
  console.log(
    `\nactive=${active.length} (allowed=${allowedActive.length}, disallowed=${disallowedActive.length})  ` +
      `draft=${draft.length}  archived=${archived.length}  other=${other.length}`
  );
  if (disallowedActive.length > 0) {
    console.error(
      `\nFAIL: ${disallowedActive.length} test job(s) are ACTIVE and are not the allowed stable ` +
        `fixture (${ALLOWED_ACTIVE_FIXTURES.join(', ')}). Park them to Draft (unpublish) via the ` +
        `admin builder — see docs/testing/Seeded-Authenticated-QA.md.`
    );
    process.exit(2);
  }
  console.log('\nOK: no disallowed test jobs are Active.');
  process.exit(0);
}

module.exports = { QA_PREFIXES, ALLOWED_ACTIVE_FIXTURES, isQaTestJob, isAllowedActiveFixture, classify };

// Run as CLI only when invoked directly (not when required by the unit test).
if (require.main === module) {
  main().catch((e) => {
    console.error('qa:list-smoke-jobs crashed:', (e && e.stack) || e);
    process.exit(1);
  });
}
