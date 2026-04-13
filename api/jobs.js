const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, getCurrentUser } = require('./_lib/auth');
const { parseGroups } = require('./_lib/validation');

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  const data = await readBlob('jobs.json', { jobs: [] });
  data.jobs = data.jobs || [];

  // GET — list or single
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

  // Admin-only for writes
  if (me.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

  // POST — create
  if (req.method === 'POST') {
    const { name, id, clientUserId, type, areaGroups } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const jobId = slugify(id || name);
    if (!jobId) return res.status(400).json({ error: 'invalid id' });
    if (data.jobs.find(j => j.id === jobId))
      return res.status(400).json({ error: 'job id already exists' });

    // Validate type if provided
    if (type) {
      const jtData = await readBlob('job-types.json', { jobTypes: [] });
      const typeExists = (jtData.jobTypes || []).some(t => t.id === type);
      if (!typeExists) return res.status(400).json({ error: 'type not found in job-types.json' });
    }

    // Validate areaGroups if provided
    let parsedGroups = [];
    if (areaGroups !== undefined) {
      const parsed = parseGroups(areaGroups, 'areaGroups');
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      parsedGroups = parsed.groups;
    }

    const job = {
      id: jobId,
      name,
      clientUserId: clientUserId || null,
      type: type || null,
      areaGroups: parsedGroups,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    data.jobs.push(job);
    await writeBlob('jobs.json', data);
    await writeBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });
    await writeBlob(`jobs/${jobId}/tags.json`, { tags: [] });
    await writeBlob(`jobs/${jobId}/temps.json`, { temps: [] });
    await writeBlob(`jobs/${jobId}/hours.json`, { entries: [] });
    return res.status(200).json({ job });
  }

  // PUT — update (patch)
  if (req.method === 'PUT') {
    const { id, name, clientUserId, type, areaGroups, status } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const job = data.jobs.find(j => j.id === id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    if (name !== undefined) {
      if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name must be a non-empty string' });
      job.name = name.trim();
    }
    if (clientUserId !== undefined) job.clientUserId = clientUserId || null;
    if (status !== undefined) job.status = status;

    if (type !== undefined) {
      if (type !== null) {
        const jtData = await readBlob('job-types.json', { jobTypes: [] });
        const typeExists = (jtData.jobTypes || []).some(t => t.id === type);
        if (!typeExists) return res.status(400).json({ error: 'type not found in job-types.json' });
      }
      job.type = type;
    }

    if (areaGroups !== undefined) {
      const parsed = parseGroups(areaGroups, 'areaGroups');
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      // Merge: preserve existing ids for groups/areas already on the job,
      // only generate new ids for newly-added entries (matched by name).
      const existingGroupsByName = {};
      for (const eg of (job.areaGroups || [])) {
        existingGroupsByName[eg.name] = eg;
      }
      job.areaGroups = parsed.groups.map(g => {
        const existing = existingGroupsByName[g.name];
        const groupId = (existing && existing.id) ? existing.id : g.id;
        const existingAreasByName = {};
        for (const ea of (existing ? existing.areas : [])) {
          existingAreasByName[ea.name] = ea;
        }
        const areas = g.areas.map(a => {
          const ea = existingAreasByName[a.name];
          return { id: (ea && ea.id) ? ea.id : a.id, name: a.name };
        });
        return { id: groupId, name: g.name, areas };
      });
    }

    await writeBlob('jobs.json', data);
    return res.status(200).json({ job });
  }

  res.status(405).end();
};
