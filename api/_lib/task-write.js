// Task-status PG-as-source write (Stage A, #152). Synchronous per-row CAS write to
// Postgres at request time, behind `supabase_source_tasks`. This is the integrity
// win the migration exists for: a per-row UPDATE replaces Blob's whole-document
// "last writer wins" rewrite, so two clients toggling DIFFERENT tasks can no longer
// stomp each other; the `revision` bump + append-only task_status_event give an
// ordered, auditable history.
//
// BEST-EFFORT — never throws. Returns { pg:false, reason } when it can't write
// (no env / flag off / row not mirrored / error) so the caller falls back to the
// Blob write and FIELD WORK NEVER STOPS (Blob stays authoritative until the
// later retire step). The Blob write-through (in the caller) keeps Blob current, so
// the parity-gated read can never serve stale PG. NO new identity — reuses the
// (jobId,areaId,stage,taskId)→tasks.id bridge. See task-status-pg-source-promotion-adr.md.

const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
const { compositeLegacyId } = require('../../scripts/importers/lib/structure-legacy-id');

const WRITE_EVENT_SOURCE = 'toggle'; // request-time toggle (vs 'mirror' cron / 'blob-migration' importer)
const EVENT_COLS = ['tenant_id', 'task_id', 'from_status', 'to_status', 'source', 'actor_label', 'created_at'];

/**
 * Write ONE task's status to Postgres (CAS), behind the source flag. Best-effort;
 * gates internally (no env / flag off → instant {pg:false}). Injectable deps.
 * @returns {Promise<{pg:boolean, changed?:boolean, reason?:string, error?:string}>}
 */
async function writeTaskStatusToPg(input = {}) {
  const {
    jobId, areaId, stage, taskId, state, actorLabel = null,
    getDb: db = getDb, isFlagOn: flagOn = isFlagOn, tenantSlug = 'buhl', now = Date.now,
  } = input;

  if (!process.env.SUPABASE_DB_URL) return { pg: false, reason: 'no supabase env' };
  try {
    if ((await flagOn('supabase_source_tasks')) !== true) return { pg: false, reason: 'flag off' };

    const sql = db({ mode: 'write' }); // PG-as-source write — env guard runs here
    const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
    if (!tenant.length) return { pg: false, reason: 'no tenant' };
    const tenantId = tenant[0].id;

    const job = (await sql`select id from public.jobs where tenant_id = ${tenantId} and legacy_id = ${jobId} and deleted_at is null`)[0];
    if (!job) return { pg: false, reason: 'job not in pg' };
    // Area/task resolved via the canonical bridge: site_areas.legacy_id is the
    // composite (jobId, areaId); the task is (job, area, stage, legacy_template_id).
    const areaLegacy = compositeLegacyId(jobId, areaId);
    const area = (await sql`select id from public.site_areas where tenant_id = ${tenantId} and legacy_id = ${areaLegacy} and deleted_at is null`)[0];
    if (!area) return { pg: false, reason: 'area not in pg' };
    const task = (await sql`
      select id, status from public.tasks
      where tenant_id = ${tenantId} and job_id = ${job.id} and site_area_id = ${area.id}
        and stage = ${stage} and legacy_template_id = ${taskId} and deleted_at is null`)[0];
    if (!task) return { pg: false, reason: 'task not in pg' };
    if (task.status === state) return { pg: true, changed: false }; // already at target — no-op

    const nowIso = new Date(now()).toISOString();
    let changed = false;
    await sql.begin(async (tx) => {
      // CAS-on-value: update + emit an event ONLY when the stored status still
      // differs — idempotent under a concurrent/replayed identical write. Per-row
      // (not whole-document) → cross-task lost-updates are impossible.
      const upd = await tx`
        update public.tasks set status = ${state}, revision = revision + 1, updated_at = now()
        where tenant_id = ${tenantId} and id = ${task.id} and status is distinct from ${state}
        returning id`;
      if (upd.length) {
        await tx`insert into public.task_status_events ${tx([{
          tenant_id: tenantId, task_id: task.id, from_status: task.status,
          to_status: state, source: WRITE_EVENT_SOURCE, actor_label: actorLabel, created_at: nowIso,
        }], ...EVENT_COLS)}`;
        changed = true;
      }
    });
    return { pg: true, changed };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[task-write] PG task-status write failed (Blob authoritative fallback):', msg);
    return { pg: false, reason: 'error', error: msg };
  }
}

module.exports = { writeTaskStatusToPg };
