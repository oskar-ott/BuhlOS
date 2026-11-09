#!/usr/bin/env node
// Reclaim orphaned evidence/photo Blob bytes (FILE-02, part of #152).
//
// Photo BYTES live in Vercel Blob under write-once keys; their references live
// in per-job JSON documents. There is no cascade between them, so a dropped
// reference orphans the bytes forever. This sweeper finds photo blobs with NO
// live reference ANYWHERE in the job's JSON and (opt-in) deletes them.
//
// DRY-RUN BY DEFAULT — nothing is deleted without --write. Without --write the
// script only LISTS what it WOULD delete. A blob is treated as an orphan ONLY
// when its pathname, URL and photoId token are all absent from every reference
// string in the job's data.json / photos-index.json / itps.json / tags.json /
// certificates.json — the maximally conservative rule (bias: keep, never
// over-delete). See api/_lib/evidence-orphan-gc.js for the full semantics.
//
// Usage (needs BLOB_READ_WRITE_TOKEN in the environment):
//   node scripts/evidence-orphan-gc.js                  # dry-run, all jobs
//   node scripts/evidence-orphan-gc.js --job <jobId>    # dry-run, one job
//   node scripts/evidence-orphan-gc.js --write          # DELETE orphans, all jobs
//   node scripts/evidence-orphan-gc.js --job <id> --write
//
// Pull the token with `vercel env pull` or export BLOB_READ_WRITE_TOKEN first.

const { sweepJob, sweepAll } = require('../api/_lib/evidence-orphan-gc');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function printJob(r) {
  const head = `job ${r.jobId}: scanned ${r.scanned}, live ${r.live}, orphans ${r.orphans.length}`;
  if (r.aborted) {
    console.log(`  ${head} — SKIPPED (${r.aborted})`);
    return;
  }
  console.log(`  ${head}${r.write ? `, deleted ${r.deleted}` : ''}`);
  for (const p of r.orphans) {
    console.log(`    ${r.write ? 'deleted' : 'orphan'}: ${p}`);
  }
  for (const e of r.deleteErrors) {
    console.log(`    delete-error: ${e.pathname} — ${e.error}`);
  }
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    fail('BLOB_READ_WRITE_TOKEN is not set (pull it with `vercel env pull` or export it).');
  }

  const write = arg('write') === true;
  const jobId = arg('job');

  console.log(
    write
      ? '⚠  --write set: orphaned photo bytes WILL be deleted.'
      : 'Dry-run (no --write): reporting orphans only, nothing will be deleted.'
  );

  if (jobId && jobId !== true) {
    const r = await sweepJob({ jobId, write });
    printJob(r);
    console.log(
      `\nDone. ${write ? `deleted ${r.deleted}` : `${r.orphans.length} orphan(s) would be deleted`}.`
    );
    return;
  }

  const summary = await sweepAll({ write });
  for (const r of summary.perJob) {
    if (r.scanned === 0 && r.orphans.length === 0 && !r.aborted) continue; // quiet: nothing to say
    printJob(r);
  }
  console.log(
    `\nDone. ${summary.jobs} jobs, ${summary.scanned} photo blobs scanned, ${summary.live} live, ` +
      (write
        ? `${summary.deleted} deleted, ${summary.deleteErrors.length} delete-error(s).`
        : `${summary.orphans} orphan(s) would be deleted (re-run with --write to reclaim).`)
  );
  if (write && summary.deleteErrors.length) process.exitCode = 1;
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
