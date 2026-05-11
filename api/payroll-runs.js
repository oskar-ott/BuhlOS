// Payroll-runs log — read-only admin endpoint for the append-only
// payroll-runs.json store written by /api/time-entries-export when a
// real (non-dryRun) export is executed.
//
// Each run records: exportId, hash, actor, at, range, rowCount, summary.
// Brief §08 + §14: hash to activity log → "a payroll run can be replayed
// but not silently re-run."
//
// Admin-only. The summary contains per-worker + per-job costs ex-GST,
// which is sensitive enough to keep gated.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const data = await readBlob('payroll-runs.json', { runs: [] });
  const runs = Array.isArray(data.runs) ? data.runs : [];

  // Newest first. Bound result to the last 200 by default to avoid
  // shipping a huge JSON blob on a long-lived deployment.
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
  const sorted = runs.slice().sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const out = sorted.slice(0, limit);

  return res.status(200).json({ runs: out, total: runs.length });
};
