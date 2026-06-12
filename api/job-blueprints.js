// Job blueprints (#191) — a small GLOBAL library of reusable job SHAPES.
//
//   GET    /api/job-blueprints                  → list (admin tier; summaries
//                                                 + full structure for instantiate)
//   POST   ?action=capture {jobId, name, description?}
//                                               → save a job's shape as a blueprint
//   PATCH  {id, name?, description?}            → rename / re-describe
//   DELETE ?id=                                 → delete (jobs made from it are
//                                                 untouched — instantiate copies)
//
// "Blueprint" deliberately ≠ the legacy per-job `api/job-templates.js` (a
// per-stage task-list helper) and ≠ `api/structure-presets.js` (one area
// group). A blueprint is the WHOLE job's cross-site shape: structure +
// modules + custom fields + job-level default task lists, captured via the
// shared mapper family (api/_lib/job-duplicate.js) — ids stripped, archived
// skipped, no state, and NO site/client/dates/money (those are per-job, not
// per-shape). Instantiation is client-side: the structure flows through the
// normal validated POST /api/jobs, which mints fresh ids + status:'draft'.
//
// Storage: job-blueprints.json { blueprints: [{ id, name, description,
// structure, summary, sourceJobId, createdAt, createdById, createdByName }] }
// — in the backup manifest, shape-guarded by blob-guards.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { captureBlueprintStructure, blueprintSummary } = require('./_lib/job-duplicate');

const STORE_KEY = 'job-blueprints.json';
const NAME_MAX = 80;
const DESC_MAX = 280;

async function readStore() {
  const data = await readBlob(STORE_KEY, { blueprints: [] });
  return Array.isArray(data.blueprints) ? data : { blueprints: [] };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Blueprints are office tooling — the whole admin tier, like the builder
  // and structure presets. (POST /api/jobs create is itself admin-gated, so
  // an instantiated draft never escapes that boundary.)
  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  if (req.method === 'GET') {
    const store = await readStore();
    return res.status(200).json({ blueprints: store.blueprints });
  }

  if (req.method === 'POST' && (req.query && req.query.action) === 'capture') {
    const { jobId, name, description } = req.body || {};
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    if (!trimmed) return res.status(400).json({ error: 'name required' });
    if (trimmed.length > NAME_MAX) return res.status(400).json({ error: `name must be ${NAME_MAX} characters or fewer` });
    const desc = typeof description === 'string' ? description.trim().slice(0, DESC_MAX) : '';

    const jobsData = await readBlob('jobs.json', { jobs: [] });
    const job = (jobsData.jobs || []).find(j => j && j.id === jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });

    const structure = captureBlueprintStructure(job);
    const summary = blueprintSummary(structure);
    if (summary.groupCount === 0 && summary.taskCount === 0) {
      return res.status(400).json({ error: 'this job has no structure to save as a blueprint' });
    }

    const store = await readStore();
    // Duplicate names are a soft-warn at the UI; the server allows them
    // (two estates can legitimately share a shape name). Ids disambiguate.
    const blueprint = {
      id: nanoid('bp_'),
      name: trimmed,
      description: desc,
      structure,
      summary,
      sourceJobId: job.id,
      createdById: me.id,
      createdByName: me.username || me.id,
      createdAt: new Date().toISOString(),
    };
    store.blueprints.push(blueprint);
    try {
      await writeBlob(STORE_KEY, store);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
    return res.status(201).json({ blueprint });
  }

  if (req.method === 'PATCH') {
    const { id, name, description } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const store = await readStore();
    const blueprint = store.blueprints.find(b => b && b.id === id);
    if (!blueprint) return res.status(404).json({ error: 'blueprint not found' });
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'name cannot be empty' });
      if (trimmed.length > NAME_MAX) return res.status(400).json({ error: `name must be ${NAME_MAX} characters or fewer` });
      blueprint.name = trimmed;
    }
    if (description !== undefined) {
      blueprint.description = String(description).trim().slice(0, DESC_MAX);
    }
    blueprint.updatedAt = new Date().toISOString();
    try {
      await writeBlob(STORE_KEY, store);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
    return res.status(200).json({ blueprint });
  }

  if (req.method === 'DELETE') {
    const id = String((req.query && req.query.id) || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    const store = await readStore();
    const before = store.blueprints.length;
    // Copy semantics: deleting a blueprint never touches jobs made from it.
    store.blueprints = store.blueprints.filter(b => b && b.id !== id);
    if (store.blueprints.length === before) return res.status(404).json({ error: 'blueprint not found' });
    try {
      await writeBlob(STORE_KEY, store);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
