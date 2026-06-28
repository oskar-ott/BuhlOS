#!/usr/bin/env node
// Observations importer (#152): public.observations from the org-wide blob
// observations.json ({observations:[]}).
//
//   node scripts/importers/observations-import.js            # dry-run (no writes)
//   node scripts/importers/observations-import.js --write    # apply to the target (dev)
//   node scripts/importers/observations-import.js --json
//
// Re-keys every legacy coordinate (areaId, stage, taskId) onto canonical identity
// via the SHARED proof-projection, and resolves linked_snag_id via the snags
// already imported (best-effort). Depends on J1–J3 (jobs/areas/tasks) and, for the
// snag links, the snags importer. Operator-run, NOT wired to any route/deploy/cron.
//
// Safety / honesty:
//   * Guarded: --write opens getDb({mode:'write'}); env guard runs FIRST (dev only).
//   * GATE: builds rows first and ABORTS (rollback, exit 1) on ANY quarantine —
//     office items (no jobId), unresolvable area/task, out-of-CHECK values, etc.
//   * Idempotent: upsert on (tenant,legacy_id) with IS DISTINCT FROM. One tx.
//   * Scope (untouched): office-item observations (jobId null — quarantined until a
//     schema change), linked_material_request_id (materials are a later rung),
//     variation detail / convertedTarget / RFI links (no PG column).

const { buildObservationRows } = require('./lib/observations-rows');
const { writeObservations, ObservationQuarantineError, resolveObservationMaps, currentObservationCounts } = require('./lib/observations-writer');
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

async function loadSources() {
  const { readBlob } = require('../../api/_lib/blob');
  const observations = await readBlob('observations.json', null);
  return { observations };
}

function reportQuarantine(q) {
  console.error(`\nABORTED — ${q.length} quarantined observation(s); fix before importing:`);
  for (const x of q.slice(0, 50)) console.error(`  - ${x.table} ${x.id}: ${x.reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/observations-import.js [--write] [--json]');
    return;
  }
  const sources = await loadSources();

  let report;
  try {
    if (args.write) {
      const sql = getDb({ mode: 'write' });
      try {
        const result = await writeObservations(sql, sources);
        report = { mode: 'write', result, after: result.after };
      } catch (err) {
        if (err instanceof ObservationQuarantineError) {
          if (args.json) console.log(JSON.stringify({ aborted: true, quarantine: err.quarantine }, null, 2));
          else reportQuarantine(err.quarantine);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    } else {
      const sql = getDb({ mode: 'read' });
      const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
      if (!tenant.length) throw new Error('no tenant (slug "buhl")');
      const tenantId = tenant[0].id;
      const maps = await resolveObservationMaps(sql, tenantId);
      const { observationRows, quarantine, byGranularity } = buildObservationRows(sources, { tenantId, ...maps });
      if (quarantine.length) {
        if (args.json) console.log(JSON.stringify({ aborted: true, quarantine }, null, 2));
        else reportQuarantine(quarantine);
        process.exitCode = 1;
        return;
      }
      report = { mode: 'dry-run', proposed: { observations: observationRows.length }, byGranularity, current: await currentObservationCounts(sql) };
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.mode === 'write') {
    const o = report.result.observations;
    console.log('\nObservations import — APPLIED (one transaction)');
    console.log(`tenant: ${report.result.tenantId}`);
    console.log(`observations  ${o.inserted} inserted · ${o.updated} updated · ${o.unchanged} unchanged (of ${o.total})`);
    console.log(`granularity: ${report.result.byGranularity.task} task · ${report.result.byGranularity.area} area · ${report.result.byGranularity.job} job`);
    console.log(`\nPostgres now holds: ${JSON.stringify(report.after)}`);
    console.log('re-run with --write to confirm idempotency (expect 0 inserted, 0 updated).');
  } else {
    console.log('\nObservations import — DRY RUN (nothing written)');
    console.log(`proposed: ${JSON.stringify(report.proposed)} · granularity ${JSON.stringify(report.byGranularity)}`);
    console.log(`current in Postgres: ${JSON.stringify(report.current)}`);
    console.log('\nrun with --write to apply.');
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
