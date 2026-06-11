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
// Test-data identification lives in api/_lib/test-data.js — shared with the
// DELETE /api/jobs guard and scripts/qa/purge-smoke-jobs.js so "what counts
// as test data" has exactly one definition. Re-exported below unchanged, so
// this script's CLI surface and unit tests keep their import path.
const {
  QA_PREFIXES,
  ALLOWED_ACTIVE_FIXTURES,
  isQaTestJob,
  isAllowedActiveFixture,
  classify,
} = require('../../api/_lib/test-data.js');

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
