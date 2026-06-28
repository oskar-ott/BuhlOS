#!/usr/bin/env node
// Material-requests importer (#152): public.material_requests + material_request_items
// from the org-wide blob material-requests.json ({requests:[]}).
//
//   node scripts/importers/materials-import.js            # dry-run (no writes)
//   node scripts/importers/materials-import.js --write    # apply to the target (dev)
//   node scripts/importers/materials-import.js --json
//
// Each blob request → one header row + one item row (the blob carries a single
// item/quantity/unit). Re-keys the legacy coordinate via the SHARED proof-projection
// and resolves linked_observation_id via the now-imported observations (best-effort).
// Depends on J1–J3 (jobs/areas/tasks) and, for the obs link, the observations
// importer. Operator-run, NOT wired to any route/deploy/cron.
//
// Safety / honesty:
//   * Guarded: --write opens getDb({mode:'write'}); env guard runs FIRST (dev only).
//   * GATE: builds rows first and ABORTS (rollback, exit 1) on ANY quarantine —
//     a request with no jobId, an unresolvable area/task, an out-of-CHECK value, or
//     an invalid/missing line item.
//   * Idempotent: header upsert IS DISTINCT FROM; items reconciled per request
//     (canonical compare → replace only when changed). One tx.

const { buildMaterialRequestRows } = require('./lib/materials-rows');
const { writeMaterialRequests, MaterialQuarantineError, resolveMaterialMaps, currentMaterialCounts } = require('./lib/materials-writer');
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
  const materials = await readBlob('material-requests.json', null);
  return { materials };
}

function reportQuarantine(q) {
  console.error(`\nABORTED — ${q.length} quarantined material request(s); fix before importing:`);
  for (const x of q.slice(0, 50)) console.error(`  - ${x.table} ${x.id}: ${x.reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/materials-import.js [--write] [--json]');
    return;
  }
  const sources = await loadSources();

  let report;
  try {
    if (args.write) {
      const sql = getDb({ mode: 'write' });
      try {
        const result = await writeMaterialRequests(sql, sources);
        report = { mode: 'write', result, after: result.after };
      } catch (err) {
        if (err instanceof MaterialQuarantineError) {
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
      const maps = await resolveMaterialMaps(sql, tenantId);
      const { requestRows, itemsByLegacy, quarantine, byGranularity } = buildMaterialRequestRows(sources, { tenantId, ...maps });
      if (quarantine.length) {
        if (args.json) console.log(JSON.stringify({ aborted: true, quarantine }, null, 2));
        else reportQuarantine(quarantine);
        process.exitCode = 1;
        return;
      }
      report = { mode: 'dry-run', proposed: { material_requests: requestRows.length, material_request_items: itemsByLegacy.length }, byGranularity, current: await currentMaterialCounts(sql) };
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.mode === 'write') {
    const r = report.result.requests;
    const it = report.result.items;
    console.log('\nMaterial-requests import — APPLIED (one transaction)');
    console.log(`tenant: ${report.result.tenantId}`);
    console.log(`material_requests  ${r.inserted} inserted · ${r.updated} updated · ${r.unchanged} unchanged (of ${r.total})`);
    console.log(`items  ${it.itemsInserted} written · ${it.requestsReplaced} requests replaced · ${it.requestsUnchanged} unchanged`);
    console.log(`granularity: ${report.result.byGranularity.task} task · ${report.result.byGranularity.area} area · ${report.result.byGranularity.job} job`);
    console.log(`\nPostgres now holds: ${JSON.stringify(report.after)}`);
    console.log('re-run with --write to confirm idempotency (expect 0 inserted/updated, 0 items written).');
  } else {
    console.log('\nMaterial-requests import — DRY RUN (nothing written)');
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
