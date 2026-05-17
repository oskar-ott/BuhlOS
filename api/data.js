// Generic per-job data blob (dwellings, snags, notes). Phil and Switchboard
// both read+write through here for bulk operations. Stage transitions and
// snag close/reopen should prefer /api/workflow which adds validation +
// audit; this endpoint stays so existing bulk save flows keep working.
//
// Sanitisation on POST:
//   - Ensure every snag has an id (workflow.js looks up by id).
//   - Ensure every snag has a createdAt timestamp.
//   - Diff the snag list against the prior version to emit audit entries
//     for new / resolved snags (best-effort observability).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const { appendAudit } = require('./_lib/audit');

function ensureSnagIds(snags) {
  if (!Array.isArray(snags)) return [];
  return snags.map(s => {
    if (!s || typeof s !== 'object') return s;
    if (!s.id) {
      s.id = 'snag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    if (!s.createdAt) s.createdAt = new Date().toISOString();
    return s;
  });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const KEY = `jobs/${jobId}/data.json`;

  if (req.method === 'GET') {
    const data = await readBlob(KEY, { dwellings: {}, snags: [], notes: [] });
    data.snags = ensureSnagIds(data.snags);
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    try {
      const incoming = (req.body && typeof req.body === 'object') ? { ...req.body } : {};
      incoming.dwellings = incoming.dwellings || {};
      incoming.snags = ensureSnagIds(incoming.snags);
      incoming.notes = Array.isArray(incoming.notes) ? incoming.notes : [];

      // Best-effort audit diff for snags.
      try {
        const prior = await readBlob(KEY, { snags: [] });
        const priorSnags = Array.isArray(prior.snags) ? prior.snags : [];
        const priorById = new Map(priorSnags.map(s => [s.id, s]));
        incoming.snags.forEach(s => {
          const before = priorById.get(s.id);
          if (!before) {
            appendAudit(jobId, {
              type: 'snag_raised',
              snagId: s.id, areaId: s.dwelling, stageName: s.stage,
              source: user.role === 'admin' ? 'switchboard' : 'phil',
              reason: s.priority || null,
            }, user);
          } else if ((before.status || 'Open') !== (s.status || 'Open') &&
                     (s.status === 'Resolved')) {
            appendAudit(jobId, {
              type: 'snag_resolved',
              snagId: s.id, areaId: s.dwelling, stageName: s.stage,
              source: user.role === 'admin' ? 'switchboard' : 'phil',
              reason: s.resolution || null,
            }, user);
          }
        });
      } catch {} // audit must never block the write

      await writeBlob(KEY, incoming);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
