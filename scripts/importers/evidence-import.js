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
// Safety / honesty:
//   * Guarded: --write opens getDb({mode:'write'}); env guard runs FIRST (dev only).
//   * GATE: builds the rows first and ABORTS (rollback, exit 1) on ANY quarantine
//     — an unresolvable area/task, a status/kind/source outside the schema CHECK,
//     etc. Never attaches evidence to the wrong task; never coerces.
//   * Honest granularity: task_id is set ONLY for a full, resolvable
//     (areaId,stage,taskId); evidence_links(task,'proof') is created ONLY for such
//     task-level evidence. Area-granularity → evidence_files.site_area_id (no link;
//     no PG 'area' link type). Package-level proof (the job-control work-package
//     loop) has NO PG target and is NOT fabricated onto tasks.
//   * Idempotent: evidence_files upsert on (tenant,legacy_id) with IS DISTINCT FROM;
//     evidence_links upsert on the dedupe index DO NOTHING → re-run writes 0 rows.
//   * Transactional: evidence + links commit in ONE transaction.
//   * Out of scope (untouched): snags, observations, materials, comments, proof
//     approval/review UI, PG reads, dual-write, flags, production. Blob read-only.

const {
  buildEvidenceRows, buildEvidenceLinkRows,
  EVIDENCE_INSERT_COLS, EVIDENCE_MUTABLE_COLS, EVIDENCE_LINK_INSERT_COLS,
} = require('./lib/evidence-rows');
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

function setExcluded(sql, cols) {
  return cols.map((c) => sql`${sql(c)} = excluded.${sql(c)}`).reduce((a, b) => sql`${a}, ${b}`);
}
function distinctFromExcluded(sql, table, cols) {
  return cols.map((c) => sql`${sql(table)}.${sql(c)} is distinct from excluded.${sql(c)}`).reduce((a, b) => sql`${a} or ${b}`);
}
function tally(returned, total) {
  const inserted = returned.filter((r) => r.inserted).length;
  return { inserted, updated: returned.length - inserted, unchanged: total - returned.length, total };
}

async function legacyIdMap(sql, table, tenantId, col = 'legacy_id') {
  const rows = await sql`select id, ${sql(col)} as legacy from ${sql(table)} where tenant_id = ${tenantId} and ${sql(col)} is not null`;
  return new Map(rows.map((r) => [r.legacy, r.id]));
}

async function resolveMaps(sql, tenantId) {
  const jobMap = await legacyIdMap(sql, 'jobs', tenantId);
  const areaMap = await legacyIdMap(sql, 'site_areas', tenantId);
  const userMap = await legacyIdMap(sql, 'user_profiles', tenantId, 'legacy_user_id');
  // taskMap keyed by the proof bridge `${areaLegacy}|${stage}|${legacy_template_id}`.
  const taskRows = await sql`
    select t.id, ar.legacy_id as area_legacy, t.stage, t.legacy_template_id
    from public.tasks t
    join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.site_area_id is not null and t.legacy_template_id is not null
  `;
  const taskMap = new Map(taskRows.map((r) => [`${r.area_legacy}|${r.stage}|${r.legacy_template_id}`, r.id]));
  return { jobMap, areaMap, userMap, taskMap };
}

async function currentCounts(sql) {
  const [c] = await sql`
    select (select count(*)::int from public.evidence_files where deleted_at is null) as evidence_files,
           (select count(*)::int from public.evidence_links)                          as evidence_links
  `;
  return { evidence_files: c.evidence_files, evidence_links: c.evidence_links };
}

class QuarantineError extends Error {
  constructor(quarantine) { super('quarantined evidence'); this.quarantine = quarantine; }
}

async function writeAll(sql, sources) {
  return sql.begin(async (sql) => {
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
    const tenantId = tenant[0].id;

    const maps = await resolveMaps(sql, tenantId);
    const { evidenceRows, quarantine, byGranularity } = buildEvidenceRows(sources, { tenantId, ...maps });
    if (quarantine.length) throw new QuarantineError(quarantine);

    const evRet = evidenceRows.length
      ? await sql`
          insert into public.evidence_files ${sql(evidenceRows, ...EVIDENCE_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcluded(sql, EVIDENCE_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'evidence_files', EVIDENCE_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    // Task-proof links for EVERY task-resolved evidence file (not just changed
    // ones), so the link exists even when the evidence row was unchanged. Dedupe
    // index makes this idempotent.
    const taskEvidence = await sql`
      select id, task_id from public.evidence_files
      where tenant_id = ${tenantId} and task_id is not null and deleted_at is null
    `;
    const linkRows = buildEvidenceLinkRows(tenantId, [...taskEvidence]);
    const linkRet = linkRows.length
      ? await sql`
          insert into public.evidence_links ${sql(linkRows, ...EVIDENCE_LINK_INSERT_COLS)}
          on conflict (evidence_file_id, linked_entity_type, linked_entity_id, link_role) do nothing
          returning (xmax = 0) as inserted
        `
      : [];

    const after = await currentCounts(sql);
    return {
      tenantId,
      evidence: tally(evRet, evidenceRows.length),
      links: { inserted: linkRet.length, candidates: linkRows.length },
      byGranularity,
      after,
    };
  });
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
        const result = await writeAll(sql, sources);
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
