// Per-job services-locations register (#230).
//
//   GET    /api/services-locations?jobId=<id>            → list every record
//   POST   /api/services-locations?jobId=<id>            → add one record
//   PATCH  /api/services-locations?jobId=<id>&id=<rid>   → edit one record
//   DELETE /api/services-locations?jobId=<id>&id=<rid>   → remove one record
//
// A "service location" is where a key service is on site — the pit, the main
// switchboard, the meter, the temporary supply — so anyone on the job can find
// it. Description is MANDATORY; photos are OPTIONAL (text-only locations allowed).
//
// READ SCOPE — the load-bearing decision (#230).
//   GET has NO own-captures filter: every record goes to any reader on the job
//   (admin + assigned LH/field), mirroring api/contacts.js. The photos are served
//   from DENORMALISED URLs copied off the source evidence AT LINK TIME (see the
//   POST/PATCH path), NOT re-fetched from /api/evidence — whose GET filters to
//   capturedById === user.id, so a re-fetch would show worker B nothing. The
//   copied URL is a snapshot: a later evidence rejection does NOT retract it
//   (office QA is not a publish gate for "where's the board" — P7 honesty).
//
// Storage:  jobs/<jobId>/services-locations.json -> { locations: [...] }
//   A per-job sibling blob (matching contacts/tags/data conventions) — not
//   jobs.json — so the global registry stays small and an edit here never races a
//   jobs.json mutation. No manifest change (under the jobs/ backup prefix).
//
// Permissions:
//   - unauthenticated        → 401 JSON
//   - client role            → 403 JSON (always — never in the client portal)
//   - GET                    → any reader with job access (admin + assigned LH/field)
//   - POST  (canWrite)       → admin + assigned LH/field (field workers add)
//   - PATCH/DELETE (canManageJob) → admin + assigned LH (LH edit IS intended)
//
// Caps (server-enforced, clear 400s):
//   ≤ 30 locations/job, ≤ 5 photos/location, label ≤ 120, description ≤ 1000.
//
// Audit — append one row per mutation to the canonical journal
// (service_location.added / updated / removed), best-effort (never blocks the
// write). targetType 'service_location'.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const {
  requireAuth,
  canWrite,
  canManageJob,
  isClientRole,
} = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { writeGuardErrorResponse } = require('./_lib/blob-guards');

const TYPES = new Set(['pit', 'switchboard', 'meter', 'tempSupply', 'other']);
const LABEL_MAX = 120;
const DESCRIPTION_MAX = 1000;
const MAX_PER_JOB = 30;
const PHOTO_MAX = 5;

function key(jobId) {
  return `jobs/${jobId}/services-locations.json`;
}
function dataKey(jobId) {
  return `jobs/${jobId}/data.json`;
}
function emptyStore() {
  return { locations: [] };
}

// Validate + normalise a create/update body. Mirrors
// src/domains/services-locations/service.ts#validateInput so client and server
// reject the same shapes with the same messages. `requireDescription` is true on
// create, false on update (a PATCH may omit description to leave it unchanged).
function validateBody(body, { requireDescription }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be an object' };
  }
  if (!TYPES.has(body.type)) {
    return { error: 'type must be one of pit, switchboard, meter, tempSupply, other' };
  }
  const type = body.type;

  let label = null;
  if (body.label !== undefined && body.label !== null) {
    const t = String(body.label).trim();
    if (t.length > LABEL_MAX) return { error: `label must be ${LABEL_MAX} characters or fewer` };
    label = t || null;
  }

  let description = '';
  const hasDescription = body.description !== undefined && body.description !== null;
  if (hasDescription) {
    description = String(body.description).trim();
    if (description.length > DESCRIPTION_MAX) {
      return { error: `description must be ${DESCRIPTION_MAX} characters or fewer` };
    }
  }
  if (requireDescription || hasDescription) {
    if (!description) return { error: 'description is required' };
  }

  let evidenceIds = [];
  if (body.evidenceIds !== undefined && body.evidenceIds !== null) {
    if (!Array.isArray(body.evidenceIds)) return { error: 'evidenceIds must be an array' };
    evidenceIds = Array.from(new Set(body.evidenceIds.map((id) => String(id))));
    if (evidenceIds.length > PHOTO_MAX) {
      return { error: `evidenceIds may not exceed ${PHOTO_MAX} photos` };
    }
  }

  return { value: { type, label, description, hasDescription, evidenceIds } };
}

// Copy the display fields off a resolved evidence row into a denormalised photo
// (the load-bearing step — see the file header). Returns null for a note-only
// row (nothing to show). Mirrors service.ts#denormalisePhoto.
function denormalisePhoto(ev) {
  const photoUrl = String((ev && ev.photoUrl) || '').trim();
  if (!photoUrl) return null;
  return {
    evidenceId: ev.id,
    photoUrl,
    thumbnailUrl: ev.thumbnailUrl != null ? ev.thumbnailUrl : null,
    photoId: ev.photoId != null ? ev.photoId : null,
    capturedByName: ev.capturedByName != null ? ev.capturedByName : null,
  };
}

// Resolve the posted evidenceIds against THIS job's data.json evidence[] and
// build the denormalised photos[]. Copies the .some() resolution from
// api/snags.js — each id must exist on this job. Returns { photos } or { error }.
async function resolvePhotos(jobId, evidenceIds) {
  if (!evidenceIds.length) return { photos: [] };
  const data = await readBlob(dataKey(jobId), { evidence: [] });
  const evidenceArr = Array.isArray(data && data.evidence) ? data.evidence : [];
  const photos = [];
  for (const id of evidenceIds) {
    const ev = evidenceArr.find((e) => e && e.id === id);
    if (!ev) return { error: `evidenceId not found on this job: ${id}` };
    const photo = denormalisePhoto(ev);
    // A note-only evidence row carries no image — skip it rather than persist a
    // photo with no URL (the worker can still add a text-only location).
    if (photo) photos.push(photo);
  }
  return { photos };
}

async function auditMutation(user, jobId, action, record) {
  await appendAuditLog({
    action,
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'service_location',
    targetId: record.id,
    summary: `${action === 'service_location.removed' ? 'removed' : 'saved'} ${record.type} location "${String(record.label || record.type).slice(0, 80)}"`,
    metadata: { type: record.type, photoCount: (record.photos || []).length },
  }).catch(() => {});
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  // Server-side gate. The job-access check in requireAuth admits admin (any job)
  // + field/LH assigned to this job; clients are 403'd below (never in the
  // client portal — these are internal site notes).
  const user = await requireAuth(req, res, { jobId });
  if (!user) return;
  if (isClientRole(user.role)) return res.status(403).json({ error: 'forbidden' });

  const KEY = key(jobId);

  // ── GET — every record to any reader on the job (no own-captures filter) ──
  if (req.method === 'GET') {
    try {
      const store = await readBlob(KEY, emptyStore());
      const locations = Array.isArray(store && store.locations) ? store.locations : [];
      return res.status(200).json({ locations });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'list failed' });
    }
  }

  // ── POST — add a record (admin + assigned LH/field) ──────────────────────
  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const built = validateBody(req.body || {}, { requireDescription: true });
    if (built.error) return res.status(400).json({ error: built.error });

    const resolved = await resolvePhotos(jobId, built.value.evidenceIds);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    try {
      const store = await readBlob(KEY, emptyStore());
      store.locations = Array.isArray(store.locations) ? store.locations : [];
      if (store.locations.length >= MAX_PER_JOB) {
        return res.status(400).json({ error: `a job may not exceed ${MAX_PER_JOB} service locations` });
      }
      const now = new Date().toISOString();
      const actorName = user.name || user.username || 'Unknown';
      const record = {
        id: nanoid('sl_'),
        type: built.value.type,
        label: built.value.label,
        description: built.value.description,
        photos: resolved.photos,
        createdBy: actorName,
        createdById: user.id,
        createdAt: now,
        updatedBy: actorName,
        updatedById: user.id,
        updatedAt: now,
      };
      store.locations.push(record);
      await writeBlob(KEY, store, { actor: user });
      await auditMutation(user, jobId, 'service_location.added', record);
      return res.status(201).json({ location: record });
    } catch (e) {
      const mapped = writeGuardErrorResponse(e);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
  }

  // ── PATCH — edit a record (admin + assigned LH; LH edit IS intended) ─────
  if (req.method === 'PATCH') {
    if (!canManageJob(user, jobId)) {
      return res.status(403).json({ error: 'only admins or the leading hand can edit a service location' });
    }
    const id = (req.body && req.body.id) || (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const built = validateBody(req.body || {}, { requireDescription: false });
    if (built.error) return res.status(400).json({ error: built.error });

    // evidenceIds, when present, REPLACES the photo set (re-resolve + re-copy).
    const hasEvidence = req.body && req.body.evidenceIds !== undefined && req.body.evidenceIds !== null;
    let resolvedPhotos = null;
    if (hasEvidence) {
      const resolved = await resolvePhotos(jobId, built.value.evidenceIds);
      if (resolved.error) return res.status(400).json({ error: resolved.error });
      resolvedPhotos = resolved.photos;
    }

    try {
      const store = await readBlob(KEY, emptyStore());
      const arr = Array.isArray(store.locations) ? store.locations : [];
      const idx = arr.findIndex((r) => r && r.id === id);
      if (idx < 0) return res.status(404).json({ error: 'service location not found' });
      const existing = arr[idx];
      const now = new Date().toISOString();
      const next = {
        ...existing,
        type: built.value.type,
        // label: present-in-body overrides; an explicit null clears it.
        label:
          req.body.label !== undefined ? built.value.label : (existing.label ?? null),
        // description: only overwrite when the body carried one.
        description: built.value.hasDescription ? built.value.description : existing.description,
        photos: resolvedPhotos !== null ? resolvedPhotos : (existing.photos || []),
        updatedBy: user.name || user.username || 'Unknown',
        updatedById: user.id,
        updatedAt: now,
      };
      arr[idx] = next;
      store.locations = arr;
      await writeBlob(KEY, store, { actor: user });
      await auditMutation(user, jobId, 'service_location.updated', next);
      return res.status(200).json({ location: next });
    } catch (e) {
      const mapped = writeGuardErrorResponse(e);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
  }

  // ── DELETE — remove a record (admin + assigned LH) ───────────────────────
  if (req.method === 'DELETE') {
    if (!canManageJob(user, jobId)) {
      return res.status(403).json({ error: 'only admins or the leading hand can remove a service location' });
    }
    const id = (req.query && req.query.id) || (req.body && req.body.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const store = await readBlob(KEY, emptyStore());
      const arr = Array.isArray(store.locations) ? store.locations : [];
      const target = arr.find((r) => r && r.id === id);
      if (!target) return res.status(404).json({ error: 'service location not found' });
      store.locations = arr.filter((r) => r.id !== id);
      await writeBlob(KEY, store, { actor: user });
      await auditMutation(user, jobId, 'service_location.removed', target);
      return res.status(200).json({ ok: true });
    } catch (e) {
      const mapped = writeGuardErrorResponse(e);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};
