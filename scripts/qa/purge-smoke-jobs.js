#!/usr/bin/env node
// QA harness — purge parked automated-test jobs from jobs.json.
//
//   node scripts/qa/purge-smoke-jobs.js            # DRY RUN — prints what would go
//   node scripts/qa/purge-smoke-jobs.js --apply    # actually deletes
//   npm run qa:purge-smoke-jobs [-- --apply]
//
// Companion to list-smoke-jobs.js (read-only listing) — this is the cleanup
// half. Shares the deletion contract with DELETE /api/jobs via
// api/_lib/test-data.js: ONLY jobs whose name carries a QA prefix
// (SMOKE_TEST_ / STRESS_TEST_ / QA_SEED_) AND whose status is not 'active'
// are eligible. Real jobs are never touched; the allowed Active fixture
// QA_SEED_FIELD_ACTIVE_JOB survives because it is active. Any DISALLOWED
// Active test job is reported (park it first) but never deleted here.
//
// Safety, in order:
//   1. Default is a dry run — nothing is written without --apply.
//   2. On --apply, the pre-purge jobs.json is saved to .qa-backups/
//      (gitignored) before the write, so a purge is recoverable.
//   3. Per-job blobs (jobs/<id>/{data,tags,audit}.json) are swept
//      best-effort after the row is gone — deleteBlob never throws.
//
// Uses BLOB_READ_WRITE_TOKEN from the environment; never reads, prints, or
// stores the token. Exit codes: 0 = clean (including "nothing to purge"),
// 1 = error (missing token / read or write failure).
const fs = require('fs');
const path = require('path');

const { classify, testJobDeleteEligibility, ALLOWED_ACTIVE_FIXTURES } = require('../../api/_lib/test-data.js');

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error(
      'ERROR: BLOB_READ_WRITE_TOKEN is not set — cannot read jobs.json. ' +
        'Set the token (do not paste it here) and re-run.'
    );
    process.exit(1);
  }

  // Lazy-require so importing this module never touches the blob SDK.
  const { readBlobFresh, writeBlob, deleteBlob } = require('../../api/_lib/blob.js');

  let data;
  try {
    data = await readBlobFresh('jobs.json', { jobs: [] });
  } catch (e) {
    console.error('ERROR reading jobs.json:', (e && e.message) || String(e));
    process.exit(1);
  }
  const jobs = (data && data.jobs) || [];
  const { test, disallowedActive } = classify(jobs);
  const eligible = test.filter((j) => testJobDeleteEligibility(j).ok);
  const kept = test.filter((j) => !testJobDeleteEligibility(j).ok);

  console.log(`jobs.json: ${jobs.length} total, ${test.length} QA/test, ${eligible.length} eligible to purge\n`);
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  for (const j of eligible) console.log(`  purge  ${pad(j.status || '(none)', 9)} ${pad(j.id, 28)} ${j.name}`);
  for (const j of kept) {
    // Everything in `kept` failed the 'live' check (it's already test-prefixed):
    // active/complete/on_hold/missing status — only the fixture is meant to be here.
    const why = ALLOWED_ACTIVE_FIXTURES.includes(j.name) && j.status === 'active'
      ? 'allowed stable fixture'
      : 'still live — park it to draft first';
    console.log(`  keep   ${pad(j.status || '(none)', 9)} ${pad(j.id, 28)} ${j.name}  (${why})`);
  }
  if (disallowedActive.length > 0) {
    console.warn(
      `\nWARN: ${disallowedActive.length} test job(s) are ACTIVE and not the allowed fixture — ` +
        'this script never deletes active jobs. Park them to Draft, then re-run.'
    );
  }

  if (eligible.length === 0) {
    console.log('\nOK: nothing to purge.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — no changes made. Re-run with --apply to delete ${eligible.length} job(s).`);
    process.exit(0);
  }

  // Backup the full pre-purge document before any write.
  const backupDir = path.join(__dirname, '..', '..', '.qa-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `jobs-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(data, null, 2));
  console.log(`\nBackup written: ${path.relative(process.cwd(), backupPath)}`);

  const eligibleIds = new Set(eligible.map((j) => j.id));
  const next = { ...data, jobs: jobs.filter((j) => !eligibleIds.has(j.id)) };
  try {
    await writeBlob('jobs.json', next);
  } catch (e) {
    console.error('ERROR writing jobs.json (no jobs were removed):', (e && e.message) || String(e));
    process.exit(1);
  }
  for (const id of eligibleIds) {
    await deleteBlob(`jobs/${id}/data.json`);
    await deleteBlob(`jobs/${id}/tags.json`);
    await deleteBlob(`jobs/${id}/audit.json`);
  }

  console.log(`\nOK: purged ${eligible.length} test job(s); ${next.jobs.length} jobs remain.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('qa:purge-smoke-jobs crashed:', (e && e.stack) || e);
  process.exit(1);
});
