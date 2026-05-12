// Fast-path single snag close.
//
//   POST /api/snag-quick-close?jobId=<id>
//        body: { snagId, note? }
//
// Companion to snag-quick-raise (#106) and bulk-close-snags (#75).
// One-snag close from the mobile UI without re-posting the whole
// data.json document. The optional `note` is stamped as `closeNote`
// so it surfaces in the snags-export handover CSV (#71).
//
// Response:
//   { snag: { ...the closed snag's full record } }
//
// 404 if the snag id doesn't exist on the job. 400 if it's already
// Closed — caller can tell the difference and reconcile UI.
//
// Permissions: write access (admin / LH / tradie assigned).
// Client: 403.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const me = await requireAuth(req, res, { jobId });
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (!canWrite(me, jobId)) return res.status(403).json({ error: 'no write access to job' });

  const body = req.body || {};
  const snagId = (body.snagId || '').toString();
  const note   = body.note ? String(body.note).trim().slice(0, 500) : '';
  if (!snagId) return res.status(400).json({ error: 'snagId required' });

  const KEY = `jobs/${jobId}/data.json`;
  const data = await readBlob(KEY, { dwellings: {}, snags: [], notes: [] });
  const snag = (data.snags || []).find(s => s && s.id === snagId);
  if (!snag) return res.status(404).json({ error: 'snag not found on job' });
  if ((snag.status || 'Open') === 'Closed') {
    return res.status(400).json({ error: 'snag already closed' });
  }

  const nowIso = new Date().toISOString();
  snag.status    = 'Closed';
  snag.closedAt  = nowIso;
  snag.updatedAt = nowIso;
  snag.updatedBy = me.username;
  if (note) snag.closeNote = note;

  try {
    await writeBlob(KEY, data);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }
  return res.status(200).json({ snag });
};
