// Evidence domain endpoint — Phase D2 foundation.
//
//   GET  /api/evidence?jobId=<id>                  → list evidence for a job
//   POST /api/evidence?jobId=<id>                  → create one evidence item
//   POST /api/evidence?jobId=<id>&action=review    → admin review (D4 stub)
//
// D2 ships the backend foundation that future D3 (Phil capture UI) and
// D4 (admin evidence review) consume. The capture UI itself is not
// shipped in D2 — D2 endpoint accepts:
//   - kind=note  with a non-empty note (≤280 chars)
//   - kind=photo with photoId + photoUrl pre-uploaded via
//     api/photos.js?action=upload-evidence-photo
//
// Storage shape — matches doc 24 §15.0 Decision 2:
//   jobs/<jobId>/data.json
//     { dwellings, snags, evidence: [ EvidenceItem, ... ], notes }
//   Append + full-doc rewrite (same pattern as api/task-toggle.js).
//   Full-doc-write risk is bounded: small per-job evidence counts in
//   Phase D, ~50ms race window, Postgres split in Phase F+.
//
// Permissions — matches doc 24 §15.0 Decision 5 + 6 / doc 28 §A.4:
//   - unauthenticated → 401
//   - client role     → 403 (read-only role; no evidence surface)
//   - tradie GET      → only own captures (capturedById === me.id)
//   - LH GET          → all captures for the job (review action = D4)
//   - admin GET       → all captures for the job
//   - tradie / LH POST → assigned jobs only (canWrite gate)
//   - admin POST      → any job
//   - review POST     → admin only (403 otherwise)
//
// Task ID validation — matches doc 24 §6 + the D3 warning in the
// session brief: only canonical task IDs are accepted. We resolve via
// effectiveRoughInTasks/effectiveFitOffTasks (api/_lib/job-tasks.js)
// so per-area overrides take precedence over the job-level template.
// Legacy `stages: { roughIn: [strings] }` are read-only passthrough
// elsewhere and never accepted as taskId input here.
//
// Audit — dual-write per doc 28 §A.5:
//   1. Legacy api/_lib/job-audit.js per-job log (kept for the admin
//      audit tab's legacy reader path).
//   2. New api/_lib/audit-log.js monthly cross-surface journal.
// Both calls are best-effort — wrapped in `.catch(() => {})` so a log
// failure on either path never blocks the evidence write.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const {
  effectiveRoughInTasks,
  effectiveFitOffTasks,
} = require('./_lib/job-tasks');
const { appendAudit: appendLegacyAudit } = require('./_lib/job-audit');
const { append: appendAuditLog } = require('./_lib/audit-log');

const VALID_KINDS = new Set(['photo', 'note']);
const VALID_STAGES = new Set(['roughIn', 'fitOff']);
const NOTE_MAX = 280;
const REJECTION_REASON_MAX = 500;

function dataKey(jobId) {
  return `jobs/${jobId}/data.json`;
}

function emptyData() {
  return { dwellings: {}, snags: [], evidence: [], notes: [] };
}

function findArea(job, areaId) {
  for (const g of (job && job.areaGroups) || []) {
    for (const a of (g && g.areas) || []) {
      if (a && a.id === areaId) return a;
    }
  }
  return null;
}

function validateCreateBody(body, job) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return ['body must be an object'];
  }
  const { kind, areaId, stage, taskId, photoId, photoUrl, note } = body;
  if (!kind || !VALID_KINDS.has(kind)) {
    errors.push('kind must be photo or note');
  }
  if (kind === 'note') {
    const n = typeof note === 'string' ? note.trim() : '';
    if (!n) errors.push('note is required for kind=note');
  }
  if (kind === 'photo') {
    if (!photoId) errors.push('photoId is required for kind=photo');
    if (!photoUrl) errors.push('photoUrl is required for kind=photo');
  }
  if (typeof note === 'string' && note.length > NOTE_MAX) {
    errors.push(`note must be ${NOTE_MAX} characters or fewer`);
  }
  if (stage != null && !VALID_STAGES.has(stage)) {
    errors.push('stage must be roughIn or fitOff');
  }
  if (taskId && !stage) {
    errors.push('stage is required when taskId is provided');
  }

  // Structural validation against the job — area must exist on the job
  // (if provided), and taskId must resolve via canonical task lookup.
  let area = null;
  if (areaId) {
    area = findArea(job, areaId);
    if (!area) errors.push('areaId not found on job');
  }
  if (taskId && stage && errors.length === 0) {
    const tasks =
      stage === 'roughIn'
        ? effectiveRoughInTasks(job, area)
        : effectiveFitOffTasks(job, area);
    if (!tasks.some((t) => t && t.id === taskId)) {
      errors.push('taskId not found for stage on this job/area');
    }
  }
  return errors;
}

function sourceForUser(user) {
  if (user.role === 'admin') return 'admin';
  return 'phil';
}

// Server-side state machine — mirrors src/domains/evidence/service.ts
// canTransition(). Kept duplicated here so the API doesn't depend on
// the TypeScript build output. Tested in evidence.test.ts.
const ALLOWED_TRANSITIONS = new Set([
  'null→submitted',
  'submitted→reviewed',
  'submitted→rejected',
  'reviewed→submitted',
]);
function canTransition(from, to) {
  const key = `${from == null ? 'null' : from}→${to}`;
  return ALLOWED_TRANSITIONS.has(key);
}

async function loadJobOrFail(res, jobId) {
  const jobsBlob = await readBlob('jobs.json', null);
  if (!jobsBlob || typeof jobsBlob !== 'object' || !Array.isArray(jobsBlob.jobs)) {
    // Doc 28 §A.6: no silent fallback — surface the storage outage so
    // the caller sees a 5xx instead of a falsely-empty list.
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

async function listEvidence(req, res, user, jobId) {
  const data = await readBlob(dataKey(jobId), emptyData());
  const all = Array.isArray(data && data.evidence) ? data.evidence : [];
  const visible =
    user.role === 'tradie'
      ? all.filter((ev) => ev && ev.capturedById === user.id)
      : all;
  // Newest first — UI consumers want the most-recent capture on top.
  const sorted = visible
    .slice()
    .sort((a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')));
  return res.status(200).json({ evidence: sorted });
}

async function createEvidence(req, res, user, jobId) {
  // Fetch job up-front so validation can resolve area + task before we
  // touch the per-job data.json (cheaper failure path on bad input).
  const job = await loadJobOrFail(res, jobId);
  if (!job) return;

  const errors = validateCreateBody(req.body || {}, job);
  if (errors.length) {
    return res.status(400).json({ error: errors[0], errors });
  }

  const body = req.body || {};
  const nowIso = new Date().toISOString();
  const item = {
    id: nanoid('ev_'),
    jobId,
    areaId: body.areaId || null,
    stage: body.stage || null,
    taskId: body.taskId || null,
    kind: body.kind,
    photoId: body.photoId || null,
    photoUrl: body.photoUrl || null,
    thumbnailUrl: body.thumbnailUrl || null,
    note: typeof body.note === 'string' ? body.note.trim() : null,
    capturedById: user.id,
    capturedByName: user.name || user.username || 'Unknown',
    capturedByRole: user.role || null,
    capturedAt: nowIso,
    clientCapturedAt: body.clientCapturedAt || null,
    exifLocation:
      body.exifLocation &&
      typeof body.exifLocation.lat === 'number' &&
      typeof body.exifLocation.lng === 'number'
        ? { lat: body.exifLocation.lat, lng: body.exifLocation.lng }
        : null,
    status: 'submitted',
    source: sourceForUser(user),
    reviewedById: null,
    reviewedByName: null,
    reviewedAt: null,
    rejectionReason: null,
    auditLogIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Write the new audit row first so we can stamp the evidence item
  // with its id before persisting the item. If the audit write fails,
  // the evidence write still proceeds (auditLogIds just stays empty).
  const auditEntry = await appendAuditLog({
    action: 'evidence.captured',
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'evidence',
    targetId: item.id,
    summary: `${item.kind} evidence captured${item.note ? ` — "${item.note.slice(0, 60)}"` : ''}`,
    metadata: {
      kind: item.kind,
      areaId: item.areaId,
      stage: item.stage,
      taskId: item.taskId,
      photoUrl: item.photoUrl,
    },
  }).catch(() => null);
  if (auditEntry && auditEntry.id) item.auditLogIds.push(auditEntry.id);

  const KEY = dataKey(jobId);
  const data = await readBlob(KEY, emptyData());
  if (!Array.isArray(data.evidence)) data.evidence = [];
  data.evidence.push(item);

  try {
    await writeBlob(KEY, data);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  // Dual-write to the legacy per-job structural log. Best-effort —
  // never blocks the response. The legacy admin audit tab consumes
  // this path; the new monthly journal serves cross-job analytics.
  appendLegacyAudit(jobId, {
    byUserId: user.id,
    byUsername: user.username || user.name || '',
    kind: 'evidence_created',
    summary: `${item.kind} evidence captured${item.note ? ` — "${item.note.slice(0, 60)}"` : ''}`,
    after: {
      evidenceId: item.id,
      kind: item.kind,
      areaId: item.areaId,
      stage: item.stage,
      taskId: item.taskId,
    },
  }).catch(() => {});

  // Return the canonical written item directly — avoids the Phase C
  // BUG-C-004 read-after-write lag (Blob has ~5s in-memory cache TTL).
  return res.status(201).json({ evidenceItem: item });
}

async function reviewEvidence(req, res, user, jobId) {
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  const body = req.body || {};
  const { evidenceId } = body;
  const targetStatus = body.status;
  const rejectionReason =
    typeof body.rejectionReason === 'string' ? body.rejectionReason.trim() : '';

  if (!evidenceId) return res.status(400).json({ error: 'evidenceId required' });
  if (targetStatus !== 'reviewed' && targetStatus !== 'rejected' && targetStatus !== 'submitted') {
    return res.status(400).json({ error: 'status must be reviewed, rejected or submitted' });
  }
  if (targetStatus === 'rejected' && !rejectionReason) {
    return res.status(400).json({ error: 'rejectionReason required when status=rejected' });
  }
  if (rejectionReason.length > REJECTION_REASON_MAX) {
    return res.status(400).json({ error: `rejectionReason must be ${REJECTION_REASON_MAX} characters or fewer` });
  }

  const KEY = dataKey(jobId);
  const data = await readBlob(KEY, emptyData());
  const arr = Array.isArray(data.evidence) ? data.evidence : [];
  const idx = arr.findIndex((ev) => ev && ev.id === evidenceId);
  if (idx === -1) return res.status(404).json({ error: 'evidence not found on job' });
  const current = arr[idx];

  if (!canTransition(current.status, targetStatus)) {
    return res
      .status(400)
      .json({ error: `invalid transition: ${current.status} → ${targetStatus}` });
  }

  const nowIso = new Date().toISOString();
  const next = {
    ...current,
    status: targetStatus,
    reviewedById: user.id,
    reviewedByName: user.name || user.username || 'Unknown',
    reviewedAt: nowIso,
    rejectionReason: targetStatus === 'rejected' ? rejectionReason : null,
    updatedAt: nowIso,
  };

  const action = targetStatus === 'rejected' ? 'evidence.rejected' : 'evidence.reviewed';
  const auditEntry = await appendAuditLog({
    action,
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'evidence',
    targetId: next.id,
    summary: targetStatus === 'rejected'
      ? `evidence rejected — "${rejectionReason.slice(0, 80)}"`
      : 'evidence marked reviewed',
    metadata: { previousStatus: current.status, rejectionReason: next.rejectionReason },
  }).catch(() => null);
  if (auditEntry && auditEntry.id) {
    next.auditLogIds = [...(current.auditLogIds || []), auditEntry.id];
  }

  arr[idx] = next;
  data.evidence = arr;
  try {
    await writeBlob(KEY, data);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  appendLegacyAudit(jobId, {
    byUserId: user.id,
    byUsername: user.username || user.name || '',
    kind: action,
    summary: targetStatus === 'rejected'
      ? `evidence ${next.id} rejected — "${rejectionReason.slice(0, 60)}"`
      : `evidence ${next.id} marked reviewed`,
    before: { status: current.status },
    after: { status: next.status, rejectionReason: next.rejectionReason },
  }).catch(() => {});

  return res.status(200).json({ evidenceItem: next });
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
      return await listEvidence(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'list failed' });
    }
  }

  if (req.method === 'POST' && action === 'review') {
    try {
      return await reviewEvidence(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'review failed' });
    }
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) {
      return res.status(403).json({ error: 'no write access to job' });
    }
    try {
      return await createEvidence(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'create failed' });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};
