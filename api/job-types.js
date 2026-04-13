// Job-type templates: named types with default area groups.
// Blob key: job-types.json
// Shape: { jobTypes: [{ id, name, defaultAreaGroups: [{ id, name, areas: [{ id, name }] }] }] }
// All actions are admin-only.
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { nanoid, parseGroups } = require('./_lib/validation');

const BLOB_KEY = 'job-types.json';

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const action = (req.query && req.query.action) || '';

  // GET ?action=list
  if (req.method === 'GET' && action === 'list') {
    const data = await readBlob(BLOB_KEY, { jobTypes: [] });
    return res.status(200).json({ jobTypes: data.jobTypes || [] });
  }

  // POST ?action=create  { name, defaultAreaGroups }
  if (req.method === 'POST' && action === 'create') {
    const { name, defaultAreaGroups } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'name must be a non-empty string' });
    const parsed = parseGroups(defaultAreaGroups ?? [], 'defaultAreaGroups');
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const newType = { id: nanoid('jt_'), name: name.trim(), defaultAreaGroups: parsed.groups };
    const data = await readBlob(BLOB_KEY, { jobTypes: [] });
    data.jobTypes = [...(data.jobTypes || []), newType];
    await writeBlob(BLOB_KEY, data);
    return res.status(200).json({ jobType: newType });
  }

  // POST ?action=update  { id, name, defaultAreaGroups }
  if (req.method === 'POST' && action === 'update') {
    const { id, name, defaultAreaGroups } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });
    if (!name || typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'name must be a non-empty string' });
    const parsed = parseGroups(defaultAreaGroups ?? [], 'defaultAreaGroups');
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const data = await readBlob(BLOB_KEY, { jobTypes: [] });
    const idx = (data.jobTypes || []).findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'job type not found' });

    const updated = { id, name: name.trim(), defaultAreaGroups: parsed.groups };
    data.jobTypes[idx] = updated;
    await writeBlob(BLOB_KEY, data);
    return res.status(200).json({ jobType: updated });
  }

  // POST ?action=delete  { id }
  if (req.method === 'POST' && action === 'delete') {
    const { id } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });

    // Reject if any job references this type
    const jobs = await readBlob('jobs.json', { jobs: [] });
    const inUse = (jobs.jobs || []).some(j => j.type === id);
    if (inUse) return res.status(409).json({ error: 'job type is in use by one or more jobs and cannot be deleted' });

    const data = await readBlob(BLOB_KEY, { jobTypes: [] });
    const before = (data.jobTypes || []).length;
    data.jobTypes = (data.jobTypes || []).filter(t => t.id !== id);
    if (data.jobTypes.length === before) return res.status(404).json({ error: 'job type not found' });

    await writeBlob(BLOB_KEY, data);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'unknown action' });
};
