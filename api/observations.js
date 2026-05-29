// Observations domain endpoint — PR 3.
//
//   GET   /api/observations                     → cross-job inbox (office/admin)
//   GET   /api/observations?jobId=<id>          → one job's observations
//   POST  /api/observations?jobId=<id>          → create one (canWrite)
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

  return res.status(200).json({ observation: next });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';

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
