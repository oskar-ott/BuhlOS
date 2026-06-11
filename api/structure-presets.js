// Reusable area-group presets (#192).
//
//   GET    /api/structure-presets                 → list (admin tier)
//   POST   ?action=capture {jobId, groupId, name} → save a job's group as a
//                                                   named global preset
//   PATCH  {id, name}                             → rename
//   DELETE ?id=                                   → delete (jobs that used a
//                                                   preset are untouched —
//                                                   inserts are copies)
//
// Capture happens SERVER-side from the saved job via the same mapper family
// duplication uses (api/_lib/job-duplicate.js): ids stripped, archived
// areas/tasks skipped, no task state. Inserting back into a job happens
// CLIENT-side in the builder (src/domains/jobs/structure-presets.ts) and
// flows through the normal validated PUT — the validators mint fresh ids.
//
// Storage: structure-presets.json { presets: [{id, name, group, createdAt,
// createdById, createdByName, sourceJobId}] } — in the backup manifest and
// shape-guarded by blob-guards.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { captureGroup } = require('./_lib/job-duplicate');
const { appendAudit } = require('./_lib/job-audit');

const STORE_KEY = 'structure-presets.json';
const NAME_MAX = 80;

async function readStore() {
  return readBlob(STORE_KEY, { presets: [] });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Presets are office tooling — the whole admin tier, like the builder.
  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  if (req.method === 'GET') {
    const store = await readStore();
    return res.status(200).json({ presets: store.presets || [] });
  }

  if (req.method === 'POST' && (req.query && req.query.action) === 'capture') {
    const { jobId, groupId, name } = req.body || {};
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!jobId || !groupId) return res.status(400).json({ error: 'jobId and groupId required' });
    if (!trimmed) return res.status(400).json({ error: 'name required' });
    if (trimmed.length > NAME_MAX) return res.status(400).json({ error: `name must be ${NAME_MAX} characters or fewer` });

    const jobsData = await readBlob('jobs.json', { jobs: [] });
    const job = (jobsData.jobs || []).find(j => j && j.id === jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const group = (job.areaGroups || []).find(g => g && g.id === groupId);
    if (!group) return res.status(404).json({ error: 'area group not found on this job' });
    if (group.archived) return res.status(400).json({ error: 'archived groups cannot become presets' });

    const store = await readStore();
    if (!Array.isArray(store.presets)) store.presets = [];
    if (store.presets.some(p => p && p.name === trimmed)) {
      return res.status(409).json({ error: 'a preset with that name already exists' });
    }
    const preset = {
      id: nanoid('sp_'),
      name: trimmed,
      group: captureGroup(group),
      sourceJobId: job.id,
      createdById: me.id,
      createdByName: me.username || me.id,
      createdAt: new Date().toISOString(),
    };
    store.presets.push(preset);
    try {
      await writeBlob(STORE_KEY, store);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
    await appendAudit(job.id, {
      byUserId: me.id,
      byUsername: me.username || me.id,
      kind: 'preset.captured',
      summary: `Saved area group "${group.name}" as preset "${trimmed}"`,
    }).catch(() => {});
    return res.status(201).json({ preset });
  }

  if (req.method === 'PATCH') {
    const { id, name } = req.body || {};
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!trimmed) return res.status(400).json({ error: 'name required' });
    if (trimmed.length > NAME_MAX) return res.status(400).json({ error: `name must be ${NAME_MAX} characters or fewer` });
    const store = await readStore();
    const preset = (store.presets || []).find(p => p && p.id === id);
    if (!preset) return res.status(404).json({ error: 'preset not found' });
    if ((store.presets || []).some(p => p && p.id !== id && p.name === trimmed)) {
      return res.status(409).json({ error: 'a preset with that name already exists' });
    }
    preset.name = trimmed;
    preset.updatedAt = new Date().toISOString();
    try {
      await writeBlob(STORE_KEY, store);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
    return res.status(200).json({ preset });
  }

  if (req.method === 'DELETE') {
    const id = String((req.query && req.query.id) || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    const store = await readStore();
    const before = (store.presets || []).length;
    store.presets = (store.presets || []).filter(p => p && p.id !== id);
    if (store.presets.length === before) return res.status(404).json({ error: 'preset not found' });
    try {
      await writeBlob(STORE_KEY, store);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
