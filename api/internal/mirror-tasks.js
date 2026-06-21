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

const { setNoCache } = require('../_lib/blob');
const { cronAuthState } = require('../_lib/cron-auth');
const { mirrorTasks } = require('../_lib/task-mirror');

async function handleMirrorTasks(req, res, deps = {}) {
  const { env = process.env, cronState = cronAuthState, run = mirrorTasks } = deps;

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

  // mirrorTasks gates internally (env + flag) and is best-effort (never throws).
  const summary = await run();
  // A best-effort run error → 500 so the Vercel cron run shows RED (a free alarm);
  // it never affected a worker's toggle (Blob is authoritative).
  if (summary && summary.reason === 'error') {
    return res.status(500).json({ ok: false, error: summary.error });
  }
  // Gated skip (no env / flag off / no tenant) → stay green.
  if (summary && summary.ran === false) {
    return res.status(200).json({ ok: true, skipped: true, reason: summary.reason });
  }
  return res.status(200).json({ ok: true, ...summary });
}

module.exports = handleMirrorTasks;
module.exports.handleMirrorTasks = handleMirrorTasks;
