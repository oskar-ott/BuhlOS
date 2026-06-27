#!/usr/bin/env node
// J4 proof & evidence metadata importer: public.evidence_files + public.evidence_links.
//
//   node scripts/importers/evidence-import.js            # dry-run (no writes)
//   node scripts/importers/evidence-import.js --write    # apply to the target (dev)
//   node scripts/importers/evidence-import.js --json
//
// Migrates per-job blob evidence (data.json.evidence[]) into evidence_files
// (METADATA ONLY — binaries stay in Vercel Blob; only blob_url/photo_blob_id refs
// are stored) and the task-proof links into evidence_links. Re-keys every legacy
// coordinate onto the canonical identity via the SHARED proof-projection (the ONE
// resolver, reused by the sync-check). Depends on J1–J3 (jobs/areas/tasks) imported.
// Operator-run, NOT wired to any route/deploy/cron.
//
// The actual upsert is api/.../lib/evidence-writer.writeEvidence — the SAME writer
// the best-effort dual-write mirror (api/_lib/evidence-mirror.js) uses, so the
// operator import and the scheduled mirror can never diverge.
//
// Safety / honesty:
//   * Guarded: --write opens getDb({mode:'write'}); env guard runs FIRST (dev only).
//   * GATE: builds the rows first and ABORTS (rollback, exit 1) on ANY quarantine
//     — an unresolvable area/task, a status/kind/source outside the schema CHECK,
//     etc. Never attaches evidence to the wrong task; never coerces.
//   * Honest granularity: task_id is set ONLY for a full, resolvable
//     (areaId,stage,taskId); evidence_links(task,'proof') is created ONLY for such
//     task-level evidence. Area-granularity → evidence_files.site_area_id (no link).
//   * Idempotent: upsert on (tenant,legacy_id) with IS DISTINCT FROM; links DO
//     NOTHING → re-run writes 0 rows. Transactional: evidence + links in ONE tx.
//   * Out of scope (untouched): snags, observations, materials, proof approval UI.

const { buildEvidenceRows } = require('./lib/evidence-rows');
const { writeEvidence, QuarantineError, resolveMaps, currentCounts } = require('./lib/evidence-writer');
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
  console.error(`\nABORTED — ${q.length} quarantined evidence record(s); fix before importing:`);
  for (const x of q.slice(0, 50)) console.error(`  - ${x.table} ${x.id}: ${x.reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/evidence-import.js [--write] [--json]');
    return;
  }
  const sources = await loadSources();

  let report;
  try {
    if (args.write) {
      const sql = getDb({ mode: 'write' });
      try {
        const result = await writeEvidence(sql, sources);
        report = { mode: 'write', result, after: result.after };
      } catch (err) {
        if (err instanceof QuarantineError) {
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
      const { evidenceRows, quarantine, byGranularity } = buildEvidenceRows(sources, { tenantId, ...maps });
      if (quarantine.length) {
        if (args.json) console.log(JSON.stringify({ aborted: true, quarantine }, null, 2));
        else reportQuarantine(quarantine);
        process.exitCode = 1;
        return;
      }
      const taskLinks = evidenceRows.filter((r) => r.task_id).length;
      report = { mode: 'dry-run', proposed: { evidence_files: evidenceRows.length, evidence_links: taskLinks }, byGranularity, current: await currentCounts(sql) };
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.mode === 'write') {
    const e = report.result.evidence;
    console.log('\nEvidence import — APPLIED (one transaction)');
    console.log(`tenant: ${report.result.tenantId}`);
    console.log(`evidence_files  ${e.inserted} inserted · ${e.updated} updated · ${e.unchanged} unchanged (of ${e.total})`);
    console.log(`evidence_links  ${report.result.links.inserted} inserted (of ${report.result.links.candidates} task-proof candidates)`);
    console.log(`granularity: ${report.result.byGranularity.task} task · ${report.result.byGranularity.area} area · ${report.result.byGranularity.job} job/package`);
    console.log(`\nPostgres now holds: ${JSON.stringify(report.after)}`);
    console.log('re-run with --write to confirm idempotency (expect 0 inserted, 0 updated).');
  } else {
    console.log('\nEvidence import — DRY RUN (nothing written)');
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
