// Per-job ITP instances — admin attaches a template to a job, scoped to
// "the whole job", a level, an area, or a switchboard. Tradies complete
// the points; admin / builder signs off.
//
// Storage: jobs/<jobId>/itps.json
//   {
//     instances: [{
//       id,
//       templateId,      reference to /api/itp-templates entry
//       templateSnapshot,  { name, points: [...] } — captured at attach
//                          time so editing the global template later
//                          doesn't rewrite history on this job
//       scope: 'job' | 'level' | 'area' | 'switchboard',
//       scopeId?,        levelId / areaId / switchboardId when relevant
//       status: 'pending' | 'in-progress' | 'witnessed' | 'signed-off',
//       results: { [pointId]: { value, note?, photoUrl?, byUserId, byUsername, at } },
//       signedOffBy?,
//       signedOffAt?,
//       archived?,
//       createdAt, createdBy, updatedAt
//     }]
//   }
//
// Routes:
//
//   GET    /api/job-itps?jobId=X
//          Anyone who can see the job.
//
//   POST   /api/job-itps?jobId=X&action=attach
//          body: { templateId, scope, scopeId? }
//          Admin/LH. Snapshots the template at attach-time.
//
//   POST   /api/job-itps?jobId=X&action=record
//          body: { instanceId, pointId, value?, note?, photoUrl? }
//          Anyone with write access to the job (tradies + LH + admin).
//          Sets/updates that point's result; auto-advances status to
//          'in-progress' on first record, 'witnessed' when all required
//          points are filled.
//
//   POST   /api/job-itps?jobId=X&action=signoff
//          body: { instanceId }
//          Admin/LH only. Flips status to 'signed-off' + stamps
//          signedOffBy / signedOffAt.
//
//   POST   /api/job-itps?jobId=X&action=reopen
//          body: { instanceId }
//          Admin/LH only. Reverses signed-off → witnessed (clears stamps).
//
//   DELETE /api/job-itps?jobId=X&id=Y
//          Admin/LH. Soft-archive (status preserved; archived: true).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite, canManageJob } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { appendAudit } = require('./_lib/job-audit');

const VALID_SCOPE  = new Set(['job', 'level', 'area', 'switchboard']);
const VALID_STATUS = new Set(['pending', 'in-progress', 'witnessed', 'signed-off']);

function _str(v, max = 80) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

async function readInstances(jobId) {
  const d = await readBlob(`jobs/${jobId}/itps.json`, { instances: [] });
  return Array.isArray(d && d.instances) ? d.instances : [];
}
async function writeInstances(jobId, instances) {
  await writeBlob(`jobs/${jobId}/itps.json`, { instances });
}

function autoAdvanceStatus(inst) {
  // pending → in-progress on first record
  // in-progress → witnessed when every required point has a result
  if (inst.status === 'pending') {
    if (Object.keys(inst.results || {}).length > 0) {
      inst.status = 'in-progress';
    }
  }
  if (inst.status === 'in-progress') {
    const requiredPoints = (inst.templateSnapshot && inst.templateSnapshot.points || [])
      .filter(p => p.required !== false && !p.archived);
    const allDone = requiredPoints.length > 0 && requiredPoints.every(p =>
      inst.results && inst.results[p.id] && inst.results[p.id].at);
    if (allDone) inst.status = 'witnessed';
  }
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  // Job exists + readable?
  const jobs = await readBlob('jobs.json', { jobs: [] });
  const job = (jobs.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const canSee = me.role === 'admin'
              || (me.assignedJobIds || []).includes(jobId)
              || (me.role === 'client' && job.clientUserId === me.id);
  if (!canSee) return res.status(403).json({ error: 'forbidden' });

  if (req.method === 'GET') {
    const instances = await readInstances(jobId);
    return res.status(200).json({ jobId, instances });
  }

  if (req.method === 'POST') {
    const action = (req.query && req.query.action) || '';

    // ── record — anyone with canWrite (tradies + LH + admin) ──────────
    if (action === 'record') {
      if (!canWrite(me, jobId)) return res.status(403).json({ error: 'forbidden' });
      const { instanceId, pointId, value, note, photoUrl } = req.body || {};
      if (!instanceId || !pointId) return res.status(400).json({ error: 'instanceId + pointId required' });
      const instances = await readInstances(jobId);
      const inst = instances.find(x => x.id === instanceId);
      if (!inst) return res.status(404).json({ error: 'instance not found' });
      if (inst.archived) return res.status(400).json({ error: 'instance archived' });
      if (inst.status === 'signed-off') return res.status(400).json({ error: 'signed-off — reopen to edit' });
      const point = (inst.templateSnapshot && inst.templateSnapshot.points || []).find(p => p.id === pointId);
      if (!point) return res.status(404).json({ error: 'point not found on template' });
      inst.results = inst.results || {};
      inst.results[pointId] = {
        value: value !== undefined ? value : null,
        note: _str(note, 500),
        photoUrl: _str(photoUrl, 400),
        byUserId: me.id,
        byUsername: me.username,
        at: new Date().toISOString(),
      };
      autoAdvanceStatus(inst);
      inst.updatedAt = new Date().toISOString();
      await writeInstances(jobId, instances);
      return res.status(200).json({ instance: inst });
    }

    // ── attach — admin/LH ──────────────────────────────────────────────
    if (action === 'attach') {
      if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'forbidden' });
      const { templateId, scope, scopeId } = req.body || {};
      if (!templateId) return res.status(400).json({ error: 'templateId required' });
      if (!VALID_SCOPE.has(scope)) return res.status(400).json({ error: 'scope must be job|level|area|switchboard' });
      // Look up template (snapshot the points so future template edits
      // don't rewrite history on this job).
      const tplBlob = await readBlob('itp-templates.json', { templates: [] });
      const tpl = (tplBlob.templates || []).find(t => t.id === templateId);
      if (!tpl) return res.status(404).json({ error: 'template not found' });
      const now = new Date().toISOString();
      const inst = {
        id: nanoid('itp_'),
        templateId,
        templateSnapshot: {
          name: tpl.name,
          category: tpl.category,
          points: (tpl.points || []).filter(p => !p.archived).map(p => ({ ...p })),
        },
        scope,
        scopeId: _str(scopeId, 40),
        status: 'pending',
        results: {},
        createdAt: now,
        createdBy: me.username,
        updatedAt: now,
      };
      const instances = await readInstances(jobId);
      instances.push(inst);
      await writeInstances(jobId, instances);
      appendAudit(jobId, {
        byUserId: me.id, byUsername: me.username, kind: 'itp-attach',
        summary: `Attached ITP "${tpl.name}" to ${scope}${scopeId ? ' ' + scopeId : ''}`,
      }).catch(() => {});
      return res.status(201).json({ instance: inst });
    }

    // ── signoff / reopen — admin/LH ────────────────────────────────────
    if (action === 'signoff' || action === 'reopen') {
      if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'forbidden' });
      const { instanceId } = req.body || {};
      if (!instanceId) return res.status(400).json({ error: 'instanceId required' });
      const instances = await readInstances(jobId);
      const inst = instances.find(x => x.id === instanceId);
      if (!inst) return res.status(404).json({ error: 'instance not found' });
      if (action === 'signoff') {
        if (inst.status !== 'witnessed') {
          return res.status(400).json({ error: 'cannot sign off — status must be witnessed' });
        }
        inst.status = 'signed-off';
        inst.signedOffBy = me.username;
        inst.signedOffAt = new Date().toISOString();
      } else {
        if (inst.status !== 'signed-off') {
          return res.status(400).json({ error: 'cannot reopen — not signed off' });
        }
        inst.status = 'witnessed';
        delete inst.signedOffBy;
        delete inst.signedOffAt;
      }
      inst.updatedAt = new Date().toISOString();
      await writeInstances(jobId, instances);
      appendAudit(jobId, {
        byUserId: me.id, byUsername: me.username,
        kind: action === 'signoff' ? 'itp-signoff' : 'itp-reopen',
        summary: `${action === 'signoff' ? 'Signed off' : 'Reopened'} ITP "${inst.templateSnapshot && inst.templateSnapshot.name || instanceId}"`,
      }).catch(() => {});
      return res.status(200).json({ instance: inst });
    }

    return res.status(400).json({ error: 'unknown action' });
  }

  if (req.method === 'DELETE') {
    if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'forbidden' });
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const instances = await readInstances(jobId);
    const inst = instances.find(x => x.id === id);
    if (!inst) return res.status(404).json({ error: 'instance not found' });
    inst.archived = true;
    inst.archivedAt = new Date().toISOString();
    inst.archivedBy = me.username;
    inst.updatedAt = inst.archivedAt;
    await writeInstances(jobId, instances);
    appendAudit(jobId, {
      byUserId: me.id, byUsername: me.username, kind: 'itp-archive',
      summary: `Archived ITP "${inst.templateSnapshot && inst.templateSnapshot.name || id}"`,
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
