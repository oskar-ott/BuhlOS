// Activity log read + CSV export endpoint.
//
// Per brief §14: scoped views, append-only server log, CSV export
// per scope. The write side is api/_lib/activity.js — every mutating
// endpoint calls appendActivity() after its persist step.
//
// GET /api/activity?scope=hours&limit=200&offset=0
// GET /api/activity?targetPrefix=user:abc
// GET /api/activity?format=csv&scope=hours        — CSV stream
// GET /api/activity?action=verify                  — Merkle chain check
//
// Role gating per brief §05 audit matrix:
//   admin       → all scopes
//   office      → own actions only (filter to actor === me.id)
//   accounts    → scope=hours only
//   leadingHand → own jobs only (filter to target prefix that includes
//                 a job they're assigned to)

const { setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { readActivity, verifyChain } = require('./_lib/activity');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  // Admin + LH + office + accounts can read activity; tradies/clients can't.
  const me = await requireAuth(req, res, { roles: ['admin', 'leadingHand', 'office', 'accounts'] });
  if (!me) return;

  const q = req.query || {};

  if (q.action === 'verify') {
    if (me.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const r = await verifyChain();
    return res.status(200).json(r);
  }

  const limit  = Math.max(1, Math.min(1000, Number(q.limit) || 200));
  const offset = Math.max(0, Number(q.offset) || 0);

  // Role-aware scope hint.
  let scope = q.scope || null;
  if (me.role === 'accounts' && scope !== 'hours' && scope !== 'payroll') {
    scope = 'hours'; // forced — accounts only see money events
  }

  let { entries, total } = await readActivity({
    scope,
    targetPrefix: q.targetPrefix || null,
    limit,
    offset,
  });

  // Office: only own-actor rows. LH: own jobs (target contains job id).
  if (me.role === 'office') {
    entries = entries.filter(e => e.actor === me.id);
  }
  if (me.role === 'leadingHand') {
    const myJobs = new Set(me.assignedJobIds || []);
    entries = entries.filter(e => {
      const t = e.target || '';
      // Targets shape: "job:<id>/..."  or "user:<id>/..." or "snag:<id>".
      // For LH, allow any target that explicitly tags a job they run, OR
      // any user-scoped row where the meta.jobId is one of theirs.
      if (t.startsWith('job:')) {
        const jid = t.slice(4).split('/')[0];
        return myJobs.has(jid);
      }
      if (e.meta && e.meta.jobId && myJobs.has(e.meta.jobId)) return true;
      return false;
    });
  }

  if (q.format === 'csv') {
    const cols = ['ts', 'action', 'scope', 'actor', 'actorName', 'target', 'targetLabel', 'reason', 'hash'];
    const csv = [cols.join(',')]
      .concat(entries.map(r => cols.map(c => csvCell(r[c])).join(',')))
      .join('\n') + '\n';
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="activity_${scope || 'all'}_${stamp}.csv"`);
    return res.status(200).send(csv);
  }

  return res.status(200).json({ entries, total, scope: scope || null });
};

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
