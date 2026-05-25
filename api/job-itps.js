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
//          body: { instanceId, overrideJustification? }
//          Admin only. Flips status to 'signed-off' + stamps
//          signedOffBy / signedOffAt. Enforces the independence rule:
//          if the signing user recorded more than
//          SIGNOFF_INDEPENDENCE_THRESHOLD of the points (default 0.5),
//          overrideJustification must be a non-empty string up to
//          REJECTION_JUSTIFICATION_MAX (500) chars — otherwise the
//          server returns 409 with a friendly message the client
//          drawer surfaces in the override-justification textarea.
//
//   POST   /api/job-itps?jobId=X&action=reopen
//          body: { instanceId }
//          Admin only. Reverses signed-off → witnessed (clears stamps).
//
//   DELETE /api/job-itps?jobId=X&id=Y
//          Admin/LH. Soft-archive (status preserved; archived: true).
//
// E1a wires V2 monthly audit-log writes alongside the legacy structural
// log so the new admin queue's drawer History panel sees the entries.
// Same dual-write pattern as api/snags.js + api/evidence.js — both
// audit paths are best-effort .catch(() => {}) so a log failure on
// either path never blocks the ITP write.
//
// E1a also picks up the PR #26 stale-read fix: record / signoff /
// reopen / archive paths use readBlobFresh + a single 750ms retry
// when the state-machine guard rejects on the first read, so two
// admins on different Vercel warm instances don't see false 409s
// from Blob propagation lag.

const { readBlob, readBlobFresh, writeBlob, setNoCache } = require('./_lib/blob');
const {
  requireAuth,
  canWrite,
  canManageJob,
  isAdminRole,
} = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { appendAudit } = require('./_lib/job-audit');
const { append: appendAuditLog } = require('./_lib/audit-log');

const VALID_SCOPE  = new Set(['job', 'level', 'area', 'switchboard']);
const VALID_STATUS = new Set(['pending', 'in-progress', 'witnessed', 'signed-off']);

// Independence rule for sign-off — see src/domains/itp/schema.ts.
// The signing user must not have recorded MORE than half the points
// without supplying an override justification. 0.5 = "majority";
// kept in sync with ITP_SIGNOFF_INDEPENDENCE_THRESHOLD on the TS side.
const SIGNOFF_INDEPENDENCE_THRESHOLD = 0.5;

// Mirror the cap on snag rejection reasons (PR #26). Bounds the
// audit-log metadata size and the admin textarea sizing.
const REJECTION_JUSTIFICATION_MAX = 500;

function _str(v, max = 80) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

const KEY = (jobId) => `jobs/${jobId}/itps.json`;

async function readInstances(jobId) {
  const d = await readBlob(KEY(jobId), { instances: [] });
  return Array.isArray(d && d.instances) ? d.instances : [];
}

async function readInstancesFresh(jobId) {
  // Cache-skipping re-read — used after a canTransition guard rejects
  // on the in-cache copy. Cross-instance Blob propagation can lag
  // several seconds after a put; this gives a same-instance writer
  // and a different-instance reader a chance to converge before we
  // surface a 409.
  const d = await readBlobFresh(KEY(jobId), { instances: [] });
  return Array.isArray(d && d.instances) ? d.instances : [];
}

async function writeInstances(jobId, instances) {
  await writeBlob(KEY(jobId), { instances });
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

// Mirror src/domains/itp/service.ts pointsRecordedByUserRatio so the
// server enforcement of the independence rule lines up with the
// client's pre-check. Optional points still count toward the ratio
// because the rule is about "who physically recorded the data", not
// "which points were required".
function pointsRecordedByUserRatio(inst, userId) {
  const points = (inst.templateSnapshot && inst.templateSnapshot.points) || [];
  const results = inst.results || {};
  let total = 0;
  let byUser = 0;
  for (const p of points) {
    if (p && p.archived) continue;
    const r = results[p && p.id];
    if (!r || !r.at) continue;
    total += 1;
    if (r.byUserId === userId) byUser += 1;
  }
  if (total === 0) return 0;
  return byUser / total;
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
  // PR #23 alignment — use the normalised admin gate so boss / owner
  // / pm / estimator / office / manager all reach the job the same way
  // 'admin' does. Was previously a bare `me.role === 'admin'` literal
  // which 403'd those users even though login.html had let them in.
  const canSee = isAdminRole(me.role)
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
      const body = req.body || {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'body must be an object' });
      }
      const { instanceId, pointId, value, note, photoUrl } = body;
      if (!instanceId || !pointId) return res.status(400).json({ error: 'instanceId + pointId required' });

      // PR #26 stale-read pattern — first try the in-cache copy
      // (writeBlob populates it write-through), and if the instance
      // is in a state that would 409 the record, re-read past the
      // cache after a 750ms beat to let cross-instance propagation
      // settle. Same shape as api/snags.js#transitionSnag.
      let instances = await readInstances(jobId);
      let inst = instances.find(x => x.id === instanceId);
      let needsRetry = !inst || inst.archived || inst.status === 'signed-off';
      if (needsRetry) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        instances = await readInstancesFresh(jobId);
        inst = instances.find(x => x.id === instanceId);
      }
      if (!inst) return res.status(404).json({ error: 'instance not found' });
      if (inst.archived) return res.status(409).json({ error: 'instance archived' });
      if (inst.status === 'signed-off') {
        return res.status(409).json({ error: 'signed-off — reopen to edit' });
      }

      const point = (inst.templateSnapshot && inst.templateSnapshot.points || []).find(p => p.id === pointId);
      if (!point) return res.status(404).json({ error: 'point not found on template' });

      const before = inst.status;
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
      try {
        await writeInstances(jobId, instances);
      } catch (e) {
        return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
      }

      // V2 audit — one row per record. metadata.statusAfter lets the
      // history panel render "recorded N (pending → in-progress)" when
      // the record drove an auto-advance without splitting the verb.
      appendAuditLog({
        action: 'itp.point.recorded',
        actorId: me.id,
        actorName: me.name || me.username || 'Unknown',
        actorRole: me.role || null,
        jobId,
        targetType: 'itp_instance',
        targetId: inst.id,
        summary: `recorded "${_str(point.label, 80)}"`,
        metadata: {
          pointId,
          pointLabel: _str(point.label, 200),
          pointType: point.type || null,
          valueProvided: value !== undefined && value !== null && value !== '',
          photoProvided: !!(photoUrl && String(photoUrl).trim()),
          noteProvided: !!(note && String(note).trim()),
          statusBefore: before,
          statusAfter: inst.status,
        },
      }).catch(() => {});

      return res.status(200).json({ instance: inst });
    }

    // ── attach — admin/LH ──────────────────────────────────────────────
    if (action === 'attach') {
      if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'forbidden' });
      const body = req.body || {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'body must be an object' });
      }
      const { templateId, scope, scopeId } = body;
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
      try {
        await writeInstances(jobId, instances);
      } catch (e) {
        return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
      }
      appendAudit(jobId, {
        byUserId: me.id, byUsername: me.username, kind: 'itp-attach',
        summary: `Attached ITP "${tpl.name}" to ${scope}${scopeId ? ' ' + scopeId : ''}`,
      }).catch(() => {});
      // V2 audit — admin's drawer history panel needs this; the legacy
      // log above stays for the existing /admin audit tab reader path.
      appendAuditLog({
        action: 'itp.attached',
        actorId: me.id,
        actorName: me.name || me.username || 'Unknown',
        actorRole: me.role || null,
        jobId,
        targetType: 'itp_instance',
        targetId: inst.id,
        summary: `attached ITP "${_str(tpl.name, 80)}"`,
        metadata: {
          templateId,
          templateName: _str(tpl.name, 200),
          scope,
          scopeId: scopeId ? _str(scopeId, 40) : null,
          pointCount: inst.templateSnapshot.points.length,
        },
      }).catch(() => {});
      return res.status(201).json({ instance: inst });
    }

    // ── signoff / reopen ───────────────────────────────────────────────
    //
    // signoff is admin-only (PR #23 alignment). reopen stays
    // canManageJob (admin + LH on assigned jobs) to mirror the legacy
    // behaviour that lets an LH undo their own admin teammate's
    // mistake without an extra hop. The independence rule applies to
    // signoff only.
    if (action === 'signoff' || action === 'reopen') {
      if (action === 'signoff') {
        if (!isAdminRole(me.role)) {
          return res.status(403).json({ error: 'sign-off is admin-only' });
        }
      } else if (!canManageJob(me, jobId)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const body = req.body || {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'body must be an object' });
      }
      const { instanceId } = body;
      const overrideJustificationRaw = typeof body.overrideJustification === 'string'
        ? body.overrideJustification.trim()
        : '';
      if (!instanceId) return res.status(400).json({ error: 'instanceId required' });
      if (overrideJustificationRaw.length > REJECTION_JUSTIFICATION_MAX) {
        return res.status(400).json({
          error: `overrideJustification must be ${REJECTION_JUSTIFICATION_MAX} characters or fewer`,
        });
      }

      // PR #26 stale-read pattern. First try the in-cache copy; if the
      // status guard would 409 (status mismatch), re-read past the
      // cache after a 750ms beat. Real state-machine conflicts still
      // surface as 409 after the retry.
      let instances = await readInstances(jobId);
      let inst = instances.find(x => x.id === instanceId);
      const requiredStatus = action === 'signoff' ? 'witnessed' : 'signed-off';
      const guardRejects = !inst || inst.status !== requiredStatus;
      if (guardRejects) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        instances = await readInstancesFresh(jobId);
        inst = instances.find(x => x.id === instanceId);
      }
      if (!inst) return res.status(404).json({ error: 'instance not found' });
      if (action === 'signoff') {
        if (inst.status !== 'witnessed') {
          return res.status(409).json({ error: 'cannot sign off — status must be witnessed' });
        }
        // Independence rule. The ratio compares this admin's recorded
        // points against the total recorded. The 0.5 threshold means
        // "strictly more than half" trips the rule — exactly 50% is
        // still ok, matching the documented threshold.
        const ratio = pointsRecordedByUserRatio(inst, me.id);
        if (ratio > SIGNOFF_INDEPENDENCE_THRESHOLD && !overrideJustificationRaw) {
          return res.status(409).json({
            error: 'sign-off requires an override justification — too many points were recorded by the signing user',
            ratio,
          });
        }
        inst.status = 'signed-off';
        inst.signedOffBy = me.username;
        inst.signedOffAt = new Date().toISOString();
      } else {
        if (inst.status !== 'signed-off') {
          return res.status(409).json({ error: 'cannot reopen — not signed off' });
        }
        inst.status = 'witnessed';
        delete inst.signedOffBy;
        delete inst.signedOffAt;
      }
      inst.updatedAt = new Date().toISOString();
      try {
        await writeInstances(jobId, instances);
      } catch (e) {
        return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
      }
      appendAudit(jobId, {
        byUserId: me.id, byUsername: me.username,
        kind: action === 'signoff' ? 'itp-signoff' : 'itp-reopen',
        summary: `${action === 'signoff' ? 'Signed off' : 'Reopened'} ITP "${inst.templateSnapshot && inst.templateSnapshot.name || instanceId}"`,
      }).catch(() => {});
      appendAuditLog({
        action: action === 'signoff' ? 'itp.signed_off' : 'itp.reopened',
        actorId: me.id,
        actorName: me.name || me.username || 'Unknown',
        actorRole: me.role || null,
        jobId,
        targetType: 'itp_instance',
        targetId: inst.id,
        summary: action === 'signoff'
          ? `signed off "${_str(inst.templateSnapshot && inst.templateSnapshot.name, 80)}"`
          : `reopened "${_str(inst.templateSnapshot && inst.templateSnapshot.name, 80)}"`,
        metadata: action === 'signoff'
          ? {
              signedOffByName: me.name || me.username || 'Unknown',
              ...(overrideJustificationRaw
                ? { overrideJustification: overrideJustificationRaw }
                : {}),
            }
          : {
              previousStatus: 'signed-off',
            },
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
    const statusAtArchive = inst.status;
    inst.archived = true;
    inst.archivedAt = new Date().toISOString();
    inst.archivedBy = me.username;
    inst.updatedAt = inst.archivedAt;
    try {
      await writeInstances(jobId, instances);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
    appendAudit(jobId, {
      byUserId: me.id, byUsername: me.username, kind: 'itp-archive',
      summary: `Archived ITP "${inst.templateSnapshot && inst.templateSnapshot.name || id}"`,
    }).catch(() => {});
    appendAuditLog({
      action: 'itp.archived',
      actorId: me.id,
      actorName: me.name || me.username || 'Unknown',
      actorRole: me.role || null,
      jobId,
      targetType: 'itp_instance',
      targetId: inst.id,
      summary: `archived "${_str(inst.templateSnapshot && inst.templateSnapshot.name, 80)}"`,
      metadata: { statusAtArchive },
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
