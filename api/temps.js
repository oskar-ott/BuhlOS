// Per-job temporary installs (power, lighting, etc.). Append-safe.
// Old shape (single-record blob accidentally written as whole blob) is
// recovered on read so existing data is not lost.

const { setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const {
  readList, writeList, appendRecord, updateRecord, deleteRecord,
} = require('./_lib/listblob');

const FIELD = 'temps';

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const KEY = `jobs/${jobId}/temps.json`;

  if (req.method === 'GET') {
    const temps = (await readList(KEY, FIELD)).filter(t => t && t.status !== 'deleted');
    return res.status(200).json({ temps, [FIELD]: temps });
  }

  if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      if (Array.isArray(body[FIELD]) || Array.isArray(body.entries)) {
        if (user.role !== 'admin') return res.status(403).json({ error: 'admin only for bulk replace' });
        const list = Array.isArray(body[FIELD]) ? body[FIELD] : body.entries;
        await writeList(KEY, FIELD, list);
        return res.status(200).json({ ok: true, temps: list });
      }
      const { record, list } = await appendRecord(KEY, FIELD, body, user, 'temp');
      return res.status(200).json({ ok: true, temp: record, temps: list });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'PUT') {
    const id = (req.body && req.body.id) || (req.query && req.query.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const { record, list } = await updateRecord(KEY, FIELD, id, req.body || {}, user);
      if (!record) return res.status(404).json({ error: 'temp not found' });
      return res.status(200).json({ ok: true, temp: record, temps: list });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    const id = (req.body && req.body.id) || (req.query && req.query.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const { ok, list } = await deleteRecord(KEY, FIELD, id, user);
      if (!ok) return res.status(404).json({ error: 'temp not found' });
      return res.status(200).json({ ok: true, temps: list.filter(t => t && t.status !== 'deleted') });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
