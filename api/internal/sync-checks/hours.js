// Scheduled hours drift-check (#152 trust layer) — the Vercel cron entry point.
//
//   GET /api/internal/sync-checks/hours
//
// Runs the recorded Blob↔Postgres hours drift-check (api/_lib/hours-sync) and
// INSERTs one append-only row into public.sync_checks, so /sync-status shows a
// fresh result without anyone running the manual CLI. This is the SAME check the
// operator runner performs.
//
// MACHINE-ONLY. A valid CRON_SECRET is mandatory — there is NO open path, not
// even on preview (humans use the CLI, never this URL). With the secret unset in
// production the call refuses 503 (cron auth unconfigured); a wrong/absent secret
// is 401. The secret value never reaches logs or bodies.
//
// SAFETY: read-only against domain data; the ONLY write is the sync_checks row.
// It never repairs, backfills or mutates hours data — drift is recorded, not
// "fixed". It does not flip flags or touch jobs/tasks.
//
// GATING (skip CLEANLY, stay green) so the cron is quiet until it has something
// to verify and never cries false drift:
//   * no SUPABASE_DB_URL          → skipped (Supabase not wired here, e.g. prod
//                                    today) — no connection is opened.
//   * supabase_dual_write flag off → skipped (PG isn't being mirrored, so a
//                                    Blob≠PG difference is expected by design,
//                                    not actionable drift).
//
// OUTCOME → HTTP:
//   * pass            → 200 { ok:true,  recorded:true,  status:'pass', … }
//   * fail (drift)    → 500 { ok:false, recorded:true,  status:'fail', … } so
//                       the Vercel cron run shows RED (a free second alarm beyond
//                       /sync-status). The row is recorded BEFORE responding.
//   * run error       → 500 { ok:false, error } (nothing recorded).

const { setNoCache } = require('../../_lib/blob');
const { cronAuthState } = require('../../_lib/cron-auth');
const { isFlagOn } = require('../../_lib/feature-flags');
const { getDb } = require('../../_lib/supabase-db');
const { runHoursSyncCheck } = require('../../_lib/hours-sync');

function summarise(report) {
  return {
    status: report.status,
    blobCount: report.blobCount,
    pgCount: report.pgCount,
    blobTotal: report.blobTotal,
    pgTotal: report.pgTotal,
    matched: report.matched,
    onlyInBlob: report.onlyInBlobCount,
    onlyInPg: report.onlyInPgCount,
    mismatched: report.mismatchedCount,
    hashMatch: report.details ? report.details.hashMatch : undefined,
    durationMs: report.durationMs,
  };
}

async function handleHoursSyncCheck(req, res, deps = {}) {
  const {
    env = process.env,
    cronState = cronAuthState,
    flagOn = isFlagOn,
    db = getDb,
    run = runHoursSyncCheck,
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
    // 'unconfigured' = prod with no secret; the !CRON_SECRET branch also closes
    // the preview/dev permissive case (cronAuthState → 'ok' with no secret).
    console.error('hours sync-check refused: CRON_SECRET is not configured');
    return res.status(503).json({ error: 'cron auth unconfigured' });
  }

  // Gate cleanly — stay green when there is nothing to verify.
  if (!env.SUPABASE_DB_URL) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'supabase not configured' });
  }
  if (!(await flagOn('supabase_dual_write'))) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'dual-write disabled' });
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
    console.error('hours sync-check failed:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'sync-check failed' });
  }
}

module.exports = handleHoursSyncCheck;
module.exports.handleHoursSyncCheck = handleHoursSyncCheck;
