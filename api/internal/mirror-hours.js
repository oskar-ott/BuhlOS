// Scheduled hours mirror REPAIR (#152 trust layer) — the Vercel cron entry point.
//
//   GET /api/internal/mirror-hours
//
// Moves the Postgres copy of the hours back to the Blob truth: every mismatched
// or missing day is re-mirrored through the live mirror write, every PG-only day
// soft-deleted (api/_lib/hours-repair.js — settling, unreadable and mass-delete
// guards live there). Production proof it is needed: the daily hours sync-check
// failed every day from mid-September (67 approvals stuck "submitted" after the
// live mirror timed out; split days without allocations after a job raced its
// own mirror) and nothing ever retried them.
//
// MACHINE-ONLY. A valid CRON_SECRET is mandatory — no open path, not even on
// preview. Secret unset in production → 503 (unconfigured); wrong/absent → 401.
//
// SAFETY: Blob is authoritative and is never written. The only writes are PG
// time_entries / time_entry_allocations rows, made equal to Blob.
//
// GATING (skip CLEANLY, stay green):
//   * no SUPABASE_DB_URL             → skipped (Supabase not wired here).
//   * supabase_dual_write off        → skipped (PG isn't a mirror right now).
//   * supabase_repair_hours off      → DRY RUN: the plan is logged, nothing written
//                                       (the ops kill-switch; default on).
//
// OUTCOME → HTTP: 200 with the summary; 500 when a repair failed or the delete
// breaker tripped (the Vercel cron run shows RED — a free alarm); run error 500.

const { setNoCache } = require('../_lib/blob');
const { cronAuthState } = require('../_lib/cron-auth');
const { isFlagOn } = require('../_lib/feature-flags');
const { getDb } = require('../_lib/supabase-db');
const { repairHoursMirror } = require('../_lib/hours-repair');

async function handleMirrorHours(req, res, deps = {}) {
  const {
    env = process.env,
    cronState = cronAuthState,
    flagOn = isFlagOn,
    db = getDb,
    run = repairHoursMirror,
  } = deps;

  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const state = cronState(req);
  if (state === 'denied') return res.status(401).json({ error: 'unauthorised' });
  if (state === 'unconfigured' || !env.CRON_SECRET) {
    console.error('hours mirror repair refused: CRON_SECRET is not configured');
    return res.status(503).json({ error: 'cron auth unconfigured' });
  }

  if (!env.SUPABASE_DB_URL) return res.status(200).json({ ok: true, skipped: 'no supabase env' });
  if (!(await flagOn('supabase_dual_write'))) return res.status(200).json({ ok: true, skipped: 'dual-write off' });
  const apply = await flagOn('supabase_repair_hours');

  const started = Date.now();
  try {
    const sql = db({ mode: apply ? 'write' : 'read' });
    const out = await run(sql, { apply });
    const { keys, failed, ...summary } = out;
    const line = { ...summary, ms: Date.now() - started };
    console.log(`[hours-repair] ${JSON.stringify(line)}`);
    if (failed && failed.length) console.warn(`[hours-repair] failed: ${JSON.stringify(failed)}`);
    const bad = (out.failedCount || 0) > 0 || out.deleteBreaker;
    return res.status(bad ? 500 : 200).json({ ok: !bad, ...line, failed: failed || [] });
  } catch (err) {
    console.error('[hours-repair] run error:', err && err.message);
    return res.status(500).json({ ok: false, error: (err && err.message) || 'repair failed' });
  }
}

module.exports = handleMirrorHours;
module.exports.handleMirrorHours = handleMirrorHours;
