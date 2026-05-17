// Per-job tool tags. Append-safe: POST adds a single record, PUT updates by
// id, DELETE soft-deletes by id. Old shapes (single-record blob, raw array,
// { entries: [...] }) are read back without data loss.

const { setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const {
  readList, appendRecord, updateRecord, deleteRecord,
} = require('./_lib/listblob');

const FIELD = 'tags';

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const KEY = `jobs/${jobId}/tags.json`;

  if (req.method === 'GET') {
    const tags = (await readList(KEY, FIELD)).filter(t => t && t.status !== 'deleted');
    return res.status(200).json({ tags, [FIELD]: tags });
  }

  if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      // Legacy bulk replace: { tags: [...] } posted from somewhere that
      // already owns the full list. Accept it (admins only — guard against
      // a tradie wiping the list).
      if (Array.isArray(body[FIELD]) || Array.isArray(body.entries)) {
        if (user.role !== 'admin') return res.status(403).json({ error: 'admin only for bulk replace' });
        const list = Array.isArray(body[FIELD]) ? body[FIELD] : body.entries;
        await require('./_lib/listblob').writeList(KEY, FIELD, list);
        return res.status(200).json({ ok: true, tags: list });
      }
      // Single record append (the bug-fix path).
      const { record, list } = await appendRecord(KEY, FIELD, body, user, 'tag');
      return res.status(200).json({ ok: true, tag: record, tags: list });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'PUT') {
    const id = (req.body && req.body.id) || (req.query && req.query.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const { record, list } = await updateRecord(KEY, FIELD, id, req.body || {}, user);
      if (!record) return res.status(404).json({ error: 'tag not found' });
      return res.status(200).json({ ok: true, tag: record, tags: list });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    const id = (req.body && req.body.id) || (req.query && req.query.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const { ok, list } = await deleteRecord(KEY, FIELD, id, user);
      if (!ok) return res.status(404).json({ error: 'tag not found' });
      return res.status(200).json({ ok: true, tags: list.filter(t => t && t.status !== 'deleted') });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
