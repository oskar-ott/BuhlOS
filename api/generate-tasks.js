// Rule-based task generation — apply (#224).
//
//   POST /api/generate-tasks  { id, mode? }   mode: 'fill-empty' (default) | 'merge'
//
// Reads the job + the task-rules set, runs the shared engine (api/_lib/task-rules.js)
// to fill matching areas, writes jobs.json, and records a canonical audit entry
// (job.tasks_generated) so it surfaces in the job + cross-job activity feeds.
//
// Permissions: admin or LH on the job (canManageJob), same as the builder save.
// Archived jobs are frozen (409); archived areas/groups are skipped by the engine.
// The save is the SAME shape the builder PUT produces, so the generated structure
// passes the same downstream validation.
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { generateTasksForJob } = require('./_lib/task-rules');
const { append: appendAuditLog } = require('./_lib/audit-log');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { id, mode } = req.body || {};
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });
  if (!canManageJob(me, id)) return res.status(403).json({ error: 'forbidden' });
  const genMode = mode === 'merge' ? 'merge' : 'fill-empty';

  const jobsData = await readBlob('jobs.json', { jobs: [] });
  const jobs = jobsData.jobs || [];
  const job = jobs.find((j) => j && j.id === id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status === 'archived') {
    return res.status(409).json({ error: 'archived jobs cannot be edited' });
  }

  const rulesData = await readBlob('task-rules.json', { rules: [] });
  const rules = Array.isArray(rulesData.rules) ? rulesData.rules : [];

  const { areaGroups, summary } = generateTasksForJob(job, rules, {
    mode: genMode,
    newId: () => nanoid('rt_'),
  });

  const changed = summary.areasFilled > 0;
  if (changed) {
    job.areaGroups = areaGroups;
    job.updatedAt = new Date().toISOString();
    await writeBlob('jobs.json', jobsData);

    const parts = [];
    if (summary.roughInAdded) parts.push(`${summary.roughInAdded} rough-in`);
    if (summary.fitOffAdded) parts.push(`${summary.fitOffAdded} fit-off`);
    appendAuditLog({
      action: 'job.tasks_generated',
      actorId: me.id || '',
      actorName: me.username || '',
      actorRole: me.role || null,
      jobId: id,
      targetType: 'job',
      targetId: id,
      summary: `${me.username || 'someone'} generated tasks on ${job.name || id} — filled ${summary.areasFilled} area${summary.areasFilled === 1 ? '' : 's'}${parts.length ? ` (${parts.join(' + ')})` : ''}`,
      metadata: { mode: genMode, ...summary },
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true, changed, summary });
};
