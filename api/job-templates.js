// Per-job task templates (rigidity audit R6).
//
// Today every new job either starts blank or copy-from-another-job. There's
// no reusable "Apartments rough-in v3" template that admin can apply to a
// subset of areas. This endpoint adds a *job-scoped* template library:
// admin saves the current rough-in or fit-off list as a named template,
// then applies it to chosen areas later. Templates live on the job — they
// don't pollute the global namespace, so jobs can diverge freely.
//
// Storage: jobs/<jobId>/templates.json
//   {
//     templates: [{
//       id, name, stage: 'roughIn' | 'fitOff',
//       tasks: [{ id, name }],
//       createdAt, createdBy
//     }]
//   }
//
// Routes:
//
//   GET /api/job-templates?jobId=<id>
//        List templates for the job. Admin / LH.
//
//   POST /api/job-templates?jobId=<id>
//        body: { name, stage, tasks: [{name}] }
//        Create a new template. Validates stage + tasks.
//
//   POST /api/job-templates?jobId=<id>&action=save-current
//        body: { name, stage }
//        Capture the job's current rough-in or fit-off list as a template.
//        Convenience over POST with explicit tasks.
//
//   POST /api/job-templates?jobId=<id>&action=apply
//        body: { templateId, areaIds?, replace?: false }
//        Apply the template either as the job's default list (no areaIds)
//        or per-area as overrides. `replace: true` overwrites; else merges
//        by-name (existing same-named tasks preserved by id).
//
//   PATCH /api/job-templates?jobId=<id>&id=<templateId>
//        body: { name?, tasks? }
//        Rename / edit. Admin / LH.
//
//   DELETE /api/job-templates?jobId=<id>&id=<templateId>
//
// Permissions: admin or LH on the job (canManageJob).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');
const { nanoid, validateTasks } = require('./_lib/validation');
const { appendAudit } = require('./_lib/job-audit');

const VALID_STAGE = new Set(['roughIn', 'fitOff']);

async function readTemplates(jobId) {
  const data = await readBlob(`jobs/${jobId}/templates.json`, { templates: [] });
  return Array.isArray(data && data.templates) ? data.templates : [];
}
async function writeTemplates(jobId, templates) {
  await writeBlob(`jobs/${jobId}/templates.json`, { templates });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'forbidden' });

  // ── GET — list templates ─────────────────────────────────────────────
  if (req.method === 'GET') {
    const templates = await readTemplates(jobId);
    return res.status(200).json({ jobId, count: templates.length, templates });
  }

  // ── POST — create / save-current / apply ─────────────────────────────
  if (req.method === 'POST') {
    const action = (req.query && req.query.action) || '';
    const templates = await readTemplates(jobId);

    if (action === 'save-current') {
      const { name, stage } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
      if (!VALID_STAGE.has(stage))       return res.status(400).json({ error: 'stage must be roughIn or fitOff' });

      const jobsData = await readBlob('jobs.json', { jobs: [] });
      const job = (jobsData.jobs || []).find(j => j.id === jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      const source = stage === 'roughIn' ? (job.roughInTasks || []) : (job.fitOffTasks || []);
      const tpl = {
        id: nanoid('tpl_'),
        name: String(name).trim().slice(0, 80),
        stage,
        tasks: source.map(t => ({ id: nanoid('tt_'), name: t.name })),
        createdAt: new Date().toISOString(),
        createdBy: me.username,
      };
      templates.push(tpl);
      await writeTemplates(jobId, templates);
      appendAudit(jobId, { byUserId: me.id, byUsername: me.username, kind: 'template-create',
        summary: `Saved current ${stage} list as template "${tpl.name}" (${tpl.tasks.length} task${tpl.tasks.length === 1 ? '' : 's'})` })
        .catch(() => {});
      return res.status(201).json({ template: tpl });
    }

    if (action === 'apply') {
      const { templateId, areaIds, replace } = req.body || {};
      if (!templateId) return res.status(400).json({ error: 'templateId required' });
      const tpl = templates.find(t => t.id === templateId);
      if (!tpl) return res.status(404).json({ error: 'template not found' });

      const jobsData = await readBlob('jobs.json', { jobs: [] });
      const job = (jobsData.jobs || []).find(j => j.id === jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });

      const stageKey = tpl.stage === 'roughIn' ? 'roughInTasks' : 'fitOffTasks';
      // Build the new tasks array, preserving existing task ids by name so
      // any recorded progress stays attached. Same merge rule the editor
      // already uses for rename-safety.
      const mergeWithExistingIds = (existingArr, tplTasks) => {
        const byName = {};
        for (const t of (existingArr || [])) byName[t.name] = t;
        return tplTasks.map(t => ({
          id: (byName[t.name] && byName[t.name].id) ? byName[t.name].id : nanoid('rt_'),
          name: t.name,
        }));
      };

      if (Array.isArray(areaIds) && areaIds.length) {
        // Per-area apply. Sets each area's override list to the template's
        // tasks. `replace: false` (default) preserves ids by name; replace
        // true overwrites the slot entirely (fresh ids).
        const targetSet = new Set(areaIds);
        let touched = 0;
        for (const g of (job.areaGroups || [])) {
          for (const a of (g.areas || [])) {
            if (!targetSet.has(a.id)) continue;
            const existing = a[stageKey] || [];
            a[stageKey] = replace
              ? tpl.tasks.map(t => ({ id: nanoid('rt_'), name: t.name }))
              : mergeWithExistingIds(existing, tpl.tasks);
            touched++;
          }
        }
        await writeBlob('jobs.json', jobsData);
        appendAudit(jobId, { byUserId: me.id, byUsername: me.username, kind: 'template-apply-areas',
          summary: `Applied template "${tpl.name}" to ${touched} area${touched === 1 ? '' : 's'} (${tpl.stage})` })
          .catch(() => {});
        return res.status(200).json({ ok: true, appliedTo: touched, scope: 'areas' });
      }

      // Default: apply as the job-level default list.
      const existing = job[stageKey] || [];
      job[stageKey] = replace
        ? tpl.tasks.map(t => ({ id: nanoid('rt_'), name: t.name }))
        : mergeWithExistingIds(existing, tpl.tasks);
      await writeBlob('jobs.json', jobsData);
      appendAudit(jobId, { byUserId: me.id, byUsername: me.username, kind: 'template-apply-job',
        summary: `Applied template "${tpl.name}" to job default ${tpl.stage} list (${tpl.tasks.length} task${tpl.tasks.length === 1 ? '' : 's'})` })
        .catch(() => {});
      return res.status(200).json({ ok: true, scope: 'job', stage: tpl.stage, taskCount: tpl.tasks.length });
    }

    // Default POST — explicit create.
    const { name, stage, tasks } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    if (!VALID_STAGE.has(stage))       return res.status(400).json({ error: 'stage must be roughIn or fitOff' });
    const v = validateTasks(tasks || [], 'tt');
    if (!v.ok) return res.status(400).json({ error: v.error });
    const tpl = {
      id: nanoid('tpl_'),
      name: String(name).trim().slice(0, 80),
      stage,
      tasks: v.tasks.map(t => ({ id: t.id, name: t.name })),
      createdAt: new Date().toISOString(),
      createdBy: me.username,
    };
    templates.push(tpl);
    await writeTemplates(jobId, templates);
    appendAudit(jobId, { byUserId: me.id, byUsername: me.username, kind: 'template-create',
      summary: `Created template "${tpl.name}" (${tpl.tasks.length} task${tpl.tasks.length === 1 ? '' : 's'})` })
      .catch(() => {});
    return res.status(201).json({ template: tpl });
  }

  // ── PATCH — rename / edit ─────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const templates = await readTemplates(jobId);
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const { name, tasks } = req.body || {};
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'name cannot be empty' });
      tpl.name = trimmed.slice(0, 80);
    }
    if (tasks !== undefined) {
      const v = validateTasks(tasks, 'tt');
      if (!v.ok) return res.status(400).json({ error: v.error });
      tpl.tasks = v.tasks.map(t => ({ id: t.id, name: t.name }));
    }
    await writeTemplates(jobId, templates);
    return res.status(200).json({ template: tpl });
  }

  // ── DELETE ────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const templates = await readTemplates(jobId);
    const idx = templates.findIndex(t => t.id === id);
    if (idx < 0) return res.status(404).json({ error: 'template not found' });
    const removed = templates[idx];
    templates.splice(idx, 1);
    await writeTemplates(jobId, templates);
    appendAudit(jobId, { byUserId: me.id, byUsername: me.username, kind: 'template-delete',
      summary: `Deleted template "${removed.name}"` }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
