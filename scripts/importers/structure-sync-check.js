#!/usr/bin/env node
// Structure sync-check — the recorded Blob↔Postgres drift check for the place
// structure + tasks + evidence (jobs / site_area_groups / site_areas /
// job_task_templates / tasks / evidence_files / evidence_links). The J1–J4 trust
// layer, modelled on scripts/importers/hours-sync-check.js (#152).
//
//   node scripts/importers/structure-sync-check.js            # dry-run (print only)
//   node scripts/importers/structure-sync-check.js --write     # record into sync_checks
//   node scripts/importers/structure-sync-check.js --json
//
// READ-ONLY against the data (Blob read + a PG read); --write only INSERTs ONE
// append-only row into public.sync_checks (domain 'structure'). NO auto-repair,
// no mutation. The actual check is api/_lib/structure-sync.runStructureSyncCheck —
// the SAME engine the scheduled cron (api/internal/sync-checks/structure.js) runs,
// so the CLI and the cron can never diverge.

const { runStructureSyncCheck } = require('../../api/_lib/structure-sync');
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
    console.log('usage: node scripts/importers/structure-sync-check.js [--write] [--json]');
    return;
  }

  let report;
  try {
    const sql = getDb({ mode: args.write ? 'write' : 'read' });
    report = await runStructureSyncCheck(sql, { record: args.write });
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nStructure sync-check — ${report.status === 'pass' ? 'IN SYNC ✓' : 'DRIFT — FAIL'}`);
    console.log(`Blob:     ${report.blobCount} entities (${report.blobDeleted} archived)  hash ${String(report.blobHash).slice(0, 12)}…`);
    console.log(`Postgres: ${report.pgCount} entities (${report.pgDeleted} deleted)  hash ${String(report.pgHash).slice(0, 12)}…`);
    for (const [name, s] of Object.entries(report.details.sections)) {
      console.log(`  ${name.padEnd(7)} blob ${s.blobCount} · pg ${s.pgCount} · matched ${s.matched} · only-blob ${s.onlyInBlobCount} · only-pg ${s.onlyInPgCount} · mismatched ${s.mismatchedCount}`);
    }
    console.log(`unmappable ${report.unmappableCount} · hashMatch ${report.details.hashMatch}`);
    if (report.status !== 'pass') console.log(`details: ${JSON.stringify(report.details)}`);
    console.log(`checked in ${report.durationMs}ms${report.recorded ? ' · recorded to sync_checks' : ' (dry-run — use --write to record)'}`);
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
