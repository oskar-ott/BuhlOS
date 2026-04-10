const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

const FIELD = 'hours' === 'hours' ? 'entries' : 'hours';

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  // Clients cannot see hours
  if ('hours' === 'hours' && user.role === 'client') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const KEY = `jobs/${jobId}/hours.json`;

  if (req.method === 'GET') {
    const data = await readBlob(KEY, { [FIELD]: [] });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    try {
      await writeBlob(KEY, req.body);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
