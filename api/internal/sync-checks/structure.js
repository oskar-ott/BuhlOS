// Scheduled structure drift-check (#152 trust layer) — the Vercel cron entry point.
//
//   GET /api/internal/sync-checks/structure
//
// Runs the recorded Blob↔Postgres drift-check for the place structure + tasks +
// evidence (api/_lib/structure-sync.runStructureSyncCheck) and INSERTs one
// append-only row into public.sync_checks (domain 'structure'), so /sync-status
// shows a fresh result without anyone running the manual CLI. This is the SAME
// check the operator runner performs — the jobs/tasks/evidence counterpart of the
// hours sync-check cron, and the drift alarm the read-cutover enablement leans on.
//
// MACHINE-ONLY. A valid CRON_SECRET is mandatory — no open path, not even on
// preview. Secret unset in prod → 503; wrong/absent → 401. The secret never
// reaches logs or bodies.
//
// SAFETY: read-only against domain data; the ONLY write is the sync_checks row.
// It never repairs, backfills or mutates jobs/tasks/evidence — drift is recorded,
// not "fixed". It does not flip flags.
//
// GATING (skip CLEANLY, stay green) so the cron is quiet until it has something to
// verify and never cries false drift:
//   * no SUPABASE_DB_URL → skipped (Supabase not wired here, e.g. prod today).
//   * BOTH supabase_dual_write_jobs AND supabase_dual_write_tasks off → skipped
//     (PG isn't being mirrored, so a Blob≠PG difference is expected by design,
//     not actionable drift). If either is on, the check runs.
//
// OUTCOME → HTTP:
//   * pass         → 200 { ok:true,  recorded:true,  status:'pass', … }
//   * fail (drift) → 500 { ok:false, recorded:true,  status:'fail', … } so the
//                    Vercel cron run shows RED (a free alarm beyond /sync-status).
//                    The row is recorded BEFORE responding.
//   * run error    → 500 { ok:false, error } (nothing recorded).

const { setNoCache } = require('../../_lib/blob');
const { cronAuthState } = require('../../_lib/cron-auth');
const { isFlagOn } = require('../../_lib/feature-flags');
const { getDb } = require('../../_lib/supabase-db');
const { runStructureSyncCheck } = require('../../_lib/structure-sync');

function summarise(report) {
  return {
    status: report.status,
    blobCount: report.blobCount,
    pgCount: report.pgCount,
    matched: report.matched,
    onlyInBlob: report.onlyInBlobCount,
    onlyInPg: report.onlyInPgCount,
    mismatched: report.mismatchedCount,
    unmappable: report.unmappableCount,
    hashMatch: report.details ? report.details.hashMatch : undefined,
    durationMs: report.durationMs,
  };
}

async function handleStructureSyncCheck(req, res, deps = {}) {
  const {
    env = process.env,
    cronState = cronAuthState,
    flagOn = isFlagOn,
    db = getDb,
    run = runStructureSyncCheck,
  } = deps;

  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Machine-only gate: a valid secret is mandatory; never an open path.
  const state = cronState(req);
  if (state === 'denied') return res.status(401).json({ error: 'unauthorised' });
  if (state === 'unconfigured' || !env.CRON_SECRET) {
    console.error('structure sync-check refused: CRON_SECRET is not configured');
    return res.status(503).json({ error: 'cron auth unconfigured' });
  }

  // Gate cleanly — stay green when there is nothing to verify.
  if (!env.SUPABASE_DB_URL) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'supabase not configured' });
  }
  // Structure drift is only actionable once PG is being mirrored. Run if EITHER
  // the jobs/structure or the task dual-write is on.
  const [jobsOn, tasksOn] = await Promise.all([
    flagOn('supabase_dual_write_jobs'),
    flagOn('supabase_dual_write_tasks'),
  ]);
  if (!jobsOn && !tasksOn) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'structure/task dual-write disabled' });
  }

  try {
    const sql = db({ mode: 'write' }); // serverless: reuse the warm singleton, no closeDb
    const report = await run(sql, { record: true });
    const body = { ok: report.status === 'pass', recorded: Boolean(report.recorded), ...summarise(report) };
    if (report.status !== 'pass') {
      body.note = 'drift recorded to sync_checks — see /sync-status';
      return res.status(500).json(body);
    }
    return res.status(200).json(body);
  } catch (err) {
    console.error('structure sync-check failed:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'sync-check failed' });
  }
}

module.exports = handleStructureSyncCheck;
module.exports.handleStructureSyncCheck = handleStructureSyncCheck;
