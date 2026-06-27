// Scheduled evidence-metadata mirror (#152) — the Vercel cron entry point.
//
//   GET /api/internal/mirror-evidence
//
// Reconciles per-job blob evidence (data.json.evidence[]) into Postgres
// evidence_files + evidence_links. This is the async mirror worker that drains the
// field capture's data.json write OFF the request path — api/evidence.js (the
// capture write) is UNCHANGED, so field capture gains ZERO latency. The J9
// mirror-tasks pattern, applied to evidence.
//
// MACHINE-ONLY. A valid CRON_SECRET is mandatory — no open path, not even on
// preview. Secret unset in production → 503 (unconfigured); wrong/absent → 401.
//
// SAFETY: Blob authoritative. The ONLY writes are the idempotent upserts into
// public.evidence_files + public.evidence_links (metadata only — binaries stay in
// Blob). It never touches Blob, never repairs Blob, never flips flags, and a
// failure can never affect a worker's capture (which already succeeded).
//
// GATING (skip CLEANLY, stay green):
//   * no SUPABASE_DB_URL                 → skipped (Supabase not wired, e.g. prod).
//   * supabase_dual_write_evidence off   → skipped (evidence mirror dark).

const { setNoCache } = require('../_lib/blob');
const { cronAuthState } = require('../_lib/cron-auth');
const { mirrorEvidence } = require('../_lib/evidence-mirror');

async function handleMirrorEvidence(req, res, deps = {}) {
  const { env = process.env, cronState = cronAuthState, run = mirrorEvidence } = deps;

  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const state = cronState(req);
  if (state === 'denied') return res.status(401).json({ error: 'unauthorised' });
  if (state === 'unconfigured' || !env.CRON_SECRET) {
    console.error('evidence mirror refused: CRON_SECRET is not configured');
    return res.status(503).json({ error: 'cron auth unconfigured' });
  }

  // mirrorEvidence gates internally (env + flag) and is best-effort (never throws).
  const summary = await run();
  // A best-effort run error → 500 so the Vercel cron run shows RED (a free alarm);
  // it never affected a worker's capture (Blob is authoritative).
  if (summary && summary.reason === 'error') {
    return res.status(500).json({ ok: false, error: summary.error });
  }
  // Gated skip (no env / flag off) → stay green.
  if (summary && summary.ran === false) {
    return res.status(200).json({ ok: true, skipped: true, reason: summary.reason });
  }
  return res.status(200).json({ ok: true, ...summary });
}

module.exports = handleMirrorEvidence;
module.exports.handleMirrorEvidence = handleMirrorEvidence;
