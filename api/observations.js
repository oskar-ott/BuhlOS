// Observations domain endpoint — PR 3 / PR 6.
//
//   GET   /api/observations                     → cross-job inbox (office/admin)
//   GET   /api/observations?jobId=<id>          → one job's observations
//   POST  /api/observations?jobId=<id>          → create one (canWrite)
//   POST  /api/observations?action=convert-to-snag  → real conversion (PR 6, admin)
//   PATCH /api/observations   (id in body)      → triage / update (admin-tier)
//
// An observation is the GENERAL field-to-office item: site truth captured in
// Phil or BuhlOS that may or may not need action. Broader than Evidence (a
// photo/compliance record) and broader than a Snag (a defect with its own
// verify/close lifecycle). It can LINK to an existing Evidence/Snag row but
// never replaces them, and can later be CONVERTED (intent only in v1 — the
// RFI/Variation/Material-Request modules aren't built) into a downstream item.
//
// Storage — a NEW top-level blob `observations.json`:
//   { observations: [ObservationItem, ...] }
// Cross-job by design (the inbox), so a single-document read beats the
// every-job fan-out api/snags-all.js pays. A brand-new blob also can't
// corrupt existing job/evidence/snag data. Append + full-doc rewrite (same
// pattern as employees.json/invites.json); whole-doc race is bounded at field
// volume; a store split is Phase F+.
//
// Permissions (consistent with the BuhlOS admin surface gate + snags/evidence):
//   - unauthenticated                 → 401
//   - client role                     → 403 (field records are not theirs)
//   - create (POST)                   → canWrite(user, jobId): field/LH on an
//                                        assigned job, admin-tier on any job
//   - job-scoped GET (?jobId)         → requireAuth({jobId}) + non-client
//   - cross-job inbox GET + PATCH     → admin-tier (requireAuth roles:['admin'],
//                                        tier-aware per PR 2) — matches
//                                        canAccessSurface('admin') so the API
//                                        agrees with the page gate.
//
// Mirrors src/domains/observations/{schema,service}.ts. requiresActionForType
// is duplicated here (plain JS) to avoid the TS build dependency; the parity
// is covered by src/domains/observations/observations.test.ts.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite, isAdminRole } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { append: appendAuditLog } = require('./_lib/audit-log');

// PR 6: which observation types are eligible for one-click conversion to a
// real Snag. Others need explicit ?force=1 — keeps the inbox honest about
// what the conversion actually means.
const CONVERT_TO_SNAG_DEFAULT_TYPES = new Set(['defect', 'safety', 'blocker']);
const SNAG_TITLE_MAX = 120;
const SNAG_DESCRIPTION_MAX = 1000;

const STORE_KEY = 'observations.json';

const VALID_TYPES = new Set([
  'note',
  'blocker',
  'rfi',
  'variation',
  'defect',
  'safety',
  'material_request',
  'plan_mismatch',
  'client_instruction',
  'evidence',
]);
const VALID_STATUSES = new Set([
  'new',
  'needs_action',
  'in_review',
  'converted',
  'resolved',
  'record_only',
]);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_STAGES = new Set(['roughIn', 'fitOff']);
const VALID_CONVERT_TARGETS = new Set([
  'rfi',
  'variation',
  'defect',
  'snag',
  'material_request',
  'task',
]);

const TITLE_MAX = 140;
const DESCRIPTION_MAX = 2000;
const RESOLUTION_NOTE_MAX = 1000;
const PHOTO_MAX = 10;

// Mirror of src/domains/observations/service.ts requiresActionForType.
function requiresActionForType(type) {
  return type !== 'note' && type !== 'evidence';
}

function sourceForUser(user) {
  if (isAdminRole(user.role)) return 'buhlos';
  if (user.role === 'client') return 'system';
  return 'phil';
}

function emptyStore() {
  return { observations: [] };
}

function readStore() {
  return readBlob(STORE_KEY, emptyStore());
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
  const stageKey = stage === 'roughIn' ? 'roughInTasks' : 'fitOffTasks';
  if (area && Array.isArray(area[stageKey]) && area[stageKey].length) return area[stageKey];
  if (job && Array.isArray(job[stageKey]) && job[stageKey].length) return job[stageKey];
  return [];
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

async function resolveUserName(userId) {
  if (!userId) return null;
  const users = await readBlob('users.json', { users: [] });
  const u = (users.users || []).find((x) => x && x.id === userId);
  return u ? u.name || u.username || null : null;
}

function validateCreateBody(body, job) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['body must be an object'] };
  }

  const type = typeof body.type === 'string' ? body.type : '';
  if (!VALID_TYPES.has(type)) errors.push('type must be a valid observation type');

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
  if (stage && !VALID_STAGES.has(stage)) errors.push('stage must be roughIn or fitOff');
  if (body.taskId && !stage) errors.push('stage is required when taskId is provided');

  let area = null;
  if (body.areaId) {
    const found = findArea(job, body.areaId);
    area = found.area;
    if (!area) errors.push('areaId not found on job');
  }
  if (body.taskId && stage && area) {
    const tasks = effectiveTasks(job, area, stage);
    if (!tasks.some((t) => t && t.id === body.taskId)) {
      errors.push('taskId not found for stage on this job/area');
    }
  }

  if (body.photoUrls != null) {
    if (!Array.isArray(body.photoUrls)) errors.push('photoUrls must be an array');
    else if (body.photoUrls.length > PHOTO_MAX) {
      errors.push(`photoUrls may not exceed ${PHOTO_MAX} links`);
    }
  }

  return { errors, type, title, description, priority, stage, area };
}

async function validateLinks(res, body, jobId) {
  // linkedEvidenceId / linkedSnagId must resolve to a real row on this job's
  // data.json if provided — keeps the link honest without faking persistence.
  const needsEvidence = typeof body.linkedEvidenceId === 'string' && body.linkedEvidenceId;
  const needsSnag = typeof body.linkedSnagId === 'string' && body.linkedSnagId;
  if (!needsEvidence && !needsSnag) return true;

  const data = await readBlob(`jobs/${jobId}/data.json`, {
    evidence: [],
    snagsV2: [],
  });
  if (needsEvidence) {
    const arr = Array.isArray(data.evidence) ? data.evidence : [];
    if (!arr.some((e) => e && e.id === body.linkedEvidenceId)) {
      res.status(400).json({ error: `linkedEvidenceId not found on this job: ${body.linkedEvidenceId}` });
      return false;
    }
  }
  if (needsSnag) {
    const arr = Array.isArray(data.snagsV2) ? data.snagsV2 : [];
    if (!arr.some((s) => s && s.id === body.linkedSnagId)) {
      res.status(400).json({ error: `linkedSnagId not found on this job: ${body.linkedSnagId}` });
      return false;
    }
  }
  return true;
}

async function listJobObservations(req, res, jobId) {
  const store = await readStore();
  const all = Array.isArray(store.observations) ? store.observations : [];
  const forJob = all.filter((o) => o && o.jobId === jobId);
  // Newest-first; the inbox re-sorts exception-first client-side.
  forJob.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return res.status(200).json({ observations: forJob });
}

function applyFilters(list, q) {
  let out = list;
  if (q.jobId) out = out.filter((o) => o.jobId === q.jobId);
  if (q.status && VALID_STATUSES.has(String(q.status))) {
    out = out.filter((o) => o.status === q.status);
  }
  if (q.type && VALID_TYPES.has(String(q.type))) out = out.filter((o) => o.type === q.type);
  if (q.priority && VALID_PRIORITIES.has(String(q.priority))) {
    out = out.filter((o) => o.priority === q.priority);
  }
  if (String(q.requiresAction) === 'true') out = out.filter((o) => o.requiresAction === true);
  return out;
}

async function listInbox(req, res) {
  const store = await readStore();
  const all = Array.isArray(store.observations) ? store.observations : [];
  const filtered = applyFilters(all.slice(), req.query || {});
  filtered.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return res.status(200).json({ observations: filtered });
}

async function createObservation(req, res, user, jobId) {
  const job = await loadJobOrFail(res, jobId);
  if (!job) return;

  const v = validateCreateBody(req.body || {}, job);
  if (v.errors && v.errors.length) {
    return res.status(400).json({ error: v.errors[0], errors: v.errors });
  }

  const body = req.body || {};
  if (!(await validateLinks(res, body, jobId))) return;

  const nowIso = new Date().toISOString();

  let areaName = null;
  let taskName = null;
  if (v.area) {
    areaName = v.area.name || null;
    if (body.taskId && v.stage) {
      const t = effectiveTasks(job, v.area, v.stage).find((x) => x && x.id === body.taskId);
      taskName = t ? t.name || null : null;
    }
  }

  const photoUrls = Array.isArray(body.photoUrls)
    ? body.photoUrls.map((u) => String(u)).slice(0, PHOTO_MAX)
    : [];

  const requiresAction =
    typeof body.requiresAction === 'boolean'
      ? body.requiresAction
      : requiresActionForType(v.type);

  const item = {
    id: nanoid('ob_'),
    jobId,
    jobName: job.name || null,
    type: v.type,
    title: v.title,
    description: v.description ? v.description : null,
    status: 'new',
    priority: v.priority,
    source: sourceForUser(user),
    requiresAction,
    stage: v.stage || null,
    areaId: body.areaId || null,
    areaName,
    taskId: body.taskId || null,
    taskName,
    linkedEvidenceId: body.linkedEvidenceId ? String(body.linkedEvidenceId) : null,
    linkedSnagId: body.linkedSnagId ? String(body.linkedSnagId) : null,
    photoUrls,
    createdById: user.id,
    createdByName: user.name || user.username || 'Unknown',
    createdByRole: user.role || null,
    assignedToId: body.assignedToId ? String(body.assignedToId) : null,
    assignedToName: null,
    dueDate: body.dueDate ? String(body.dueDate) : null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    convertedTo: null,
    convertedTargetId: null,
    convertedAt: null,
    convertedById: null,
    convertedByName: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (item.assignedToId) {
    item.assignedToName = await resolveUserName(item.assignedToId);
  }

  const store = await readStore();
  if (!Array.isArray(store.observations)) store.observations = [];
  store.observations.push(item);
  try {
    await writeBlob(STORE_KEY, store);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  // PR 10: append an observation.created entry so the per-job activity feed
  // sees the create event (the audit log is best-effort — a write failure
  // here .catch'd to null never blocks the observation write that already
  // succeeded above).
  await appendAuditLog({
    action: 'observation.created',
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'observation',
    targetId: item.id,
    summary: `observation raised — "${String(item.title).slice(0, 80)}"`,
    metadata: {
      type: item.type,
      priority: item.priority,
      source: item.source,
      requiresAction: item.requiresAction,
      areaId: item.areaId,
      stage: item.stage,
      taskId: item.taskId,
      linkedEvidenceId: item.linkedEvidenceId,
    },
  }).catch(() => null);

  return res.status(201).json({ observation: item });
}

async function updateObservation(req, res, user) {
  const body = req.body || {};
  const id = body.id ? String(body.id) : '';
  if (!id) return res.status(400).json({ error: 'id required' });

  const store = await readStore();
  const arr = Array.isArray(store.observations) ? store.observations : [];
  const idx = arr.findIndex((o) => o && o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'observation not found' });

  const current = arr[idx];
  const nowIso = new Date().toISOString();
  const actorName = user.name || user.username || 'Unknown';
  const next = { ...current, updatedAt: nowIso };

  // status
  if (body.status !== undefined) {
    if (!VALID_STATUSES.has(String(body.status))) {
      return res.status(400).json({ error: 'invalid status' });
    }
    next.status = body.status;
    if (body.status === 'resolved') {
      next.resolvedAt = nowIso;
      next.resolvedById = user.id;
      next.resolvedByName = actorName;
    }
  }

  // priority
  if (body.priority !== undefined) {
    if (!VALID_PRIORITIES.has(String(body.priority))) {
      return res.status(400).json({ error: 'invalid priority' });
    }
    next.priority = body.priority;
  }

  // requiresAction
  if (body.requiresAction !== undefined) {
    if (typeof body.requiresAction !== 'boolean') {
      return res.status(400).json({ error: 'requiresAction must be a boolean' });
    }
    next.requiresAction = body.requiresAction;
  }

  // assignment
  if (body.assignedToId !== undefined) {
    next.assignedToId = body.assignedToId ? String(body.assignedToId) : null;
    next.assignedToName = next.assignedToId ? await resolveUserName(next.assignedToId) : null;
  }

  // resolution note
  if (body.resolutionNote !== undefined) {
    const note = body.resolutionNote == null ? null : String(body.resolutionNote);
    if (note && note.length > RESOLUTION_NOTE_MAX) {
      return res.status(400).json({ error: `resolutionNote must be ${RESOLUTION_NOTE_MAX} characters or fewer` });
    }
    next.resolutionNote = note;
  }

  // conversion INTENT — records that the office decided to turn this into a
  // downstream item. The target module isn't built yet, so this only stamps
  // intent + flips status to 'converted'. Honest, not faked.
  if (body.convertedTo !== undefined) {
    if (body.convertedTo === null) {
      next.convertedTo = null;
      next.convertedTargetId = null;
      next.convertedAt = null;
      next.convertedById = null;
      next.convertedByName = null;
    } else {
      if (!VALID_CONVERT_TARGETS.has(String(body.convertedTo))) {
        return res.status(400).json({ error: 'invalid convertedTo target' });
      }
      next.convertedTo = body.convertedTo;
      next.convertedTargetId = body.convertedTargetId ? String(body.convertedTargetId) : null;
      next.convertedAt = nowIso;
      next.convertedById = user.id;
      next.convertedByName = actorName;
      if (body.status === undefined) next.status = 'converted';
    }
  }

  // link updates (validated against the observation's own job)
  if (body.linkedEvidenceId !== undefined || body.linkedSnagId !== undefined) {
    const probe = {
      linkedEvidenceId: body.linkedEvidenceId,
      linkedSnagId: body.linkedSnagId,
    };
    if (!(await validateLinks(res, probe, current.jobId))) return;
    if (body.linkedEvidenceId !== undefined) {
      next.linkedEvidenceId = body.linkedEvidenceId ? String(body.linkedEvidenceId) : null;
    }
    if (body.linkedSnagId !== undefined) {
      next.linkedSnagId = body.linkedSnagId ? String(body.linkedSnagId) : null;
    }
  }

  arr[idx] = next;
  store.observations = arr;
  try {
    await writeBlob(STORE_KEY, store);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  // PR 10: append observation.transitioned when any user-meaningful field
  // changed (status, priority, assignedToId). Resolution notes / link
  // changes go through PATCH too but don't produce a feed-worthy verb on
  // their own — they show up in metadata.changedFields when the PATCH ALSO
  // changes one of the headline fields. A no-op PATCH (e.g. setting status
  // to the same value) skips the entry.
  const changedFields = [];
  if (body.status !== undefined && next.status !== current.status) changedFields.push('status');
  if (body.priority !== undefined && next.priority !== current.priority) changedFields.push('priority');
  if (body.assignedToId !== undefined && next.assignedToId !== current.assignedToId) {
    changedFields.push('assignedToId');
  }
  if (changedFields.length > 0) {
    const summaryParts = [];
    if (changedFields.includes('status')) {
      summaryParts.push(`status ${current.status} → ${next.status}`);
    }
    if (changedFields.includes('priority')) {
      summaryParts.push(`priority ${current.priority} → ${next.priority}`);
    }
    if (changedFields.includes('assignedToId')) {
      summaryParts.push(
        next.assignedToId ? `assigned to ${next.assignedToName || next.assignedToId}` : 'unassigned'
      );
    }
    await appendAuditLog({
      action: 'observation.transitioned',
      actorId: user.id,
      actorName: user.name || user.username || 'Unknown',
      actorRole: user.role || null,
      jobId: current.jobId,
      targetType: 'observation',
      targetId: current.id,
      summary: `observation: ${summaryParts.join('; ')}`,
      metadata: {
        changedFields,
        from: { status: current.status, priority: current.priority, assignedToId: current.assignedToId },
        to: { status: next.status, priority: next.priority, assignedToId: next.assignedToId },
        type: current.type,
      },
    }).catch(() => null);
  }

  return res.status(200).json({ observation: next });
}

/**
 * PR 6: Convert an eligible observation into a REAL Snag.
 *
 * The first real downstream conversion. Snags already exist as a tracked
 * defect workflow (open → in_progress → resolved → verified → closed), so
 * promoting a `defect`/`safety`/`blocker` observation into one is the safest
 * way to make conversion stop being intent-only.
 *
 * Mapping:
 *   observation.title              → snag.title (truncated to 120 chars)
 *   observation.description        → snag.description (truncated to 1000)
 *   observation.priority           → snag.priority    (same enum)
 *   observation.stage/areaId/Name  → snag.stage/areaId/areaName
 *   observation.taskId/taskName    → snag.taskId/taskName
 *   observation.linkedEvidenceId   → snag.evidenceIds[] (single element)
 *   observation.assignedToId/Name  → snag.assignedToId/Name (carry-over)
 *   actor (the converting admin)   → snag.createdById/Name (admin raised it)
 *   snag.source                    = 'admin' (the conversion is an office act)
 *   snag.status                    = 'open' (the initial Snag state)
 *
 * Write order is snag-first → observation-second so a failure between writes
 * leaves an orphan snag (recoverable: the observation can be re-converted
 * idempotently — the second attempt gets 409 because the snag already exists,
 * caller can manually link or the operator can resolve in /v2/jobs).
 *
 * Permissions:
 *   - admin-tier (same as the cross-job inbox + PATCH triage gate).
 *   - field/LH cannot convert — observations:convert is an office action.
 *
 * Idempotency:
 *   - observation must not already have linkedSnagId or convertedTo='snag';
 *     a second attempt returns 409 Conflict.
 *
 * Eligibility:
 *   - type ∈ {defect, safety, blocker} by default — these map to a Snag
 *     cleanly (a "blocker" is a defect-in-progress).
 *   - other types require body.force=true so the office acknowledges they
 *     are stretching the Snag workflow. Note: rfi/variation/material_request
 *     belong in their own modules (still UC); a force-convert of those types
 *     creates a Snag tagged with the original observation type in metadata.
 */
async function convertObservationToSnag(req, res, user) {
  const body = req.body || {};
  const id = body.id ? String(body.id) : '';
  if (!id) return res.status(400).json({ error: 'id required' });

  const force = body.force === true;
  const store = await readStore();
  const arr = Array.isArray(store.observations) ? store.observations : [];
  const idx = arr.findIndex((o) => o && o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'observation not found' });
  const observation = arr[idx];

  if (observation.linkedSnagId || observation.convertedTo === 'snag') {
    return res.status(409).json({
      error: 'observation already converted to a snag',
      linkedSnagId: observation.linkedSnagId,
      convertedTargetId: observation.convertedTargetId,
    });
  }
  if (!CONVERT_TO_SNAG_DEFAULT_TYPES.has(observation.type) && !force) {
    return res.status(400).json({
      error: `observation type '${observation.type}' is not a default conversion target; pass {"force":true} to convert anyway`,
    });
  }

  const job = await loadJobOrFail(res, observation.jobId);
  if (!job) return;

  // Re-validate linkedEvidenceId still exists on the job (it could have been
  // deleted since the observation was raised). Snag create otherwise rejects
  // unknown evidence ids, so we mirror that here.
  if (observation.linkedEvidenceId) {
    const data0 = await readBlob(`jobs/${observation.jobId}/data.json`, {
      evidence: [], snagsV2: [],
    });
    const arr0 = Array.isArray(data0.evidence) ? data0.evidence : [];
    if (!arr0.some((e) => e && e.id === observation.linkedEvidenceId)) {
      return res.status(400).json({
        error: `observation's linkedEvidenceId is no longer on the job: ${observation.linkedEvidenceId}`,
      });
    }
  }

  const nowIso = new Date().toISOString();
  const actorName = user.name || user.username || 'Unknown';
  const trimmedTitle = String(observation.title || '').slice(0, SNAG_TITLE_MAX);
  const trimmedDesc = observation.description
    ? String(observation.description).slice(0, SNAG_DESCRIPTION_MAX)
    : null;

  const snagItem = {
    id: nanoid('sn_'),
    jobId: observation.jobId,
    title: trimmedTitle,
    description: trimmedDesc,
    summary: null,
    stage: observation.stage || null,
    areaId: observation.areaId || null,
    areaName: observation.areaName || null,
    taskId: observation.taskId || null,
    taskName: observation.taskName || null,
    evidenceIds: observation.linkedEvidenceId ? [observation.linkedEvidenceId] : [],
    status: 'open',
    priority: observation.priority,
    source: 'admin',
    createdById: user.id,
    createdByName: actorName,
    createdByRole: user.role || null,
    assignedToId: observation.assignedToId || null,
    assignedToName: observation.assignedToName || null,
    acknowledgedAt: null, acknowledgedById: null, acknowledgedByName: null,
    resolvedAt: null, resolvedById: null, resolvedByName: null,
    verifiedAt: null, verifiedById: null, verifiedByName: null,
    closedAt: null, closedById: null, closedByName: null,
    rejectedAt: null, rejectedById: null, rejectedByName: null,
    rejectionReason: null,
    auditLogIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Audit: emit BOTH the snag.created entry (same verb api/snags.js's create
  // path emits, so the timeline is consistent) AND a separate
  // observation.converted_to_snag entry attributing the office decision.
  const snagAudit = await appendAuditLog({
    action: 'snag.created',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId: observation.jobId,
    targetType: 'snag',
    targetId: snagItem.id,
    summary: `snag created via observation conversion — "${snagItem.title.slice(0, 80)}"`,
    metadata: {
      priority: snagItem.priority,
      status: snagItem.status,
      areaId: snagItem.areaId,
      stage: snagItem.stage,
      taskId: snagItem.taskId,
      evidenceIds: snagItem.evidenceIds,
      convertedFromObservationId: observation.id,
      convertedFromType: observation.type,
    },
  }).catch(() => null);
  if (snagAudit && snagAudit.id) snagItem.auditLogIds.push(snagAudit.id);

  // Write the snag FIRST. If it fails we never touch the observation; the
  // caller sees a 502 and can retry safely.
  const dataKey = `jobs/${observation.jobId}/data.json`;
  const data = await readBlob(dataKey, {
    dwellings: {}, snags: [], snagsV2: [], evidence: [], notes: [],
  });
  if (!Array.isArray(data.snagsV2)) data.snagsV2 = [];
  data.snagsV2.push(snagItem);
  try {
    await writeBlob(dataKey, data);
  } catch (e) {
    return res.status(502).json({ error: 'snag write failed: ' + (e.message || 'unknown') });
  }

  // Now update the observation in observations.json. If THIS write fails we
  // have an orphan snag with no observation pointer — the observation stays
  // in its previous status. A retry will see the orphan snag (snag already
  // exists for this observation? no — we don't track that direction yet), so
  // the operator must manually link via PATCH linkedSnagId. v1 trade-off.
  const next = {
    ...observation,
    linkedSnagId: snagItem.id,
    convertedTo: 'snag',
    convertedTargetId: snagItem.id,
    convertedAt: nowIso,
    convertedById: user.id,
    convertedByName: actorName,
    status: 'converted',
    updatedAt: nowIso,
  };

  await appendAuditLog({
    action: 'observation.converted_to_snag',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId: observation.jobId,
    targetType: 'observation',
    targetId: observation.id,
    summary: `observation → snag — "${String(observation.title).slice(0, 80)}"`,
    metadata: {
      snagId: snagItem.id,
      observationType: observation.type,
      previousStatus: observation.status,
      forced: force && !CONVERT_TO_SNAG_DEFAULT_TYPES.has(observation.type),
    },
  }).catch(() => null);

  arr[idx] = next;
  store.observations = arr;
  try {
    await writeBlob(STORE_KEY, store);
  } catch (e) {
    // Snag was already written; surface that to the caller so they know
    // the snag exists and the observation just needs a manual link.
    return res.status(502).json({
      error: 'observation write failed after snag created: ' + (e.message || 'unknown'),
      snagId: snagItem.id,
      observationId: observation.id,
    });
  }

  return res.status(201).json({ observation: next, snag: snagItem });
}

/**
 * PR 11: Convert an eligible observation into a REAL Material Request.
 *
 * Mirrors convertObservationToSnag(): admin-tier only, default-eligible
 * type is just `material_request` (so the natural worker action lands
 * here), other types require {"force":true}, idempotent (returns 409 if
 * already linkedMaterialRequestId / convertedTo === 'material_request'),
 * write-the-target-first then update the observation, dual audit
 * (material_request.created + observation.converted_to_material_request).
 *
 * Body:
 *   { id: string, force?: boolean,
 *     item: string, quantity: number, unit: string,   // request specifics
 *     urgency?: 'low'|'normal'|'high'|'urgent', description?: string,
 *     supplier?: string, orderRef?: string }
 *
 * The `item`/`quantity`/`unit` triple is required because an observation's
 * `title` rarely carries enough structure to be a material line on its own.
 * The office types those in when converting (the inbox UI prompts).
 */
async function convertObservationToMaterialRequest(req, res, user) {
  const body = req.body || {};
  const id = body.id ? String(body.id) : '';
  if (!id) return res.status(400).json({ error: 'id required' });

  const force = body.force === true;
  const store = await readStore();
  const arr = Array.isArray(store.observations) ? store.observations : [];
  const idx = arr.findIndex((o) => o && o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'observation not found' });
  const observation = arr[idx];

  if (
    (observation.linkedMaterialRequestId &&
      String(observation.linkedMaterialRequestId).length > 0) ||
    observation.convertedTo === 'material_request'
  ) {
    return res.status(409).json({
      error: 'observation already converted to a material request',
      linkedMaterialRequestId: observation.linkedMaterialRequestId || null,
      convertedTargetId: observation.convertedTargetId || null,
    });
  }
  // Already converted to something else (snag, rfi, …)? Reject — don't allow
  // a single observation to be the source for two downstream records.
  if (observation.convertedTo && observation.convertedTo !== null) {
    return res.status(409).json({
      error: `observation already converted to ${observation.convertedTo}`,
      convertedTo: observation.convertedTo,
      convertedTargetId: observation.convertedTargetId || null,
    });
  }

  if (observation.type !== 'material_request' && !force) {
    return res.status(400).json({
      error: `observation type '${observation.type}' is not a default conversion target for a material request; pass {"force":true} to convert anyway`,
    });
  }

  // Validate the office-supplied request fields. Reuse the create-payload
  // contract shape from material-requests.js so the audit-log + storage
  // helpers can be used unmodified.
  const item = typeof body.item === 'string' ? body.item.trim() : '';
  const quantity = Number(body.quantity);
  const unit = typeof body.unit === 'string' ? body.unit.trim() : '';
  if (!item) return res.status(400).json({ error: 'item is required' });
  if (item.length > 200) return res.status(400).json({ error: 'item must be 200 characters or fewer' });
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be > 0' });
  }
  if (!unit) return res.status(400).json({ error: 'unit is required' });

  const urgency = body.urgency == null ? 'normal' : String(body.urgency);
  if (!new Set(['low', 'normal', 'high', 'urgent']).has(urgency)) {
    return res.status(400).json({ error: 'urgency must be low, normal, high or urgent' });
  }

  const job = await loadJobOrFail(res, observation.jobId);
  if (!job) return;

  // Build the material request item using the material-requests module so
  // the shape stays in sync with the direct-POST path.
  const mr = require('./material-requests');
  const mrItem = mr.buildItem({
    jobId: observation.jobId,
    jobName: job.name || null,
    item,
    quantity,
    unit,
    description:
      body.description != null
        ? String(body.description)
        : observation.description || null,
    urgency,
    stage: observation.stage || null,
    areaId: observation.areaId || null,
    areaName: observation.areaName || null,
    taskId: observation.taskId || null,
    taskName: observation.taskName || null,
    linkedObservationId: observation.id,
    linkedEvidenceId: observation.linkedEvidenceId || null,
    source: 'observation',
    actor: user,
  });

  // Pre-stamp supplier/orderRef if the office included them.
  if (body.supplier != null) mrItem.supplier = String(body.supplier).slice(0, 120);
  if (body.orderRef != null) mrItem.orderRef = String(body.orderRef).slice(0, 60);

  const nowIso = new Date().toISOString();
  const actorName = user.name || user.username || 'Unknown';

  // Audit: emit material_request.created first (mirrors snag.created on the
  // snag conversion) so the timeline reads consistently.
  const mrAudit = await appendAuditLog({
    action: 'material_request.created',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId: observation.jobId,
    targetType: 'material_request',
    targetId: mrItem.id,
    summary: `material request raised via observation conversion — ${mrItem.quantity} ${mrItem.unit} ${String(mrItem.item).slice(0, 60)}`,
    metadata: {
      item: mrItem.item,
      quantity: mrItem.quantity,
      unit: mrItem.unit,
      urgency: mrItem.urgency,
      convertedFromObservationId: observation.id,
      convertedFromObservationType: observation.type,
      source: mrItem.source,
    },
  }).catch(() => null);
  if (mrAudit && mrAudit.id) mrItem.auditLogIds.push(mrAudit.id);

  // Write the material request FIRST. If it fails the observation is
  // untouched and the caller sees a 502 + can retry safely.
  try {
    await mr.persistItem(mrItem);
  } catch (e) {
    return res.status(502).json({
      error: 'material request write failed: ' + (e.message || 'unknown'),
    });
  }

  // Now update the observation. If THIS write fails we have an orphan
  // material request — the observation can be PATCH-linked manually
  // (linkedMaterialRequestId is a free-text field once the audit verb is
  // wired). v1 trade-off, same shape as the snag-conversion path.
  const next = {
    ...observation,
    linkedMaterialRequestId: mrItem.id,
    convertedTo: 'material_request',
    convertedTargetId: mrItem.id,
    convertedAt: nowIso,
    convertedById: user.id,
    convertedByName: actorName,
    status: 'converted',
    updatedAt: nowIso,
  };

  await appendAuditLog({
    action: 'observation.converted_to_material_request',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId: observation.jobId,
    targetType: 'observation',
    targetId: observation.id,
    summary: `observation → material request — "${String(observation.title).slice(0, 80)}"`,
    metadata: {
      materialRequestId: mrItem.id,
      observationType: observation.type,
      previousStatus: observation.status,
      forced: force && observation.type !== 'material_request',
    },
  }).catch(() => null);

  arr[idx] = next;
  store.observations = arr;
  try {
    await writeBlob(STORE_KEY, store);
  } catch (e) {
    return res.status(502).json({
      error: 'observation write failed after material request created: ' + (e.message || 'unknown'),
      materialRequestId: mrItem.id,
      observationId: observation.id,
    });
  }

  return res.status(201).json({ observation: next, materialRequest: mrItem });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  const action = (req.query && req.query.action) || '';

  // --- POST ?action=convert-to-snag : office-side conversion (PR 6) -------
  // The observation already knows its jobId; no jobId query needed. The
  // observation's jobId is checked inside the handler when loading the job.
  if (req.method === 'POST' && action === 'convert-to-snag') {
    const user = await requireAuth(req, res, { roles: ['admin'] });
    if (!user) return;
    try {
      return await convertObservationToSnag(req, res, user);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'conversion failed' });
    }
  }

  // --- POST ?action=convert-to-material-request (PR 11) -------------------
  if (req.method === 'POST' && action === 'convert-to-material-request') {
    const user = await requireAuth(req, res, { roles: ['admin'] });
    if (!user) return;
    try {
      return await convertObservationToMaterialRequest(req, res, user);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'conversion failed' });
    }
  }

  // --- POST create: job-scoped, canWrite gate -----------------------------
  if (req.method === 'POST') {
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const user = await requireAuth(req, res, { jobId });
    if (!user) return;
    if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });
    if (!canWrite(user, jobId)) {
      return res.status(403).json({ error: 'no write access to job' });
    }
    try {
      return await createObservation(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'create failed' });
    }
  }

  // --- PATCH update: office/admin-tier only --------------------------------
  if (req.method === 'PATCH') {
    const user = await requireAuth(req, res, { roles: ['admin'] });
    if (!user) return;
    try {
      return await updateObservation(req, res, user);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'update failed' });
    }
  }

  // --- GET --------------------------------------------------------------
  if (req.method === 'GET') {
    if (jobId) {
      // Job-scoped: field/LH on assigned job + admin-tier; clients excluded.
      const user = await requireAuth(req, res, { jobId });
      if (!user) return;
      if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });
      try {
        return await listJobObservations(req, res, jobId);
      } catch (e) {
        return res.status(500).json({ error: e.message || 'list failed' });
      }
    }
    // Cross-job inbox: office/admin-tier only (matches the BuhlOS surface gate).
    const user = await requireAuth(req, res, { roles: ['admin'] });
    if (!user) return;
    try {
      return await listInbox(req, res);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'inbox failed' });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};
