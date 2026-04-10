const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, getCurrentUser } = require('./_lib/auth');

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  const data = await readBlob('jobs.json', { jobs: [] });
  data.jobs = data.jobs || [];

  // GET - list jobs the user can see
  if (req.method === 'GET') {
    const { id } = req.query || {};
    if (id) {
      const job = data.jobs.find(j => j.id === id);
      if (!job) return res.status(404).json({ error: 'job not found' });
      const canSee =
        me.role === 'admin' ||
        (me.assignedJobIds || []).includes(id) ||
        (me.role === 'client' && job.clientUserId === me.id);
      if (!canSee) return res.status(403).json({ error: 'forbidden' });
      return res.status(200).json({ job });
    }
    let visible;
    if (me.role === 'admin') {
      visible = data.jobs;
    } else if (me.role === 'client') {
      visible = data.jobs.filter(j => j.clientUserId === me.id);
    } else {
      visible = data.jobs.filter(j => (me.assignedJobIds || []).includes(j.id));
    }
    return res.status(200).json({ jobs: visible });
  }

  // admin-only for writes
  if (me.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

  if (req.method === 'POST') {
    const { name, id, clientUserId } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const jobId = slugify(id || name);
    if (!jobId) return res.status(400).json({ error: 'invalid id' });
    if (data.jobs.find(j => j.id === jobId)) {
      return res.status(400).json({ error: 'job id already exists' });
    }
    const job = {
      id: jobId,
      name,
      clientUserId: clientUserId || null,
      stages: {
        roughIn: ['Conduit', 'Cables', 'Rough-In Complete'],
        fitOff: ['Fit-Off', 'Test', 'Handover'],
      },
      createdAt: new Date().toISOString(),
      status: 'active',
    };
    data.jobs.push(job);
    await writeBlob('jobs.json', data);
    // initialise empty job data
    await writeBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });
    await writeBlob(`jobs/${jobId}/tags.json`, { tags: [] });
    await writeBlob(`jobs/${jobId}/temps.json`, { temps: [] });
    await writeBlob(`jobs/${jobId}/hours.json`, { entries: [] });
    return res.status(200).json({ job });
  }

  if (req.method === 'PUT') {
    const { id, name, clientUserId, status, stages } = req.body || {};
    const job = data.jobs.find(j => j.id === id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    if (name) job.name = name;
    if (clientUserId !== undefined) job.clientUserId = clientUserId;
    if (status) job.status = status;
    if (stages) job.stages = stages;
    await writeBlob('jobs.json', data);
    return res.status(200).json({ job });
  }

  res.status(405).end();
};
