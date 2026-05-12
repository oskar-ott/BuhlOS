// Read-only API for the per-job structural audit log.
//
//   GET /api/job-audit?jobId=<id>&limit=50
//
// Returns the most-recent entries first. Admin / leading hand on the
// job only — the log shows usernames + timestamps and shouldn't leak
// to tradies or clients.
//
// Writes happen automatically from api/jobs.js (PUT) via the
// _lib/job-audit appendAudit helper. There's no POST here on purpose:
// audit entries are derived, not user-authored.

const { setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');
const { readAudit } = require('./_lib/job-audit');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'forbidden' });

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  const entries = await readAudit(jobId);
  // Newest first.
  const sorted = entries.slice().sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return res.status(200).json({
    jobId,
    count: Math.min(sorted.length, limit),
    total: sorted.length,
    entries: sorted.slice(0, limit),
  });
};
