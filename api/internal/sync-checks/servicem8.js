// Scheduled ServiceM8 → BuhlOS job sync — the Vercel cron entry point.
//
//   GET /api/internal/sync-checks/servicem8
//
// Runs the daily ServiceM8 job sync (api/_lib/servicem8-sync): pulls the
// active 'Work Order' jobs from ServiceM8, auto-creates any that are missing
// from BuhlOS (so a field worker is never blocked from logging hours because
// the job only exists in ServiceM8), and writes the servicem8-sync.json
// report the command-centre card renders.
//
// MACHINE-ONLY. A valid CRON_SECRET is mandatory — there is NO open path,
// same posture as the hours sync-check. The secret never reaches logs/bodies.
//
// GATING (skip CLEANLY, stay green):
//   * servicem8_sync flag off   → skipped — the integration is dark.
//   * SERVICEM8_API_KEY unset   → the run itself records status 'skipped' in
//                                 the report (the card shows the config hint)
//                                 and this responds 200.
//
// OUTCOME → HTTP:
//   * ok / skipped   → 200 { ok:true, … }
//   * error          → 500 { ok:false, … } so the Vercel cron run shows RED
//                      (the report blob is still written first — the card
//                      never shows a stale "all matched" after a failure).

const { setNoCache } = require('../../_lib/blob');
const { cronAuthState } = require('../../_lib/cron-auth');
const { isFlagOn } = require('../../_lib/feature-flags');
const { runServiceM8Sync } = require('../../_lib/servicem8-sync');

async function handleServiceM8SyncCheck(req, res, deps = {}) {
  const {
    env = process.env,
    cronState = cronAuthState,
    flagOn = isFlagOn,
    run = runServiceM8Sync,
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
    console.error('servicem8 sync refused: CRON_SECRET is not configured');
    return res.status(503).json({ error: 'cron auth unconfigured' });
  }

  // Gate cleanly — dark integration does nothing at all.
  if (!(await flagOn('servicem8_sync'))) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'servicem8_sync flag off' });
  }

  try {
    const report = await run({ env });
    const body = {
      ok: report.status !== 'error',
      status: report.status,
      sm8Count: report.sm8Count,
      matchedCount: report.matchedCount,
      created: (report.created || []).length,
      failed: (report.failed || []).length,
      needsAssignment: (report.needsAssignment || []).length,
      ...(report.reason ? { reason: report.reason } : {}),
      ...(report.error ? { error: report.error } : {}),
    };
    return res.status(report.status === 'error' ? 500 : 200).json(body);
  } catch (err) {
    console.error('servicem8 sync failed:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'sync failed' });
  }
}

module.exports = handleServiceM8SyncCheck;
module.exports.handleServiceM8SyncCheck = handleServiceM8SyncCheck;
