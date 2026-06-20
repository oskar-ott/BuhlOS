#!/usr/bin/env node
// J3 tasks importer: public.tasks + public.task_status_events.
//
//   node scripts/importers/tasks-import.js            # dry-run (no writes)
//   node scripts/importers/tasks-import.js --write    # apply to the target (dev)
//   node scripts/importers/tasks-import.js --json
//
// Writes the concrete task INSTANCES (and their import-baseline status events) by
// consuming the SHARED projection engine (scripts/importers/lib/task-projection.js)
// — the ONE expansion implementation, proven read-only in J3-prep. Depends on
// J1 (jobs/areas) + J2 (job_task_templates) already imported; resolves all FKs
// from existing rows. Operator-run, NOT wired to any route/deploy/cron.
//
// Safety / honesty:
//   * Guarded: --write opens getDb({mode:'write'}); the env guard runs FIRST
//     (dev only off a non-prod runtime; prod additionally needs the opt-in).
//   * GATE: runs the projection first and ABORTS before any write unless it is
//     CLEAN (0 collisions / orphaned / malformed / bad-status). No silent coercion.
//   * Idempotent: upserts on tasks_area_stage_template_uq (tenant, site_area_id,
//     stage, legacy_template_id) with an IS DISTINCT FROM guard → unchanged re-run
//     writes ZERO rows. Events are created ONLY for tasks the upsert INSERTED, so a
//     re-run creates zero events → task_status_events stays 1:1 with tasks.
//   * No third identity: legacy_template_id = the BARE taskId; Supabase mints
//     tasks.id. task_template_id is FK-resolved by the override-aware templateScope.
//   * Transactional: tasks + events commit in ONE transaction (so the 1:1 count
//     invariant can never half-apply).
//   * Status: only the schema-CHECK set (not_started/in_progress/complete). An
//     out-of-set recorded state fails the projection gate above — never written.
//   * Out of scope (untouched): proof, evidence, comments, observations, snags,
//     materials, PG reads, dual-write, runtime/UI, feature flags, production.

const { buildTaskProjection } = require('./lib/task-projection');
const {
  buildTaskRows, buildEventRows, TASK_MUTABLE_COLS, TASK_INSERT_COLS, EVENT_INSERT_COLS,
} = require('./lib/task-rows');
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

// Live Blob — read-only. jobs.json + per-job data.json (task state).
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

async function legacyIdMap(sql, table, tenantId) {
  const rows = await sql`select id, legacy_id from ${sql(table)} where tenant_id = ${tenantId} and legacy_id is not null`;
  return new Map(rows.map((r) => [r.legacy_id, r.id]));
}

// Template maps keyed exactly as task-rows expects: job-level by (jobLegacy,stage,
// legacyId); area-level by (areaLegacy,stage,legacyId).
async function templateMaps(sql, tenantId) {
  const rows = await sql`
    select t.id, t.site_area_id, t.stage, t.legacy_id,
           jb.legacy_id as job_legacy, ar.legacy_id as area_legacy
    from public.job_task_templates t
    left join public.jobs jb on jb.id = t.job_id
    left join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.legacy_id is not null
  `;
  const jobTemplateMap = new Map();
  const areaTemplateMap = new Map();
  for (const r of rows) {
    if (r.site_area_id == null) jobTemplateMap.set(`${r.job_legacy}|${r.stage}|${r.legacy_id}`, r.id);
    else areaTemplateMap.set(`${r.area_legacy}|${r.stage}|${r.legacy_id}`, r.id);
  }
  return { jobTemplateMap, areaTemplateMap };
}

async function currentCounts(sql) {
  const [c] = await sql`
    select (select count(*)::int from public.job_task_templates where deleted_at is null) as templates,
           (select count(*)::int from public.tasks where deleted_at is null)              as tasks,
           (select count(*)::int from public.task_status_events)                          as events
  `;
  return { templates: c.templates, tasks: c.tasks, events: c.events };
}

async function writeTasks(sql, instances, nowIso) {
  return sql.begin(async (sql) => {
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
    const tenantId = tenant[0].id;

    const jobMap = await legacyIdMap(sql, 'jobs', tenantId);
    const areaMap = await legacyIdMap(sql, 'site_areas', tenantId);
    const { jobTemplateMap, areaTemplateMap } = await templateMaps(sql, tenantId);

    const taskRows = buildTaskRows(instances, { tenantId, jobMap, areaMap, jobTemplateMap, areaTemplateMap });

    const taskRet = taskRows.length
      ? await sql`
          insert into public.tasks ${sql(taskRows, ...TASK_INSERT_COLS)}
          on conflict (tenant_id, site_area_id, stage, legacy_template_id)
            where site_area_id is not null and legacy_template_id is not null
          do update set ${setExcluded(sql, TASK_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'tasks', TASK_MUTABLE_COLS)}
          returning id, (xmax = 0) as inserted, status
        `
      : [];

    // One import event per NEWLY-INSERTED task (re-run inserts 0 → 0 events).
    const insertedTasks = taskRet.filter((r) => r.inserted).map((r) => ({ id: r.id, status: r.status }));
    const eventRows = buildEventRows(tenantId, insertedTasks, nowIso);
    if (eventRows.length) {
      await sql`insert into public.task_status_events ${sql(eventRows, ...EVENT_INSERT_COLS)}`;
    }

    const after = await currentCounts(sql);
    return { tenantId, tasks: tally(taskRet, taskRows.length), eventsInserted: eventRows.length, after };
  });
}

function reportProjectionIssues(p) {
  const lines = [];
  if (p.collisions.length) lines.push(`  collisions: ${p.collisions.length} — ${JSON.stringify(p.collisions.slice(0, 5))}`);
  if (p.orphanedState.length) lines.push(`  orphaned state: ${p.orphanedState.length} — ${JSON.stringify(p.orphanedState.slice(0, 5))}`);
  if (p.malformed.length) lines.push(`  malformed: ${p.malformed.length} — ${JSON.stringify(p.malformed.slice(0, 5))}`);
  if (p.badStatus.length) lines.push(`  bad status: ${p.badStatus.length} — ${JSON.stringify(p.badStatus.slice(0, 5))}`);
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/tasks-import.js [--write] [--json]');
    return;
  }

  const sources = await loadSources();
  const projection = buildTaskProjection(sources);

  // GATE: never write off an unclean projection.
  if (!projection.clean) {
    if (args.json) console.log(JSON.stringify({ aborted: true, reason: 'projection not clean', projection }, null, 2));
    else {
      console.error('\nABORTED — projection is NOT clean; fix before importing tasks:');
      for (const l of reportProjectionIssues(projection)) console.error(l);
    }
    process.exitCode = 1;
    return;
  }

  const proposed = { tasks: projection.instances.length, events: projection.instances.length };
  const nowIso = new Date().toISOString();

  let report;
  try {
    if (args.write) {
      const sql = getDb({ mode: 'write' });
      const result = await writeTasks(sql, projection.instances, nowIso);
      report = { mode: 'write', proposed, result, after: result.after };
    } else {
      const sql = getDb({ mode: 'read' });
      const before = await currentCounts(sql);
      report = { mode: 'dry-run', proposed, current: before };
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.mode === 'write') {
    const t = report.result.tasks;
    console.log('\nTasks import — APPLIED (one transaction)');
    console.log(`tenant: ${report.result.tenantId}`);
    console.log(`tasks  ${t.inserted} inserted · ${t.updated} updated · ${t.unchanged} unchanged (of ${t.total})`);
    console.log(`task_status_events  ${report.result.eventsInserted} inserted (one per newly-inserted task)`);
    console.log(`\nPostgres now holds: ${JSON.stringify(report.after)}`);
    console.log('re-run with --write to confirm idempotency (expect 0 inserted, 0 updated, 0 events).');
  } else {
    console.log('\nTasks import — DRY RUN (nothing written)');
    console.log(`projection CLEAN · proposed: ${JSON.stringify(proposed)}`);
    console.log(`current in Postgres: ${JSON.stringify(report.current)}`);
    console.log('\nrun with --write to apply.');
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
