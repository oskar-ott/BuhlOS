// Job types: simple labels. Shape: { jobTypes: [{ id, name }] }
// All actions admin-only. Lazy-migrates away old defaultAreaGroups on read.
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');

const BLOB_KEY = 'job-types.json';

// Strip defaultAreaGroups if present (lazy migration from old schema).
function clean(types) {
  return types.map(({ defaultAreaGroups: _drop, ...rest }) => rest);
}

async function readTypes() {
  const data = await readBlob(BLOB_KEY, { jobTypes: [] });
  const raw = data.jobTypes || [];
  const hadExtra = raw.some(t => 'defaultAreaGroups' in t);
  const cleaned = clean(raw);
  if (hadExtra) await writeBlob(BLOB_KEY, { jobTypes: cleaned });
  return cleaned;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const action = (req.query && req.query.action) || '';

  // GET ?action=list
  if (req.method === 'GET' && action === 'list') {
    const jobTypes = await readTypes();
    return res.status(200).json({ jobTypes });
  }

  // POST ?action=create  { name }
  if (req.method === 'POST' && action === 'create') {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'name must be a non-empty string' });
    const jobTypes = await readTypes();
    const newType = { id: nanoid('jt_'), name: name.trim() };
    await writeBlob(BLOB_KEY, { jobTypes: [...jobTypes, newType] });
    return res.status(200).json({ jobType: newType });
  }

  // POST ?action=update  { id, name }
  if (req.method === 'POST' && action === 'update') {
    const { id, name } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });
    if (!name || typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'name must be a non-empty string' });
    const jobTypes = await readTypes();
    const idx = jobTypes.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'job type not found' });
    jobTypes[idx] = { id, name: name.trim() };
    await writeBlob(BLOB_KEY, { jobTypes });
    return res.status(200).json({ jobType: jobTypes[idx] });
  }

  // POST ?action=delete  { id }
  if (req.method === 'POST' && action === 'delete') {
    const { id } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });
    const jobs = await readBlob('jobs.json', { jobs: [] });
    const inUse = (jobs.jobs || []).some(j => j.type === id);
    if (inUse) return res.status(409).json({ error: 'job type is in use by one or more jobs and cannot be deleted' });
    const jobTypes = await readTypes();
    const before = jobTypes.length;
    const updated = jobTypes.filter(t => t.id !== id);
    if (updated.length === before) return res.status(404).json({ error: 'job type not found' });
    await writeBlob(BLOB_KEY, { jobTypes: updated });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'unknown action' });
};
