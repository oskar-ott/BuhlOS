#!/usr/bin/env node
// Snags importer (#152): public.snags from per-job blob snags (data.json.snagsV2[]).
//
//   node scripts/importers/snags-import.js            # dry-run (no writes)
//   node scripts/importers/snags-import.js --write    # apply to the target (dev)
//   node scripts/importers/snags-import.js --json
//
// Re-keys every legacy capture coordinate (areaId, stage, taskId) onto the
// canonical identity via the SHARED proof-projection (the SAME resolver the
// evidence importer uses). Depends on J1–J3 (jobs/areas/tasks) imported.
// Operator-run, NOT wired to any route/deploy/cron — this is the FIRST rung of the
// snags ladder; the best-effort dual-write mirror is a SEPARATE later rung.
//
// Safety / honesty:
//   * Guarded: --write opens getDb({mode:'write'}); the env guard runs FIRST (dev only).
//   * GATE: builds the rows first and ABORTS (rollback, exit 1) on ANY quarantine —
//     an unresolvable area/task, a status/priority/source/stage outside the schema
//     CHECK, a missing/over-length title, etc. Never attaches a snag to the wrong
//     task; never coerces.
//   * Idempotent: upsert on (tenant,legacy_id) with IS DISTINCT FROM → re-run writes
//     0 rows. Transactional: all snags in ONE tx.
//   * Scope (untouched): legacy data.snags[] (pre-v2), snag_comments (no blob source),
//     observations, materials, proof approval UI.

const { buildSnagRows } = require('./lib/snags-rows');
const { writeSnags, SnagQuarantineError, currentSnagCounts } = require('./lib/snags-writer');
const { resolveMaps } = require('./lib/evidence-writer');
const { getDb, closeDb } = require('../../api/_lib/supabase-db');

const DATA_CONCURRENCY = 8;

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
  const jobs = await readBlob('jobs.json', null);
  const jobData = {};
  const ids = (jobs && Array.isArray(jobs.jobs) ? jobs.jobs : []).filter((j) => j && j.id).map((j) => j.id);
  for (let i = 0; i < ids.length; i += DATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + DATA_CONCURRENCY);
    const results = await Promise.all(chunk.map((id) => readBlob(`jobs/${id}/data.json`, null)));
    chunk.forEach((id, idx) => { jobData[id] = results[idx]; });
  }
  return { jobs, jobData };
}

function reportQuarantine(q) {
  console.error(`\nABORTED — ${q.length} quarantined snag(s); fix before importing:`);
  for (const x of q.slice(0, 50)) console.error(`  - ${x.table} ${x.id}: ${x.reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/snags-import.js [--write] [--json]');
    return;
  }
  const sources = await loadSources();

  let report;
  try {
    if (args.write) {
      const sql = getDb({ mode: 'write' });
      try {
        const result = await writeSnags(sql, sources);
        report = { mode: 'write', result, after: result.after };
      } catch (err) {
        if (err instanceof SnagQuarantineError) {
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
      const maps = await resolveMaps(sql, tenantId);
      const { snagRows, quarantine, byGranularity } = buildSnagRows(sources, { tenantId, ...maps });
      if (quarantine.length) {
        if (args.json) console.log(JSON.stringify({ aborted: true, quarantine }, null, 2));
        else reportQuarantine(quarantine);
        process.exitCode = 1;
        return;
      }
      report = { mode: 'dry-run', proposed: { snags: snagRows.length }, byGranularity, current: await currentSnagCounts(sql) };
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.mode === 'write') {
    const s = report.result.snags;
    console.log('\nSnags import — APPLIED (one transaction)');
    console.log(`tenant: ${report.result.tenantId}`);
    console.log(`snags  ${s.inserted} inserted · ${s.updated} updated · ${s.unchanged} unchanged (of ${s.total})`);
    console.log(`granularity: ${report.result.byGranularity.task} task · ${report.result.byGranularity.area} area · ${report.result.byGranularity.job} job`);
    console.log(`\nPostgres now holds: ${JSON.stringify(report.after)}`);
    console.log('re-run with --write to confirm idempotency (expect 0 inserted, 0 updated).');
  } else {
    console.log('\nSnags import — DRY RUN (nothing written)');
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
