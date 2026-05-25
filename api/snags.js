// Snags / defects domain endpoint — Phase D.5.
//
//   GET  /api/snags?jobId=<id>                     → list snags for a job
//   POST /api/snags?jobId=<id>                     → create one snag
//   POST /api/snags?jobId=<id>&action=transition   → move a snag to a new status
//
// D.5 ships the first complete snag operational loop: worker reports
// a snag from Phil → admin sees it in the new admin queue → admin
// transitions/verifies/closes → worker sees status. Audit-log entries
// record the lifecycle on every write.
//
// Storage — new V2 namespace to avoid colliding with the LEGACY
// snags[] array that lives under the same data.json (and is read by
// api/snag-quick-raise.js, api/snags-all.js, api/snags-mine.js,
// api/snags-export.js, etc. — all of which D.5 leaves untouched):
//
//   jobs/<jobId>/data.json
//     { dwellings, snags: [...legacy], snagsV2: [SnagItem, ...], evidence, notes }
//
// Append + full-doc rewrite (same pattern as api/evidence.js + the
// legacy snag endpoints). Full-doc-write risk is bounded: small
// per-job snag counts in Phase D.5, ~50ms race window, Postgres split
// in Phase F+.
//
// Permissions:
//   - unauthenticated   → 401 JSON
//   - client role       → 403 JSON
//   - tradie GET        → snags on assigned jobs only (job-level gate)
//   - LH GET            → snags on assigned jobs only
//   - admin GET         → all jobs
//   - tradie/LH POST    → assigned jobs only (canWrite gate)
//   - admin POST        → any job
//   - transition POST   → role-based per canRoleTransition (see below)
//
// State machine + role rules — kept in sync with
// src/domains/snags/service.ts:
//
//   null         → open          (create — any writer)
//   open         → in_progress   (any writer; "claim it")
//   in_progress  → resolved      (admin OR creator OR assignee)
//   in_progress  → open          (admin OR creator OR assignee — drop claim)
//   resolved     → in_progress   (admin OR creator OR assignee — re-open)
//   resolved     → open          (admin OR creator OR assignee)
//   resolved     → verified      (admin only)
//   verified     → closed        (admin only)
//   verified     → resolved      (admin only — un-verify mistake)
//   closed       → verified      (admin only — re-open)
//   open         → rejected      (admin only — reason required)
//   in_progress  → rejected      (admin only — reason required)
//   resolved     → rejected      (admin only — reason required)
//   rejected     → open          (admin only — re-open rejected snag)
//
// Audit — dual-write per Phase D5 precedent:
//   1. Legacy api/_lib/job-audit.js per-job log (kept for the admin
//      audit tab's legacy reader path).
//   2. New api/_lib/audit-log.js monthly cross-surface journal
//      (snag.created + snag.transitioned verbs).
// Both calls are best-effort — wrapped in `.catch(() => {})` so a log
// failure on either path never blocks the snag write.

const { readBlob, readBlobFresh, writeBlob, setNoCache } = require('./_lib/blob');
const {
  requireAuth,
  canWrite,
  isAdminRole,
  isFieldRole,
  isLeadingHandRole,
} = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { appendAudit: appendLegacyAudit } = require('./_lib/job-audit');
const { append: appendAuditLog } = require('./_lib/audit-log');

const VALID_STATUSES = new Set([
  'open',
  'in_progress',
  'resolved',
  'verified',
  'closed',
  'rejected',
]);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_STAGES = new Set(['roughIn', 'fitOff']);

// Role tiers delegate to api/_lib/auth.js (PR #23 normalisation pass) so
// boss/owner/manager/office/pm/estimator pass the admin gate and
// labourer/electrician + lowercase LH variants pass the field gate.
// LH is a separate tier in auth.js; for snag transitions we treat
// LH the same as the field tier (claim/drop, mark resolved as
// creator/assignee) so the legacy `leadingHand` behaviour is preserved.

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 1000;
const REJECTION_REASON_MAX = 500;
const EVIDENCE_LINK_MAX = 10;

function dataKey(jobId) {
  return `jobs/${jobId}/data.json`;
}

function emptyData() {
  return { dwellings: {}, snags: [], snagsV2: [], evidence: [], notes: [] };
}

function findArea(job, areaId) {
  for (const g of (job && job.areaGroups) || []) {
    for (const a of (g && g.areas) || []) {
      if (a && a.id === areaId) return { area: a, group: g };
    }
  }
  return { area: null, group: null };
}

function effectiveTasks(job, area, stage) {
  // Mirror api/_lib/job-tasks.js logic without importing it — keeps
  // task-id validation in this endpoint independent of the legacy
  // helper's evolving API. Area-level override wins; otherwise fall
  // back to the job's template.
  const stageKey = stage === 'roughIn' ? 'roughInTasks' : 'fitOffTasks';
  if (area && Array.isArray(area[stageKey]) && area[stageKey].length) {
    return area[stageKey];
  }
  if (job && Array.isArray(job[stageKey]) && job[stageKey].length) {
    return job[stageKey];
  }
  return [];
}

function isAdmin(role) {
  return isAdminRole(role);
}
function isField(role) {
  return isFieldRole(role) || isLeadingHandRole(role);
}

const ALLOWED_TRANSITIONS = new Set([
  // create
  'null→open',
  // happy path
  'open→in_progress',
  'in_progress→resolved',
  'resolved→verified',
  'verified→closed',
  // recovery
  'in_progress→open',
  'resolved→in_progress',
  'resolved→open',
  'verified→resolved',
  'closed→verified',
  // reject branch
  'open→rejected',
  'in_progress→rejected',
  'resolved→rejected',
  'rejected→open',
]);

function canTransition(from, to) {
  const key = `${from == null ? 'null' : from}→${to}`;
  return ALLOWED_TRANSITIONS.has(key);
}

/**
 * Role-based transition gate — must AND with canTransition().
 *   - admin can do anything the machine allows.
 *   - field user can claim/drop open, and the creator/assignee can
 *     mark resolved + re-open resolved.
 *   - verify, close, reject (in either direction) are admin-only.
 */
function canRoleTransition(from, to, user, snag) {
  if (isAdmin(user.role)) return true;
  if (!isField(user.role)) return false;

  if (from === 'open' && to === 'in_progress') return true;
  if (from === 'in_progress' && to === 'open') return true;

  const isCreator = !!snag.createdById && snag.createdById === user.id;
  const isAssignee = !!snag.assignedToId && snag.assignedToId === user.id;
  if ((isCreator || isAssignee) && from === 'in_progress' && to === 'resolved') {
    return true;
  }
  if (
    (isCreator || isAssignee) &&
    from === 'resolved' &&
    (to === 'in_progress' || to === 'open')
  ) {
    return true;
  }
  return false;
}

function validateCreateBody(body, job) {
  const errors = [];
  // Early-exit shape must match the happy path: { errors, ... } so the
  // caller's `v.errors && v.errors.length` guard works. Returning a bare
  // array here used to crash on the next-line title.slice() call (500).
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['body must be an object'] };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) errors.push('title is required');
  if (title.length > TITLE_MAX) errors.push(`title must be ${TITLE_MAX} characters or fewer`);

  const description = typeof body.description === 'string' ? body.description : '';
  if (description.length > DESCRIPTION_MAX) {
    errors.push(`description must be ${DESCRIPTION_MAX} characters or fewer`);
  }

  const priority = body.priority == null ? 'normal' : String(body.priority);
  if (!VALID_PRIORITIES.has(priority)) {
    errors.push('priority must be low, normal, high or urgent');
  }

  const stage = body.stage == null ? null : String(body.stage);
  if (stage && !VALID_STAGES.has(stage)) {
    errors.push('stage must be roughIn or fitOff');
  }
  if (body.taskId && !stage) {
    errors.push('stage is required when taskId is provided');
  }

  let area = null;
  let group = null;
  if (body.areaId) {
    const found = findArea(job, body.areaId);
    area = found.area;
    group = found.group;
    if (!area) errors.push('areaId not found on job');
  }
  if (body.taskId && stage && area) {
    const tasks = effectiveTasks(job, area, stage);
    if (!tasks.some((t) => t && t.id === body.taskId)) {
      errors.push('taskId not found for stage on this job/area');
    }
  }

  if (body.evidenceIds != null) {
    if (!Array.isArray(body.evidenceIds)) {
      errors.push('evidenceIds must be an array');
    } else if (body.evidenceIds.length > EVIDENCE_LINK_MAX) {
      errors.push(`evidenceIds may not exceed ${EVIDENCE_LINK_MAX} links`);
    }
  }

  return { errors, title, description, priority, stage, area, group };
}

function sourceForUser(user) {
  if (isAdmin(user.role)) return 'admin';
  if (isField(user.role)) return 'phil';
  return 'system';
}

async function loadJobOrFail(res, jobId) {
  const jobsBlob = await readBlob('jobs.json', null);
  if (!jobsBlob || typeof jobsBlob !== 'object' || !Array.isArray(jobsBlob.jobs)) {
    res.status(500).json({ error: 'jobs storage unavailable' });
    return null;
  }
  const job = jobsBlob.jobs.find((j) => j && j.id === jobId);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return null;
  }
  return job;
}

async function listSnags(req, res, user, jobId) {
  const data = await readBlob(dataKey(jobId), emptyData());
  const all = Array.isArray(data && data.snagsV2) ? data.snagsV2 : [];

  // Every field user on the assigned job sees every snag — same
  // visibility model as the admin queue, minus mutation buttons.
  // Doc-wise this matches the field reality: a worker walking onto
  // a site needs to see every outstanding issue, not just the ones
  // they raised.
  //
  // Sort newest-first by createdAt so the most recent activity is at
  // the top. The admin queue re-sorts client-side by status/priority.
  const sorted = all.slice().sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  );
  return res.status(200).json({ snags: sorted });
}

async function createSnag(req, res, user, jobId) {
  const job = await loadJobOrFail(res, jobId);
  if (!job) return;

  const v = validateCreateBody(req.body || {}, job);
  if (v.errors && v.errors.length) {
    return res.status(400).json({ error: v.errors[0], errors: v.errors });
  }

  const body = req.body || {};
  const nowIso = new Date().toISOString();

  // Validate evidenceIds resolve to real evidence rows on this job.
  // Done after the structural checks so we don't pay the data.json
  // re-read cost when the body is obviously bad.
  const dataKeyStr = dataKey(jobId);
  const data = await readBlob(dataKeyStr, emptyData());
  const evidenceArr = Array.isArray(data && data.evidence) ? data.evidence : [];
  const evidenceIds = Array.isArray(body.evidenceIds)
    ? Array.from(new Set(body.evidenceIds.map((id) => String(id))))
    : [];
  for (const id of evidenceIds) {
    if (!evidenceArr.some((ev) => ev && ev.id === id)) {
      return res.status(400).json({ error: `evidenceId not found on this job: ${id}` });
    }
  }

  // Resolve denormalised area/task names so the admin queue doesn't
  // need to walk areaGroups on every render.
  let areaName = null;
  let taskName = null;
  if (v.area) {
    areaName = v.area.name || null;
    if (body.taskId && v.stage) {
      const tasks = effectiveTasks(job, v.area, v.stage);
      const t = tasks.find((x) => x && x.id === body.taskId);
      taskName = t ? t.name || null : null;
    }
  }

  const item = {
    id: nanoid('sn_'),
    jobId,
    title: v.title,
    description: v.description ? v.description : null,
    summary: null,
    stage: v.stage || null,
    areaId: body.areaId || null,
    areaName,
    taskId: body.taskId || null,
    taskName,
    evidenceIds,
    status: 'open',
    priority: v.priority,
    source: sourceForUser(user),
    createdById: user.id,
    createdByName: user.name || user.username || 'Unknown',
    createdByRole: user.role || null,
    assignedToId: body.assignedToId ? String(body.assignedToId) : null,
    assignedToName: null,
    acknowledgedAt: null,
    acknowledgedById: null,
    acknowledgedByName: null,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    verifiedAt: null,
    verifiedById: null,
    verifiedByName: null,
    closedAt: null,
    closedById: null,
    closedByName: null,
    rejectedAt: null,
    rejectedById: null,
    rejectedByName: null,
    rejectionReason: null,
    auditLogIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Write the audit row first so we can stamp the snag with its id
  // before persisting. If the audit write fails, the snag write still
  // proceeds (auditLogIds just stays empty).
  const auditEntry = await appendAuditLog({
    action: 'snag.created',
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'snag',
    targetId: item.id,
    summary: `snag created — "${item.title.slice(0, 80)}"`,
    metadata: {
      priority: item.priority,
      status: item.status,
      areaId: item.areaId,
      stage: item.stage,
      taskId: item.taskId,
      evidenceIds: item.evidenceIds,
    },
  }).catch(() => null);
  if (auditEntry && auditEntry.id) item.auditLogIds.push(auditEntry.id);

  if (!Array.isArray(data.snagsV2)) data.snagsV2 = [];
  data.snagsV2.push(item);

  try {
    await writeBlob(dataKeyStr, data);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  appendLegacyAudit(jobId, {
    byUserId: user.id,
    byUsername: user.username || user.name || '',
    kind: 'snag_v2_created',
    summary: `snag created — "${item.title.slice(0, 80)}"`,
    after: {
      snagId: item.id,
      priority: item.priority,
      areaId: item.areaId,
      stage: item.stage,
      taskId: item.taskId,
    },
  }).catch(() => {});

  return res.status(201).json({ snagItem: item });
}

function applyTransition(snag, nextStatus, user, reason) {
  const nowIso = new Date().toISOString();
  const next = { ...snag, status: nextStatus, updatedAt: nowIso };
  const actorName = user.name || user.username || 'Unknown';
  switch (nextStatus) {
    case 'open':
      // Re-opens don't clear historical stamps — the audit trail is
      // append-only. New status flip is captured in the audit row.
      break;
    case 'in_progress':
      if (!next.acknowledgedAt) {
        next.acknowledgedAt = nowIso;
        next.acknowledgedById = user.id;
        next.acknowledgedByName = actorName;
      }
      next.assignedToId = next.assignedToId || user.id;
      next.assignedToName = next.assignedToName || actorName;
      break;
    case 'resolved':
      next.resolvedAt = nowIso;
      next.resolvedById = user.id;
      next.resolvedByName = actorName;
      break;
    case 'verified':
      next.verifiedAt = nowIso;
      next.verifiedById = user.id;
      next.verifiedByName = actorName;
      break;
    case 'closed':
      next.closedAt = nowIso;
      next.closedById = user.id;
      next.closedByName = actorName;
      break;
    case 'rejected':
      next.rejectedAt = nowIso;
      next.rejectedById = user.id;
      next.rejectedByName = actorName;
      next.rejectionReason = reason || next.rejectionReason || '';
      break;
    default:
      break;
  }
  return next;
}

async function transitionSnag(req, res, user, jobId) {
  if (!canWrite(user, jobId)) {
    return res.status(403).json({ error: 'no write access to job' });
  }
  const body = req.body || {};
  const snagId = body.snagId ? String(body.snagId) : '';
  const nextStatus = body.nextStatus ? String(body.nextStatus) : '';
  const reasonRaw = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!snagId) return res.status(400).json({ error: 'snagId required' });
  if (!nextStatus || !VALID_STATUSES.has(nextStatus)) {
    return res.status(400).json({ error: 'nextStatus must be a valid snag status' });
  }
  if (nextStatus === 'rejected' && !reasonRaw) {
    return res.status(400).json({ error: 'reason required when nextStatus=rejected' });
  }
  if (reasonRaw.length > REJECTION_REASON_MAX) {
    return res
      .status(400)
      .json({ error: `reason must be ${REJECTION_REASON_MAX} characters or fewer` });
  }

  const dataKeyStr = dataKey(jobId);
  // Vercel Blob: writes are durable on return but the read path can
  // briefly serve a pre-write snapshot from its storage layer (separate
  // from the 5s in-memory cache that readBlobFresh already bypasses).
  // Back-to-back transitions on the same snag can therefore see the
  // stale status on read #2, which makes canTransition reject what
  // would otherwise be a valid step (`open → resolved` instead of
  // `in_progress → resolved`).
  //
  // Strategy: read fresh once, and if canTransition rejects, wait
  // briefly and re-read. Real conflicts (another admin actually moved
  // the snag to a different status) still surface as 409 after the
  // retry — the retry only papers over the stale-read window.
  let data = await readBlobFresh(dataKeyStr, emptyData());
  let arr = Array.isArray(data.snagsV2) ? data.snagsV2 : [];
  let idx = arr.findIndex((s) => s && s.id === snagId);
  if (idx === -1) return res.status(404).json({ error: 'snag not found on job' });
  let current = arr[idx];

  if (!canTransition(current.status, nextStatus)) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    data = await readBlobFresh(dataKeyStr, emptyData());
    arr = Array.isArray(data.snagsV2) ? data.snagsV2 : [];
    idx = arr.findIndex((s) => s && s.id === snagId);
    if (idx === -1) return res.status(404).json({ error: 'snag not found on job' });
    current = arr[idx];
  }

  if (!canTransition(current.status, nextStatus)) {
    // 409 Conflict — the snag's current state genuinely doesn't allow
    // this transition (state-machine violation), distinct from a 400
    // request-validation error. Client maps 409 to the friendly "may
    // have changed" message and lets real 400s surface their message.
    return res
      .status(409)
      .json({ error: `invalid transition: ${current.status} → ${nextStatus}` });
  }
  if (!canRoleTransition(current.status, nextStatus, user, current)) {
    return res.status(403).json({ error: 'not allowed to perform this transition' });
  }

  const next = applyTransition(current, nextStatus, user, reasonRaw);

  const summary = reasonRaw
    ? `snag ${current.status} → ${nextStatus} — "${reasonRaw.slice(0, 80)}"`
    : `snag ${current.status} → ${nextStatus}`;
  const auditEntry = await appendAuditLog({
    action: 'snag.transitioned',
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'snag',
    targetId: next.id,
    summary,
    metadata: {
      from: current.status,
      to: nextStatus,
      priority: next.priority,
      ...(reasonRaw ? { reason: reasonRaw } : {}),
    },
  }).catch(() => null);
  if (auditEntry && auditEntry.id) {
    next.auditLogIds = [...(current.auditLogIds || []), auditEntry.id];
  }

  arr[idx] = next;
  data.snagsV2 = arr;
  try {
    await writeBlob(dataKeyStr, data);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  appendLegacyAudit(jobId, {
    byUserId: user.id,
    byUsername: user.username || user.name || '',
    kind: `snag_v2_${nextStatus}`,
    summary,
    before: { status: current.status },
    after: { status: next.status, rejectionReason: next.rejectionReason },
  }).catch(() => {});

  return res.status(200).json({ snagItem: next });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;
  if (user.role === 'client') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const action = (req.query && req.query.action) || '';

  if (req.method === 'GET') {
    try {
      return await listSnags(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'list failed' });
    }
  }

  if (req.method === 'POST' && action === 'transition') {
    try {
      return await transitionSnag(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'transition failed' });
    }
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) {
      return res.status(403).json({ error: 'no write access to job' });
    }
    try {
      return await createSnag(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'create failed' });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};
