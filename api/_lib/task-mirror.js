// J9 — Task STATE dual-write mirror (#152). Best-effort, Blob-authoritative.
//
// Reconciles per-job task STATUS from the authoritative jobs/{id}/data.json into
// Postgres tasks.status, appending an append-only task_status_event for each REAL
// transition. Delivered OFF the request path by the scheduled cron
// (api/internal/mirror-tasks) — the high-frequency task-toggle write path is
// UNCHANGED (zero added latency). The toggle's existing data.json write IS the
// durable enqueue; this is the async mirror worker that drains it.
//
// Blob authoritative: a PG failure never affects field work (the toggle already
// succeeded). Triple-gated so production is inert: no SUPABASE_DB_URL → skip;
// supabase_dual_write_tasks flag off (default) → skip; getDb({mode:'write'}) runs
// the env guard. Reuses the ONE expansion engine (buildTaskProjection), so the
// mirror and the J3 importer can never diverge; NO new task identity.
//
// Idempotency: a task is updated + an event appended ONLY when the Blob status
// differs from the PG status (UPDATE … WHERE status IS DISTINCT FROM, then an
// event only for rows the UPDATE actually changed). A re-run with no change writes
// 0 rows and 0 events. Unknown statuses are rejected by the projection gate
// (quarantined + reported) — never coerced.

const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
const { buildTaskProjection } = require('../../scripts/importers/lib/task-projection');
const { decomposeLegacyId } = require('../../scripts/importers/lib/structure-legacy-id');

const MIRROR_EVENT_SOURCE = 'mirror'; // reconciled transition (vs importer's 'blob-migration')
const EVENT_COLS = ['tenant_id', 'task_id', 'from_status', 'to_status', 'source', 'actor_label', 'created_at'];

function realReadBlob(key, fallback) {
  return require('./blob').readBlob(key, fallback);
}
async function legacyIdMap(sql, table, tenantId) {
  const rows = await sql`select id, legacy_id from ${sql(table)} where tenant_id = ${tenantId} and legacy_id is not null`;
  return new Map(rows.map((r) => [r.legacy_id, r.id]));
}
// Best-effort actor for a reconciled event: the area's last toucher from data.json
// (per-area, not per-task — reconciliation sees net state, not each toggle's actor).
function actorFor(data, areaLegacy) {
  const d = decomposeLegacyId(areaLegacy);
  const areaId = d ? d.localId : areaLegacy;
  const dw = data && data.dwellings && data.dwellings[areaId];
  return (dw && dw.lastTouchedBy) || null;
}

/**
 * Reconcile ONE job's task statuses (data.json) into Postgres. PURE w.r.t. I/O
 * (sql injected). Idempotent. Returns a tally; never throws on a clean job.
 * @param sql postgres.js client (write)
 * @param ctx { tenantId, jobId (uuid), areaMap, nowIso }
 */
async function reconcileJobTasks(sql, ctx, jobLegacyId, job, data) {
  const projection = buildTaskProjection({ jobs: { jobs: [job] }, jobData: { [jobLegacyId]: data } });
  if (!projection.clean) {
    return {
      quarantined: true,
      reason: 'projection not clean',
      issues: {
        collisions: projection.collisions.length, orphanedState: projection.orphanedState.length,
        malformed: projection.malformed.length, badStatus: projection.badStatus.length,
      },
    };
  }
  const instances = projection.instances;
  if (!instances.length) return { attempted: 0, changed: 0, eventsInserted: 0, unresolved: 0 };

  // Current PG task state for this job, keyed by the canonical bridge.
  const pgRows = await sql`
    select id, site_area_id, stage, legacy_template_id, status
    from public.tasks
    where tenant_id = ${ctx.tenantId} and job_id = ${ctx.jobId} and deleted_at is null
      and site_area_id is not null and legacy_template_id is not null`;
  const pgByKey = new Map(pgRows.map((r) => [`${r.site_area_id}|${r.stage}|${r.legacy_template_id}`, r]));

  let unresolved = 0;
  const changes = [];
  for (const inst of instances) {
    const siteAreaId = ctx.areaMap.get(inst.areaLegacy);
    if (!siteAreaId) { unresolved += 1; continue; } // area not in PG (structure not mirrored)
    const pg = pgByKey.get(`${siteAreaId}|${inst.stage}|${inst.legacyTemplateId}`);
    if (!pg) { unresolved += 1; continue; } // task instance not in PG yet
    if (pg.status !== inst.status) {
      changes.push({ id: pg.id, from: pg.status, to: inst.status, actorLabel: actorFor(data, inst.areaLegacy) });
    }
  }
  if (!changes.length) return { attempted: instances.length, changed: 0, eventsInserted: 0, unresolved };

  let eventsInserted = 0;
  await sql.begin(async (tx) => {
    const events = [];
    for (const c of changes) {
      // IS DISTINCT FROM guard → no-op (and no event) on a concurrent/replayed match.
      const upd = await tx`
        update public.tasks set status = ${c.to}, updated_at = now()
        where tenant_id = ${ctx.tenantId} and id = ${c.id} and status is distinct from ${c.to}
        returning id`;
      if (upd.length) {
        events.push({ tenant_id: ctx.tenantId, task_id: c.id, from_status: c.from, to_status: c.to, source: MIRROR_EVENT_SOURCE, actor_label: c.actorLabel, created_at: ctx.nowIso });
      }
    }
    if (events.length) {
      await tx`insert into public.task_status_events ${tx(events, ...EVENT_COLS)}`;
      eventsInserted = events.length;
    }
  });
  return { attempted: instances.length, changed: changes.length, eventsInserted, unresolved };
}

/**
 * Reconcile ALL jobs' task statuses into Postgres. Best-effort — never throws.
 * Triple-gated (env + flag + write guard). Injectable deps for tests.
 */
async function mirrorTasksIfEnabled(deps = {}) {
  const flagOn = deps.isFlagOn || isFlagOn;
  const db = deps.getDb || getDb;
  const readBlob = deps.readBlob || realReadBlob;
  const tenantSlug = deps.tenantSlug || 'buhl';
  const nowIso = deps.nowIso || new Date().toISOString();
  const startedMs = deps.nowMs ? deps.nowMs() : Date.now();

  if (!process.env.SUPABASE_DB_URL) return { ran: false, reason: 'no supabase env' };
  if (!(await flagOn('supabase_dual_write_tasks'))) return { ran: false, reason: 'flag off' };

  const sql = db({ mode: 'write' }); // env guard runs here; fail-closed
  const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
  if (!tenant.length) return { ran: false, reason: 'no tenant' };
  const tenantId = tenant[0].id;
  const jobMap = await legacyIdMap(sql, 'jobs', tenantId);
  const areaMap = await legacyIdMap(sql, 'site_areas', tenantId);

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const jobs = (jobsBlob && jobsBlob.jobs) || [];
  const summary = { ran: true, jobs: jobs.length, attempted: 0, changed: 0, eventsInserted: 0, unresolved: 0, quarantined: 0, failed: 0, quarantinedJobs: [] };

  for (const job of jobs) {
    const jobId = jobMap.get(job.id);
    if (!jobId) { summary.unresolved += 1; continue; } // job not in PG (structure not mirrored)
    try {
      const data = await readBlob(`jobs/${job.id}/data.json`, { dwellings: {}, snags: [], notes: [] });
      const r = await reconcileJobTasks(sql, { tenantId, jobId, areaMap, nowIso }, job.id, job, data);
      if (r.quarantined) { summary.quarantined += 1; summary.quarantinedJobs.push({ job: job.id, issues: r.issues }); continue; }
      summary.attempted += r.attempted; summary.changed += r.changed; summary.eventsInserted += r.eventsInserted; summary.unresolved += r.unresolved;
    } catch (err) {
      summary.failed += 1;
      console.warn(`[task-mirror] job ${job.id} reconcile failed (best-effort, Blob authoritative):`, err && err.message ? err.message : err);
    }
  }
  summary.latencyMs = (deps.nowMs ? deps.nowMs() : Date.now()) - startedMs;
  return summary;
}

/** Best-effort wrapper — NEVER throws (the cron stays green; Blob authoritative). */
async function mirrorTasks(deps = {}) {
  try {
    return await mirrorTasksIfEnabled(deps);
  } catch (err) {
    console.error('[task-mirror] mirror run failed (best-effort, Blob authoritative):', err && err.message ? err.message : err);
    return { ran: false, reason: 'error', error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { reconcileJobTasks, mirrorTasksIfEnabled, mirrorTasks, MIRROR_EVENT_SOURCE };
