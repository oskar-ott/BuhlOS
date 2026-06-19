#!/usr/bin/env node
// Hours sync-check — the recorded Blob↔Postgres drift check (#152 trust layer).
//
//   node scripts/importers/hours-sync-check.js            # dry-run (print only)
//   node scripts/importers/hours-sync-check.js --write     # record into sync_checks
//   node scripts/importers/hours-sync-check.js --json
//
// Compares EVERY hours entry AND its per-job allocations across Blob and
// Postgres, producing PASS/FAIL with counts, totals, content hashes and the
// specific drifts. This is the MANUAL operator runner; the SAME check runs on a
// schedule via GET /api/internal/sync-checks/hours (Vercel cron). Both share the
// core in api/_lib/hours-sync — READ-ONLY against the data; --write only INSERTs
// an append-only audit row into public.sync_checks. Never repairs data.
//
// Unlike the cron, this runner is NOT gated on the dual_write flag — an operator
// may check at any time (e.g. straight after a manual import).

const { runHoursSyncCheck } = require('../../api/_lib/hours-sync');
const { getDb, closeDb } = require('../../api/_lib/supabase-db');

function parseArgs(argv) {
  const args = { write: false, json: false, help: false };
  for (const a of argv) {
    if (a === '--write') args.write = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else { console.error(`unknown argument: ${a}`); args.help = true; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/hours-sync-check.js [--write] [--json]');
    return;
  }

  let report;
  try {
    const sql = getDb({ mode: args.write ? 'write' : 'read' });
    report = await runHoursSyncCheck(sql, { record: args.write });
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nHours sync-check — ${report.status === 'pass' ? 'IN SYNC ✓' : 'DRIFT — FAIL'}`);
    console.log(`Blob:     ${report.blobCount} entries (${report.blobTotal}h)  hash ${String(report.blobHash).slice(0, 12)}…`);
    console.log(`Postgres: ${report.pgCount} entries (${report.pgTotal}h)  hash ${String(report.pgHash).slice(0, 12)}…`);
    console.log(`matched ${report.matched} · only-in-Blob ${report.onlyInBlobCount} · only-in-Postgres ${report.onlyInPgCount} · mismatched ${report.mismatchedCount} (allocations checked: ${report.allocationsChecked})`);
    if (report.status !== 'pass') console.log(`details: ${JSON.stringify(report.details)}`);
    console.log(`checked in ${report.durationMs}ms${report.recorded ? ' · recorded to sync_checks' : ' (dry-run — use --write to record)'}`);
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
