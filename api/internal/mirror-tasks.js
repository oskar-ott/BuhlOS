// Scheduled task-state mirror (#152, J9) — the Vercel cron entry point.
//
//   GET /api/internal/mirror-tasks
//
// Reconciles per-job task STATUS from the authoritative jobs/{id}/data.json into
// Postgres tasks.status (+ append-only task_status_events for real transitions).
// This is the async mirror worker that drains the toggle's data.json write OFF the
// request path, so the high-frequency task-toggle gains ZERO latency.
//
// MACHINE-ONLY. A valid CRON_SECRET is mandatory — no open path, not even on
// preview. Secret unset in production → 503 (unconfigured); wrong/absent → 401.
//
// SAFETY: Blob authoritative. The ONLY writes are public.tasks.status (idempotent,
// IS DISTINCT FROM) and append-only public.task_status_events (one per real
// transition). It never touches Blob, never repairs Blob, never flips flags, and
// a failure can never affect a worker's task toggle (which already succeeded).
//
// GATING (skip CLEANLY, stay green):
//   * no SUPABASE_DB_URL              → skipped (Supabase not wired, e.g. prod).
//   * supabase_dual_write_tasks off   → skipped (task mirror dark).
//
// This entry point also carries the jobs-mirror RECONCILE sweep
// (api/_lib/jobs-reconcile.js): the write-through job mirror is one-shot, so a
// transient failure at create time leaves a permanent hole until the job is
// re-saved (prod proof: DCA Alexandria, absent twelve days → quarantined hours
// allocations). The sweep re-mirrors any jobs.json id missing from public.jobs
// every cron tick. Independently gated on supabase_dual_write_jobs — either
// half can run while the other is dark.

const { setNoCache } = require('../_lib/blob');
const { cronAuthState } = require('../_lib/cron-auth');
const { mirrorTasks } = require('../_lib/task-mirror');
const { reconcileJobsMirror } = require('../_lib/jobs-reconcile');

async function handleMirrorTasks(req, res, deps = {}) {
  const {
    env = process.env,
    cronState = cronAuthState,
    run = mirrorTasks,
    reconcile = reconcileJobsMirror,
  } = deps;

  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const state = cronState(req);
  if (state === 'denied') return res.status(401).json({ error: 'unauthorised' });
  if (state === 'unconfigured' || !env.CRON_SECRET) {
    console.error('task mirror refused: CRON_SECRET is not configured');
    return res.status(503).json({ error: 'cron auth unconfigured' });
  }

  // Both halves gate internally (env + flag) and are best-effort (never throw).
  const summary = await run();
  const jobsReconcile = await reconcile();
  // A best-effort run error in EITHER half → 500 so the Vercel cron run shows
  // RED (a free alarm); neither ever affected a worker's write (Blob is
  // authoritative).
  if (summary && summary.reason === 'error') {
    return res.status(500).json({ ok: false, error: summary.error, jobsReconcile });
  }
  if (jobsReconcile && jobsReconcile.reason === 'error') {
    return res.status(500).json({ ok: false, error: jobsReconcile.error, jobsReconcile });
  }
  // Gated skip on BOTH halves (no env / flags off / no tenant) → stay green.
  const tasksSkipped = summary && summary.ran === false;
  const reconcileSkipped = jobsReconcile && jobsReconcile.ran === false;
  if (tasksSkipped && reconcileSkipped) {
    return res.status(200).json({ ok: true, skipped: true, reason: summary.reason, jobsReconcile });
  }
  if (tasksSkipped) {
    // Task mirror dark but the jobs sweep ran — report the sweep, keep the
    // task-skip reason visible.
    return res.status(200).json({ ok: true, tasksSkipped: summary.reason, jobsReconcile });
  }
  return res.status(200).json({ ok: true, ...summary, jobsReconcile });
}

module.exports = handleMirrorTasks;
module.exports.handleMirrorTasks = handleMirrorTasks;
