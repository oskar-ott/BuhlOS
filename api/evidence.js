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
const { requireAuth, canWrite, canManageJob, isAdminRole, isFieldRole, isClientRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { nanoid } = require('./_lib/validation');
const {
  effectiveRoughInTasks,
  effectiveFitOffTasks,
} = require('./_lib/job-tasks');
const { appendAudit: appendLegacyAudit } = require('./_lib/job-audit');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { idempotencyKeyFrom, findIdempotent, recordIdempotent } = require('./_lib/idempotency');
// #262 — AI photo labels: the one gateway (#170) + the label merge rules.
const { aiComplete, isAiConfigured } = require('./_lib/ai');
const { parseModelJson } = require('./_lib/ai-suggestions');
const {
  PHOTO_LABEL_TAXONOMY,
  PHOTO_LABELS_PROMPT_VERSION,
  hasAiLabelRun,
  mergeAiLabels,
  applyLabelCorrection,
} = require('./_lib/photo-labels');

// `test_result` (#517) is the companion proof minted when a worker saves a
// structured electrical TestRecord — the numbers live in
// jobs/<jobId>/test-records.json; this row carries a `testRecordId` pointer + an
// honest one-line summary note. It rides the SAME create path so it inherits the
// audit dual-write + idempotency and lands in the same evidence[] array the
// proof-loop's loadJobProofIds reads (extend, never fork the proof loop).
const VALID_KINDS = new Set(['photo', 'note', 'test_result']);
const VALID_STAGES = new Set(['roughIn', 'fitOff']);
const NOTE_MAX = 280;
const REJECTION_REASON_MAX = 500;

function dataKey(jobId) {
  return `jobs/${jobId}/data.json`;
}

function emptyData() {
  return { dwellings: {}, snags: [], evidence: [], notes: [] };
}

// #157/#511 — jobs/<id>/data.json is a shared multi-writer document: several
// workers capture into the SAME job at once (and an admin can review while a
// worker captures). The old cached-read → mutate → plain-write shape loses the
// slower writer's evidence row after both got a 201 (lost-update class —
// exactly the #511 registry case).
//
// expectedRev alone is NOT enough here: writeBlob's revision check is a fresh
// read followed by a non-atomic put ("narrows the race, can't eliminate it" —
// api/_lib/blob.js), so two same-instant captures can BOTH pass the check and
// the slower put still wins the document. This helper therefore couples the
// #511 re-read/re-apply retry with VERIFY-AFTER-WRITE: after a successful put
// it loops back, re-reads fresh, and only resolves once `applied(doc)` is
// observably true — a clobbered write is detected and re-applied instead of
// silently lost. Retries exhaust into a thrown error (an honest 502), never a
// false success.
//
//   applied(doc) → true when THIS request's effect is present in the fresh doc
//   apply(doc)   → { ok: true } to mutate+write, { ok: false, ...why } to abort
const DATA_WRITE_ATTEMPTS = 8;
async function writeJobDataCas(KEY, { applied, apply }) {
  let wrote = false;
  for (let attempt = 0; attempt < DATA_WRITE_ATTEMPTS; attempt += 1) {
    const data = await readBlob(KEY, emptyData());
    if (!Array.isArray(data.evidence)) data.evidence = [];
    if (applied(data)) return { written: true, data };
    const out = apply(data);
    if (!out || out.ok !== true) return { written: false, data, ...(out || {}) };
    try {
      await writeBlob(KEY, data, {
        expectedRev: Number.isFinite(data.__rev) ? data.__rev : 0,
      });
      wrote = true; // loop back to VERIFY the write survived any racing put
    } catch (e) {
      if (e && e.code === 'stale_write') continue; // racer landed — re-read, re-apply
      throw e;
    }
  }
  throw new Error(
    `data.json write ${wrote ? 'could not be verified' : 'retries exhausted'} for ${KEY}`,
  );
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
  const { kind, areaId, stage, taskId, photoId, photoUrl, note, testRecordId } = body;
  if (!kind || !VALID_KINDS.has(kind)) {
    errors.push('kind must be photo, note or test_result');
  }
  if (kind === 'note') {
    const n = typeof note === 'string' ? note.trim() : '';
    if (!n) errors.push('note is required for kind=note');
  }
  if (kind === 'photo') {
    if (!photoId) errors.push('photoId is required for kind=photo');
    if (!photoUrl) errors.push('photoUrl is required for kind=photo');
  }
  // #517 — a test_result evidence row is the companion proof for a structured
  // TestRecord; it must carry the `testRecordId` that points back at the saved
  // numbers (the row is otherwise summary-only — no photo, no free note required).
  if (kind === 'test_result') {
    if (!testRecordId || typeof testRecordId !== 'string') {
      errors.push('testRecordId is required for kind=test_result');
    }
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
  if (isAdminRole(user.role)) return 'admin';
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
    isFieldRole(user.role)
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

  // Read the per-job document up front so a replay-safe (#497) check runs before
  // any side effect. A retry carrying the same idempotency key returns the
  // already-created evidence item — no second append, no duplicate audit/push.
  const KEY = dataKey(jobId);
  const data = await readBlob(KEY, emptyData());
  if (!Array.isArray(data.evidence)) data.evidence = [];

  const idemKey = idempotencyKeyFrom(req);
  const replay = idemKey ? findIdempotent(data, idemKey) : null;
  if (replay) {
    return res.status(201).json({ evidenceItem: replay, idempotentReplay: true });
  }

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
    // #517 — pointer back at the structured test record this proof summarises
    // (kind=test_result only; null for photo/note). The numbers live in
    // jobs/<jobId>/test-records.json, not duplicated here.
    testRecordId: typeof body.testRecordId === 'string' ? body.testRecordId : null,
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

  // Append under the CAS+verify retry: on a concurrent capture the fresh
  // document is re-read and THIS item re-applied until it is observably
  // present, so neither writer's row is lost. The replay check re-runs against
  // each fresh read — a retry that raced another instance carrying the same
  // idempotency key resolves to that original item.
  let casResult;
  try {
    casResult = await writeJobDataCas(KEY, {
      applied: (doc) => doc.evidence.some((ev) => ev && ev.id === item.id),
      apply: (doc) => {
        const freshReplay = idemKey ? findIdempotent(doc, idemKey) : null;
        if (freshReplay) return { ok: false, replay: freshReplay };
        doc.evidence.push(item);
        // Persist the idempotency key alongside the item in the same write, so
        // a later retry with this key resolves to this exact item (#497).
        recordIdempotent(doc, idemKey, item);
        return { ok: true };
      },
    });
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }
  if (!casResult.written && casResult.replay) {
    return res.status(201).json({ evidenceItem: casResult.replay, idempotentReplay: true });
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
  if (!isAdminRole(user.role)) {
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

  // Resolve the audit verb from the target transition. Un-review
  // (reviewed → submitted) gets its own verb so the History panel
  // shows it distinct from the original review.
  const isUnreview = current.status === 'reviewed' && targetStatus === 'submitted';
  const action = isUnreview
    ? 'evidence.unreviewed'
    : targetStatus === 'rejected'
      ? 'evidence.rejected'
      : 'evidence.reviewed';
  const summary = isUnreview
    ? body.reason
      ? `evidence un-reviewed — "${String(body.reason).slice(0, 80)}"`
      : 'evidence un-reviewed'
    : targetStatus === 'rejected'
      ? `evidence rejected — "${rejectionReason.slice(0, 80)}"`
      : 'evidence marked reviewed';
  const auditEntry = await appendAuditLog({
    action,
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'evidence',
    targetId: next.id,
    summary,
    metadata: {
      previousStatus: current.status,
      rejectionReason: next.rejectionReason,
      ...(isUnreview && body.reason ? { unreviewReason: String(body.reason).slice(0, 500) } : {}),
    },
  }).catch(() => null);
  if (auditEntry && auditEntry.id) {
    next.auditLogIds = [...(current.auditLogIds || []), auditEntry.id];
  }

  // Persist under the CAS+verify retry: a concurrent capture on this job must
  // not be clobbered by this review write (and vice versa). The item +
  // transition are re-resolved against each fresh read — if another actor
  // moved this item to a DIFFERENT state meanwhile, answer 409 rather than
  // blindly re-applying a stale decision; the same target state already
  // applied counts as done (idempotent-equivalent outcome).
  let casResult;
  try {
    casResult = await writeJobDataCas(KEY, {
      applied: (doc) => {
        const fresh = doc.evidence.find((ev) => ev && ev.id === evidenceId);
        return Boolean(fresh && fresh.status === targetStatus);
      },
      apply: (doc) => {
        const freshIdx = doc.evidence.findIndex((ev) => ev && ev.id === evidenceId);
        if (freshIdx === -1) return { ok: false, notFound: true };
        const fresh = doc.evidence[freshIdx];
        if (fresh.status !== current.status) return { ok: false, moved: fresh };
        doc.evidence[freshIdx] = { ...next, auditLogIds: next.auditLogIds || fresh.auditLogIds || [] };
        return { ok: true };
      },
    });
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }
  if (!casResult.written) {
    if (casResult.notFound) return res.status(404).json({ error: 'evidence not found on job' });
    return res.status(409).json({
      error: `evidence changed underneath this review (now ${casResult.moved.status}) — reload and re-decide`,
    });
  }

  appendLegacyAudit(jobId, {
    byUserId: user.id,
    byUsername: user.username || user.name || '',
    kind: action,
    summary: isUnreview
      ? `evidence ${next.id} un-reviewed`
      : targetStatus === 'rejected'
        ? `evidence ${next.id} rejected — "${rejectionReason.slice(0, 60)}"`
        : `evidence ${next.id} marked reviewed`,
    before: { status: current.status },
    after: { status: next.status, rejectionReason: next.rejectionReason },
  }).catch(() => {});

  return res.status(200).json({ evidenceItem: next });
}

// #263 — pair an AFTER photo with a BEFORE photo of the same spot.
// The link is stored ONLY on the AFTER row (pairedWithId=beforeId); the
// BEFORE row is NEVER mutated (byte-identical invariant — tested). Both
// ids must resolve on THIS job; photo-kind only; no self-link. Permission:
// the AFTER's capturing worker OR an admin (LH / others → 403). Idempotent.
function canPairEvidence(user, after) {
  if (isAdminRole(user.role)) return true;
  return !!after && after.capturedById === user.id;
}

async function linkEvidence(req, res, user, jobId) {
  const body = req.body || {};
  const afterId = typeof body.afterId === 'string' ? body.afterId : '';
  const beforeId = typeof body.beforeId === 'string' ? body.beforeId : '';
  if (!afterId) return res.status(400).json({ error: 'afterId required' });
  if (!beforeId) return res.status(400).json({ error: 'beforeId required' });
  if (afterId === beforeId) {
    return res.status(400).json({ error: 'cannot link a photo to itself' });
  }

  const KEY = dataKey(jobId);
  const data = await readBlob(KEY, emptyData());
  const arr = Array.isArray(data.evidence) ? data.evidence : [];

  // Mirror the .some() resolution in api/snags.js — both ids must resolve
  // on this job before any mutation.
  const afterIdx = arr.findIndex((ev) => ev && ev.id === afterId);
  if (afterIdx === -1) return res.status(404).json({ error: 'after evidence not found on job' });
  if (!arr.some((ev) => ev && ev.id === beforeId)) {
    return res.status(404).json({ error: 'before evidence not found on job' });
  }
  const after = arr[afterIdx];
  const before = arr.find((ev) => ev && ev.id === beforeId);

  // Photo-kind only — note pairing is rejected.
  if (after.kind !== 'photo' || before.kind !== 'photo') {
    return res.status(400).json({ error: 'only photos can be paired' });
  }

  // Permission: the AFTER's capturing worker OR an admin. LH / others → 403.
  if (!canPairEvidence(user, after)) {
    return res.status(403).json({ error: 'only the capturing worker or an admin can pair' });
  }

  // Idempotent: already linked to this before → 200 no-op (no write, no audit).
  if (after.pairedWithId === beforeId) {
    return res.status(200).json({ evidenceItem: after, idempotentNoop: true });
  }

  const nowIso = new Date().toISOString();
  // Mutate ONLY the after row. The before row stays byte-identical.
  const next = { ...after, pairedWithId: beforeId, updatedAt: nowIso };

  const auditEntry = await appendAuditLog({
    action: 'evidence.linked',
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'evidence',
    targetId: next.id,
    summary: 'linked before photo',
    metadata: { beforeId },
  }).catch(() => null);
  if (auditEntry && auditEntry.id) {
    next.auditLogIds = [...(after.auditLogIds || []), auditEntry.id];
  }

  arr[afterIdx] = next;
  data.evidence = arr;
  try {
    await writeBlob(KEY, data);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  appendLegacyAudit(jobId, {
    byUserId: user.id,
    byUsername: user.username || user.name || '',
    kind: 'evidence.linked',
    summary: `evidence ${next.id} linked before photo ${beforeId}`,
    after: { evidenceId: next.id, pairedWithId: beforeId },
  }).catch(() => {});

  return res.status(200).json({ evidenceItem: next });
}

async function unlinkEvidence(req, res, user, jobId) {
  const body = req.body || {};
  const afterId = typeof body.afterId === 'string' ? body.afterId : '';
  if (!afterId) return res.status(400).json({ error: 'afterId required' });

  const KEY = dataKey(jobId);
  const data = await readBlob(KEY, emptyData());
  const arr = Array.isArray(data.evidence) ? data.evidence : [];
  const afterIdx = arr.findIndex((ev) => ev && ev.id === afterId);
  if (afterIdx === -1) return res.status(404).json({ error: 'after evidence not found on job' });
  const after = arr[afterIdx];

  // Same permission gate as link.
  if (!canPairEvidence(user, after)) {
    return res.status(403).json({ error: 'only the capturing worker or an admin can unpair' });
  }

  // Idempotent: already unpaired → 200 no-op.
  if (after.pairedWithId == null) {
    return res.status(200).json({ evidenceItem: after, idempotentNoop: true });
  }

  const prevBeforeId = after.pairedWithId;
  const nowIso = new Date().toISOString();
  const next = { ...after, pairedWithId: null, updatedAt: nowIso };

  const auditEntry = await appendAuditLog({
    action: 'evidence.unlinked',
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'evidence',
    targetId: next.id,
    summary: 'unlinked before photo',
    metadata: { previousBeforeId: prevBeforeId },
  }).catch(() => null);
  if (auditEntry && auditEntry.id) {
    next.auditLogIds = [...(after.auditLogIds || []), auditEntry.id];
  }

  arr[afterIdx] = next;
  data.evidence = arr;
  try {
    await writeBlob(KEY, data);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  appendLegacyAudit(jobId, {
    byUserId: user.id,
    byUsername: user.username || user.name || '',
    kind: 'evidence.unlinked',
    summary: `evidence ${next.id} unlinked before photo`,
    before: { pairedWithId: prevBeforeId },
    after: { evidenceId: next.id, pairedWithId: null },
  }).catch(() => {});

  return res.status(200).json({ evidenceItem: next });
}

// #233 — flag / unflag a capture as part of the as-built handover record.
// Does NOT ride the strict review transition machine (there is no general
// evidence update path) — its own branch sets item.asBuilt + updatedAt and
// dual-writes a new audit verb, mirroring reviewEvidence.
//
// Permission asymmetry (locked in tests):
//   - FLAG  (asBuilt=true):  the capturer of THIS row (capturedById===me), OR
//     an admin / leading-hand-on-the-job (canManageJob) for ANY row.
//   - UNFLAG (asBuilt=false): the capturer for their OWN, OR an admin for ANY.
//     A leading hand cannot unflag someone else's (admin may).
// A client is 403'd at the dispatcher; unauth is 401'd by requireAuth.
function canFlagAsBuilt(user, item) {
  if (!item) return false;
  if (item.capturedById === user.id) return true;
  return canManageJob(user, jobIdOf(item));
}
function canUnflagAsBuilt(user, item) {
  if (!item) return false;
  if (item.capturedById === user.id) return true;
  return isAdminRole(user.role);
}
// The row carries its own jobId; the gate keys off it (canManageJob is
// job-scoped for LH). Falls back to '' which canManageJob treats as not-managed
// for a non-admin.
function jobIdOf(item) {
  return (item && item.jobId) || '';
}

async function flagAsBuiltEvidence(req, res, user, jobId) {
  const body = req.body || {};
  const evidenceId = typeof body.evidenceId === 'string' ? body.evidenceId : '';
  const asBuilt = body.asBuilt;
  if (!evidenceId) return res.status(400).json({ error: 'evidenceId required' });
  if (typeof asBuilt !== 'boolean') {
    return res.status(400).json({ error: 'asBuilt must be a boolean' });
  }

  const KEY = dataKey(jobId);
  const data = await readBlob(KEY, emptyData());
  const arr = Array.isArray(data.evidence) ? data.evidence : [];
  const idx = arr.findIndex((ev) => ev && ev.id === evidenceId);
  if (idx === -1) return res.status(404).json({ error: 'evidence not found on job' });
  const current = arr[idx];

  // Permission asymmetry — flag vs unflag differ.
  const allowed = asBuilt ? canFlagAsBuilt(user, current) : canUnflagAsBuilt(user, current);
  if (!allowed) {
    return res.status(403).json({
      error: asBuilt
        ? 'only the capturing worker, an admin, or a leading hand on the job can flag as-built'
        : 'only the capturing worker or an admin can clear the as-built flag',
    });
  }

  // Idempotent: no change → 200 no-op (no write, no audit). Treat a missing
  // flag as false so flagging an unmarked row is never a no-op.
  if ((current.asBuilt === true) === asBuilt) {
    return res.status(200).json({ evidenceItem: current, idempotentNoop: true });
  }

  const nowIso = new Date().toISOString();
  const next = { ...current, asBuilt, updatedAt: nowIso };

  const action = asBuilt ? 'evidence.flagged_asbuilt' : 'evidence.unflagged_asbuilt';
  const auditEntry = await appendAuditLog({
    action,
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'evidence',
    targetId: next.id,
    summary: asBuilt ? 'flagged evidence as-built' : 'cleared as-built flag',
    metadata: { asBuilt },
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
    summary: asBuilt
      ? `evidence ${next.id} flagged as-built`
      : `evidence ${next.id} as-built flag cleared`,
    before: { asBuilt: current.asBuilt === true },
    after: { evidenceId: next.id, asBuilt },
  }).catch(() => {});

  return res.status(200).json({ evidenceItem: next });
}

// ── #262: AI photo labels ─────────────────────────────────────────────────
//
//   POST /api/evidence?jobId=X&action=classify  body { evidenceIds: [..] }
//   POST /api/evidence?jobId=X&action=labels    body { evidenceId, add/accept/remove }
//
// Lazy classify-on-review (the tags.js on-demand OCR precedent): the office
// triggers classification from the queue — capture is never involved, an
// upload never waits on or fails because of a model. Idempotent per
// (photo, modelVersion) via run markers; a FAILED call writes no marker so
// the photo stays honestly unlabelled and re-attemptable. One data.json
// write per batch (never per-photo loop writes).

// Bare current alias per #378 (see scripts/check-model-ids.js); vision-capable.
const EVIDENCE_AI_MODEL = process.env.EVIDENCE_AI_MODEL || 'claude-sonnet-4-6';
const CLASSIFY_BATCH_MAX = 8;
const CLASSIFY_SYSTEM = [
  'You classify site photos for a small Australian electrical contractor.',
  'Label ONLY what is clearly visible. Use ONLY these labels:',
  PHOTO_LABEL_TAXONOMY.join(', ') + '.',
  'Reply with STRICT JSON only: {"labels":[{"label":"<one of the list>","confidence":<0..1>}]}.',
  'Use possible-defect only for visible damage, unsafe or non-compliant work.',
  'When you are not sure, OMIT the label. An unclear photo gets {"labels":[]}.',
  'Never invent labels outside the list.',
].join(' ');

async function classifyOnePhoto(item) {
  // Fetch the public blob image and send base64 (the api/tags.js OCR pattern).
  const r = await fetch(item.photoUrl);
  if (!r.ok) throw new Error('image fetch failed (' + r.status + ')');
  let mediaType = r.headers.get('content-type') || 'image/jpeg';
  if (!mediaType.startsWith('image/')) mediaType = 'image/jpeg';
  const ab = await r.arrayBuffer();
  const imageBase64 = Buffer.from(ab).toString('base64');

  const completion = await aiComplete({
    system: CLASSIFY_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: 'Classify this photo. Return only the JSON object.' },
        ],
      },
    ],
    model: EVIDENCE_AI_MODEL,
    maxTokens: 400,
  });
  const parsed = parseModelJson(completion.text);
  if (!parsed.ok) throw new Error(parsed.error);
  const rawLabels = Array.isArray(parsed.value && parsed.value.labels) ? parsed.value.labels : [];
  return { rawLabels, model: completion.model, usage: completion.usage };
}

async function classifyEvidence(req, res, user, jobId) {
  if (!isAdminRole(user.role)) {
    return res.status(403).json({ error: 'admin only' });
  }
  if (!isAiConfigured()) {
    return res.status(503).json({ error: 'AI is not configured', code: 'UNCONFIGURED' });
  }
  const body = req.body || {};
  const ids = Array.isArray(body.evidenceIds) ? body.evidenceIds.filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'evidenceIds required' });
  if (ids.length > CLASSIFY_BATCH_MAX) {
    return res.status(400).json({ error: `at most ${CLASSIFY_BATCH_MAX} photos per batch` });
  }

  const KEY = dataKey(jobId);
  const data = await readBlob(KEY, emptyData());
  const arr = Array.isArray(data.evidence) ? data.evidence : [];

  const results = [];
  const updated = [];
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  let anyChange = false;

  // Sequential on purpose — bounded spend, bounded blob-image fetches.
  for (const evidenceId of ids) {
    const idx = arr.findIndex((ev) => ev && ev.id === evidenceId);
    if (idx === -1) {
      results.push({ evidenceId, outcome: 'skipped', reason: 'not found on job' });
      continue;
    }
    const item = arr[idx];
    if (item.kind !== 'photo' || !item.photoUrl) {
      results.push({ evidenceId, outcome: 'skipped', reason: 'not a photo' });
      continue;
    }
    if (hasAiLabelRun(item, EVIDENCE_AI_MODEL)) {
      results.push({ evidenceId, outcome: 'skipped', reason: 'already classified' });
      continue;
    }
    try {
      const { rawLabels, usage } = await classifyOnePhoto(item);
      const merged = mergeAiLabels(item, rawLabels, {
        modelVersion: EVIDENCE_AI_MODEL,
        promptVersion: PHOTO_LABELS_PROMPT_VERSION,
      });
      const next = {
        ...item,
        labels: merged.labels,
        aiLabelRuns: merged.aiLabelRuns,
        updatedAt: new Date().toISOString(),
      };
      arr[idx] = next;
      updated.push(next);
      anyChange = true;
      if (usage) {
        totalUsage = {
          inputTokens: totalUsage.inputTokens + usage.inputTokens,
          outputTokens: totalUsage.outputTokens + usage.outputTokens,
        };
      }
      results.push({
        evidenceId,
        outcome: merged.added.length > 0 ? 'labelled' : 'no-labels',
        labelCount: merged.added.length,
      });
    } catch (e) {
      // No run marker on failure — the row stays unlabelled and re-attemptable.
      results.push({ evidenceId, outcome: 'failed', reason: e.message || 'classification failed' });
    }
  }

  if (anyChange) {
    data.evidence = arr;
    try {
      await writeBlob(KEY, data);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }

    await appendAuditLog({
      action: 'evidence.labels_suggested',
      actorId: user.id,
      actorName: user.name || user.username || 'Unknown',
      actorRole: user.role || null,
      jobId,
      targetType: 'job',
      targetId: jobId,
      summary: `AI suggested labels on ${updated.length} photo${updated.length === 1 ? '' : 's'}`,
      metadata: {
        model: EVIDENCE_AI_MODEL,
        promptVersion: PHOTO_LABELS_PROMPT_VERSION,
        evidenceIds: updated.map((ev) => ev.id),
        usage: totalUsage,
      },
    }).catch(() => null);

    appendLegacyAudit(jobId, {
      byUserId: user.id,
      byUsername: user.username || user.name || '',
      kind: 'evidence.labels_suggested',
      summary: `AI suggested labels on ${updated.length} photo(s)`,
      after: { evidenceIds: updated.map((ev) => ev.id) },
    }).catch(() => {});
  }

  return res.status(200).json({ results, evidence: updated });
}

async function correctLabels(req, res, user, jobId) {
  if (!isAdminRole(user.role)) {
    return res.status(403).json({ error: 'admin only' });
  }
  const body = req.body || {};
  const evidenceId = typeof body.evidenceId === 'string' ? body.evidenceId : '';
  if (!evidenceId) return res.status(400).json({ error: 'evidenceId required' });
  const toList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const correction = { add: toList(body.add), accept: toList(body.accept), remove: toList(body.remove) };

  const KEY = dataKey(jobId);
  const data = await readBlob(KEY, emptyData());
  const arr = Array.isArray(data.evidence) ? data.evidence : [];
  const idx = arr.findIndex((ev) => ev && ev.id === evidenceId);
  if (idx === -1) return res.status(404).json({ error: 'evidence not found on job' });
  const current = arr[idx];

  const applied = applyLabelCorrection(current, correction, user);
  if (!applied.ok) return res.status(400).json({ error: applied.error });

  const nowIso = new Date().toISOString();
  const next = { ...current, labels: applied.labels, updatedAt: nowIso };

  const auditEntry = await appendAuditLog({
    action: 'evidence.labels_corrected',
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'evidence',
    targetId: next.id,
    summary: 'corrected photo labels',
    metadata: {
      added: correction.add,
      accepted: correction.accept,
      removed: correction.remove,
    },
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
    kind: 'evidence.labels_corrected',
    summary: `evidence ${next.id} labels corrected`,
    before: { labels: (current.labels || []).length },
    after: { labels: (next.labels || []).length },
  }).catch(() => {});

  return res.status(200).json({ evidenceItem: next });
}

// ── #267: dismiss an AI defect→snag suggestion ────────────────────────────
//
//   POST /api/evidence?jobId=X&action=dismiss-defect-suggestion
//     body { evidenceId, label?, confidence?, modelVersion? }
//
// The suggestion itself is a pure projection (possible-defect label above the
// conservative floor — src/domains/evidence/defect-suggestions.ts); ACCEPT
// goes through the EXISTING snag creation path (POST /api/snags with
// evidenceIds) — this endpoint only records the sticky dismissal, with the
// confidence at dismissal time so precision is measurable. Idempotent.
async function dismissDefectSuggestion(req, res, user, jobId) {
  if (!isAdminRole(user.role)) {
    return res.status(403).json({ error: 'admin only' });
  }
  const body = req.body || {};
  const evidenceId = typeof body.evidenceId === 'string' ? body.evidenceId : '';
  if (!evidenceId) return res.status(400).json({ error: 'evidenceId required' });

  const KEY = dataKey(jobId);
  const data = await readBlob(KEY, emptyData());
  const arr = Array.isArray(data.evidence) ? data.evidence : [];
  const idx = arr.findIndex((ev) => ev && ev.id === evidenceId);
  if (idx === -1) return res.status(404).json({ error: 'evidence not found on job' });
  const current = arr[idx];

  // Idempotent: already dismissed → 200 no-op (no write, no audit).
  if (current.defectSuggestionDismissed) {
    return res.status(200).json({ evidenceItem: current, idempotentNoop: true });
  }

  // Record the suggestion's evidence trail as it stood at dismissal — read
  // from the row itself (server truth), never trusting client-sent numbers.
  const defectEntry = (Array.isArray(current.labels) ? current.labels : []).find(
    (l) => l && l.label === 'possible-defect' && l.status !== 'rejected'
  );
  const nowIso = new Date().toISOString();
  const dismissal = {
    at: nowIso,
    byId: user.id,
    byName: user.name || user.username || 'Unknown',
    label: 'possible-defect',
    confidence: defectEntry && typeof defectEntry.confidence === 'number' ? defectEntry.confidence : null,
    modelVersion: (defectEntry && defectEntry.modelVersion) || null,
  };
  const next = { ...current, defectSuggestionDismissed: dismissal, updatedAt: nowIso };

  const auditEntry = await appendAuditLog({
    action: 'evidence.defect_suggestion_dismissed',
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'evidence',
    targetId: next.id,
    summary: 'dismissed AI defect suggestion',
    metadata: { confidence: dismissal.confidence, modelVersion: dismissal.modelVersion },
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
    kind: 'evidence.defect_suggestion_dismissed',
    summary: `evidence ${next.id} defect suggestion dismissed`,
    after: { confidence: dismissal.confidence },
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
  if (isClientRole(user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  // #760: Evidence is a CORE kill-switch feature — 404 the whole endpoint when
  // the owner has turned it off. Default ON, so this is a no-op until then.
  if (!(await isFlagEnabled('evidence', user))) {
    return res.status(404).json({ error: 'not found' });
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

  // #262 — AI photo labels. BOTH actions are admin-tier + flag-gated
  // (ai_photo_labels, dark by default): the endpoint 404s exactly like an
  // unbuilt feature until the flag is on. Phil never calls these.
  if (req.method === 'POST' && (action === 'classify' || action === 'labels')) {
    if (!(await isFlagEnabled('ai_photo_labels', user))) {
      return res.status(404).json({ error: 'not found' });
    }
    try {
      return action === 'classify'
        ? await classifyEvidence(req, res, user, jobId)
        : await correctLabels(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || `${action} failed` });
    }
  }

  // #267 — dismiss an AI defect suggestion. Admin-tier + its own dark flag.
  if (req.method === 'POST' && action === 'dismiss-defect-suggestion') {
    if (!(await isFlagEnabled('ai_snag_suggestions', user))) {
      return res.status(404).json({ error: 'not found' });
    }
    try {
      return await dismissDefectSuggestion(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'dismiss failed' });
    }
  }

  // #233 — as-built designation. NO blanket canWrite gate here: an admin who
  // isn't assigned to the job must still be able to flag, and the capturer /
  // LH-on-job / unflag asymmetry is enforced per-row inside the handler.
  if (req.method === 'POST' && action === 'flag-asbuilt') {
    try {
      return await flagAsBuiltEvidence(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'flag-asbuilt failed' });
    }
  }

  // #263 — pair / unpair. The job-level write gate runs first (assigned
  // job only for field/LH); the per-row capturing-worker-or-admin gate is
  // then enforced inside the handler so an LH on the job still can't pair
  // someone else's capture.
  if (req.method === 'POST' && (action === 'link' || action === 'unlink')) {
    if (!canWrite(user, jobId)) {
      return res.status(403).json({ error: 'no write access to job' });
    }
    try {
      return action === 'link'
        ? await linkEvidence(req, res, user, jobId)
        : await unlinkEvidence(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || `${action} failed` });
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
