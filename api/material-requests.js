// Material Requests domain endpoint — PR 11.
//
//   GET   /api/material-requests                     → cross-job inbox (admin)
//   GET   /api/material-requests?jobId=<id>          → one job's requests
//   POST  /api/material-requests?jobId=<id>          → create (admin)
//   PATCH /api/material-requests   (id in body)      → triage / update (admin)
//
// A Material Request is the field-to-office procurement loop's tracked
// record. Mirrors the observations.js architecture (top-level blob,
// admin-tier cross-job + per-job, audit dual-emit, denormalised area/task
// names). Created either directly by an admin (above) OR via the
// observation -> material request conversion in api/observations.js
// (?action=convert-to-material-request, PR 11).
//
// Storage: `material-requests.json` (NEW top-level blob — same pattern as
// observations.json + employees.json). Whole-doc rewrite race bounded at
// SME-procurement volume; per-record split is Phase F+.
//
// Relationship to the legacy /admin/materials surface (takeoff + PO +
// invoice match): they don't overlap. The legacy module owns structured
// takeoff procurement; this module owns the field-to-office REQUEST loop.
// See docs/architecture/material-requests.md.
//
// Permissions:
//   - unauthenticated                    → 401
//   - client role                        → 403
//   - cross-job GET + PATCH              → admin-tier
//   - job-scoped GET (?jobId)            → field/LH on assigned job + admin
//   - POST (direct create)               → admin-tier
//   - convert-from-observation entry pt  → admin-tier (in api/observations.js)
//
// Mirrors src/domains/material-requests/{schema,service}.ts. Status state
// machine is duplicated here (plain JS); parity is covered by the domain
// test.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite, isAdminRole } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { append: appendAuditLog } = require('./_lib/audit-log');

const STORE_KEY = 'material-requests.json';

const VALID_STATUSES = new Set([
  'requested',
  'approved',
  'ordered',
  'delivered',
  'cancelled',
]);
const VALID_URGENCIES = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_STAGES = new Set(['roughIn', 'fitOff']);

const ITEM_MAX = 200;
const DESCRIPTION_MAX = 2000;
const NOTE_MAX = 1000;
const SUPPLIER_MAX = 120;
const ORDER_REF_MAX = 60;
const UNIT_MAX = 24;
const QUANTITY_MAX = 10_000_000;

// State machine — mirrored from src/domains/material-requests/service.ts.
const ALLOWED_TRANSITIONS = new Set([
  'null→requested',
  'requested→approved',
  'requested→ordered',
  'requested→cancelled',
  'approved→ordered',
  'approved→cancelled',
  'approved→requested',
  'ordered→delivered',
  'ordered→cancelled',
  'delivered→ordered',
]);
function canTransition(from, to) {
  return ALLOWED_TRANSITIONS.has(`${from == null ? 'null' : from}→${to}`);
}

function emptyStore() {
  return { requests: [] };
}
function readStore() {
  return readBlob(STORE_KEY, emptyStore());
}

function findArea(job, areaId) {
  for (const g of (job && job.areaGroups) || []) {
    for (const a of (g && g.areas) || []) {
      if (a && a.id === areaId) return a;
    }
  }
  return null;
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

function validateCreateBody(body, job) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['body must be an object'] };
  }

  const item = typeof body.item === 'string' ? body.item.trim() : '';
  if (!item) errors.push('item is required');
  if (item.length > ITEM_MAX) errors.push(`item must be ${ITEM_MAX} characters or fewer`);

  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    errors.push('quantity must be > 0');
  } else if (quantity > QUANTITY_MAX) {
    errors.push(`quantity must be ≤ ${QUANTITY_MAX}`);
  }

  const unit = typeof body.unit === 'string' ? body.unit.trim() : '';
  if (!unit) errors.push('unit is required');
  if (unit.length > UNIT_MAX) errors.push(`unit must be ${UNIT_MAX} characters or fewer`);

  const description = typeof body.description === 'string' ? body.description : '';
  if (description.length > DESCRIPTION_MAX) {
    errors.push(`description must be ${DESCRIPTION_MAX} characters or fewer`);
  }

  const urgency = body.urgency == null ? 'normal' : String(body.urgency);
  if (!VALID_URGENCIES.has(urgency)) {
    errors.push('urgency must be low, normal, high or urgent');
  }

  const stage = body.stage == null ? null : String(body.stage);
  if (stage && !VALID_STAGES.has(stage)) errors.push('stage must be roughIn or fitOff');
  if (body.taskId && !stage) errors.push('stage is required when taskId is provided');

  let area = null;
  if (body.areaId) {
    area = findArea(job, body.areaId);
    if (!area) errors.push('areaId not found on job');
  }
  if (body.taskId && stage && area) {
    const tasks = effectiveTasks(job, area, stage);
    if (!tasks.some((t) => t && t.id === body.taskId)) {
      errors.push('taskId not found for stage on this job/area');
    }
  }

  return { errors, item, quantity, unit, description, urgency, stage, area };
}

function applyFilters(list, q) {
  let out = list;
  if (q.jobId) out = out.filter((r) => r.jobId === q.jobId);
  if (q.status && VALID_STATUSES.has(String(q.status))) {
    out = out.filter((r) => r.status === q.status);
  }
  if (q.urgency && VALID_URGENCIES.has(String(q.urgency))) {
    out = out.filter((r) => r.urgency === q.urgency);
  }
  return out;
}

async function listInbox(req, res) {
  const store = await readStore();
  const all = Array.isArray(store.requests) ? store.requests : [];
  const filtered = applyFilters(all.slice(), req.query || {});
  filtered.sort((a, b) =>
    String(b.requestedAt || '').localeCompare(String(a.requestedAt || ''))
  );
  return res.status(200).json({ requests: filtered });
}

async function listJobRequests(req, res, jobId) {
  const store = await readStore();
  const all = Array.isArray(store.requests) ? store.requests : [];
  const forJob = all.filter((r) => r && r.jobId === jobId);
  forJob.sort((a, b) =>
    String(b.requestedAt || '').localeCompare(String(a.requestedAt || ''))
  );
  return res.status(200).json({ requests: forJob });
}

/**
 * Build a MaterialRequest item from fields. Pure (no I/O). Used by the
 * direct POST handler AND by the observation -> material-request conversion
 * in api/observations.js (`buildItem` is exported below for that path).
 */
function buildItem({
  jobId,
  jobName,
  item,
  quantity,
  unit,
  description,
  urgency,
  stage,
  areaId,
  areaName,
  taskId,
  taskName,
  linkedObservationId,
  linkedEvidenceId,
  source,
  actor,
}) {
  const nowIso = new Date().toISOString();
  return {
    id: nanoid('mr_'),
    jobId,
    jobName: jobName ?? null,
    item,
    quantity,
    unit,
    description: description ? description : null,
    status: 'requested',
    urgency,
    source,
    stage: stage || null,
    areaId: areaId || null,
    areaName: areaName ?? null,
    taskId: taskId || null,
    taskName: taskName ?? null,
    linkedObservationId: linkedObservationId || null,
    linkedEvidenceId: linkedEvidenceId || null,
    requestedById: actor.id,
    requestedByName: actor.name || actor.username || 'Unknown',
    requestedByRole: actor.role || null,
    requestedAt: nowIso,
    approvedById: null, approvedByName: null, approvedAt: null,
    orderedById: null, orderedByName: null, orderedAt: null,
    supplier: null, supplierNote: null, orderRef: null,
    deliveredById: null, deliveredByName: null, deliveredAt: null,
    deliveryNote: null,
    cancelledById: null, cancelledByName: null, cancelledAt: null,
    cancelReason: null,
    auditLogIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** Persist a material request: read+append+write material-requests.json. */
async function persistItem(item) {
  const store = await readStore();
  if (!Array.isArray(store.requests)) store.requests = [];
  store.requests.push(item);
  await writeBlob(STORE_KEY, store);
}

async function createDirect(req, res, user, jobId) {
  const job = await loadJobOrFail(res, jobId);
  if (!job) return;

  const v = validateCreateBody(req.body || {}, job);
  if (v.errors && v.errors.length) {
    return res.status(400).json({ error: v.errors[0], errors: v.errors });
  }

  const body = req.body || {};
  let areaName = null;
  let taskName = null;
  if (v.area) {
    areaName = v.area.name || null;
    if (body.taskId && v.stage) {
      const t = effectiveTasks(job, v.area, v.stage).find((x) => x && x.id === body.taskId);
      taskName = t ? t.name || null : null;
    }
  }

  const item = buildItem({
    jobId,
    jobName: job.name || null,
    item: v.item,
    quantity: v.quantity,
    unit: v.unit,
    description: v.description,
    urgency: v.urgency,
    stage: v.stage,
    areaId: body.areaId,
    areaName,
    taskId: body.taskId,
    taskName,
    linkedObservationId: body.linkedObservationId ? String(body.linkedObservationId) : null,
    linkedEvidenceId: body.linkedEvidenceId ? String(body.linkedEvidenceId) : null,
    source: 'buhlos',
    actor: user,
  });

  // Audit BEFORE write so we capture the intent even on a flaky writeBlob;
  // catch + null so a log failure never blocks the request write.
  const audit = await appendAuditLog({
    action: 'material_request.created',
    actorId: user.id,
    actorName: user.name || user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'material_request',
    targetId: item.id,
    summary: `material request raised — ${item.quantity} ${item.unit} ${String(item.item).slice(0, 60)}`,
    metadata: {
      item: item.item,
      quantity: item.quantity,
      unit: item.unit,
      urgency: item.urgency,
      areaId: item.areaId,
      stage: item.stage,
      taskId: item.taskId,
      linkedObservationId: item.linkedObservationId,
      source: item.source,
    },
  }).catch(() => null);
  if (audit && audit.id) item.auditLogIds.push(audit.id);

  try {
    await persistItem(item);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }
  return res.status(201).json({ request: item });
}

async function updateItem(req, res, user) {
  const body = req.body || {};
  const id = body.id ? String(body.id) : '';
  if (!id) return res.status(400).json({ error: 'id required' });

  const store = await readStore();
  const arr = Array.isArray(store.requests) ? store.requests : [];
  const idx = arr.findIndex((r) => r && r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'material request not found' });

  const current = arr[idx];
  const nowIso = new Date().toISOString();
  const actorName = user.name || user.username || 'Unknown';
  const next = { ...current, updatedAt: nowIso };

  // ── status ──
  if (body.status !== undefined) {
    if (!VALID_STATUSES.has(String(body.status))) {
      return res.status(400).json({ error: 'invalid status' });
    }
    if (!canTransition(current.status, body.status)) {
      return res.status(409).json({
        error: `invalid transition: ${current.status} → ${body.status}`,
      });
    }
    if (body.status === 'cancelled') {
      const reason = typeof body.cancelReason === 'string' ? body.cancelReason.trim() : '';
      if (!reason) {
        return res.status(400).json({ error: 'cancelReason required when status=cancelled' });
      }
      if (reason.length > NOTE_MAX) {
        return res.status(400).json({ error: `cancelReason must be ${NOTE_MAX} characters or fewer` });
      }
      next.cancelReason = reason;
      next.cancelledAt = nowIso;
      next.cancelledById = user.id;
      next.cancelledByName = actorName;
    }
    next.status = body.status;
    if (body.status === 'approved') {
      next.approvedAt = nowIso;
      next.approvedById = user.id;
      next.approvedByName = actorName;
    }
    if (body.status === 'ordered') {
      next.orderedAt = nowIso;
      next.orderedById = user.id;
      next.orderedByName = actorName;
    }
    if (body.status === 'delivered') {
      next.deliveredAt = nowIso;
      next.deliveredById = user.id;
      next.deliveredByName = actorName;
    }
  }

  // ── urgency ──
  if (body.urgency !== undefined) {
    if (!VALID_URGENCIES.has(String(body.urgency))) {
      return res.status(400).json({ error: 'invalid urgency' });
    }
    next.urgency = body.urgency;
  }

  // ── supplier / orderRef / notes ── (free-text edits)
  if (body.supplier !== undefined) {
    const s = body.supplier == null ? null : String(body.supplier);
    if (s && s.length > SUPPLIER_MAX) {
      return res.status(400).json({ error: `supplier must be ${SUPPLIER_MAX} characters or fewer` });
    }
    next.supplier = s;
  }
  if (body.supplierNote !== undefined) {
    const s = body.supplierNote == null ? null : String(body.supplierNote);
    if (s && s.length > NOTE_MAX) {
      return res.status(400).json({ error: `supplierNote must be ${NOTE_MAX} characters or fewer` });
    }
    next.supplierNote = s;
  }
  if (body.orderRef !== undefined) {
    const s = body.orderRef == null ? null : String(body.orderRef);
    if (s && s.length > ORDER_REF_MAX) {
      return res.status(400).json({ error: `orderRef must be ${ORDER_REF_MAX} characters or fewer` });
    }
    next.orderRef = s;
  }
  if (body.deliveryNote !== undefined) {
    const s = body.deliveryNote == null ? null : String(body.deliveryNote);
    if (s && s.length > NOTE_MAX) {
      return res.status(400).json({ error: `deliveryNote must be ${NOTE_MAX} characters or fewer` });
    }
    next.deliveryNote = s;
  }

  // ── persist ──
  arr[idx] = next;
  store.requests = arr;
  try {
    await writeBlob(STORE_KEY, store);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  // ── audit (best-effort) ── Only emit a transitioned row when a
  // user-meaningful field changed: status, urgency, supplier, orderRef.
  // Free-text supplierNote/deliveryNote edits don't get their own row;
  // they piggy-back as metadata on the next status flip.
  const changedFields = [];
  if (next.status !== current.status) changedFields.push('status');
  if (next.urgency !== current.urgency) changedFields.push('urgency');
  if (next.supplier !== current.supplier) changedFields.push('supplier');
  if (next.orderRef !== current.orderRef) changedFields.push('orderRef');
  if (changedFields.length > 0) {
    const parts = [];
    if (changedFields.includes('status')) parts.push(`status ${current.status} → ${next.status}`);
    if (changedFields.includes('urgency')) parts.push(`urgency ${current.urgency} → ${next.urgency}`);
    if (changedFields.includes('supplier') && next.supplier) parts.push(`supplier ${next.supplier}`);
    if (changedFields.includes('orderRef') && next.orderRef) parts.push(`PO ${next.orderRef}`);
    await appendAuditLog({
      action: 'material_request.transitioned',
      actorId: user.id,
      actorName: actorName,
      actorRole: user.role || null,
      jobId: current.jobId,
      targetType: 'material_request',
      targetId: current.id,
      summary: `material request: ${parts.join('; ')}`,
      metadata: {
        changedFields,
        from: {
          status: current.status,
          urgency: current.urgency,
          supplier: current.supplier,
          orderRef: current.orderRef,
        },
        to: {
          status: next.status,
          urgency: next.urgency,
          supplier: next.supplier,
          orderRef: next.orderRef,
        },
        ...(changedFields.includes('status') && next.status === 'cancelled'
          ? { cancelReason: next.cancelReason }
          : {}),
        ...(changedFields.includes('status') && next.status === 'delivered' && next.deliveryNote
          ? { deliveryNote: next.deliveryNote }
          : {}),
      },
    }).catch(() => null);
  }

  return res.status(200).json({ request: next });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';

  // --- POST create: admin only, job-scoped ---------------------------------
  if (req.method === 'POST') {
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const user = await requireAuth(req, res, { roles: ['admin'] });
    if (!user) return;
    try {
      return await createDirect(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'create failed' });
    }
  }

  // --- PATCH update: admin only -------------------------------------------
  if (req.method === 'PATCH') {
    const user = await requireAuth(req, res, { roles: ['admin'] });
    if (!user) return;
    try {
      return await updateItem(req, res, user);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'update failed' });
    }
  }

  // --- GET -----------------------------------------------------------------
  if (req.method === 'GET') {
    if (jobId) {
      const user = await requireAuth(req, res, { jobId });
      if (!user) return;
      if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });
      try {
        return await listJobRequests(req, res, jobId);
      } catch (e) {
        return res.status(500).json({ error: e.message || 'list failed' });
      }
    }
    // Cross-job inbox: admin-tier only (matches the BuhlOS surface gate).
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

// Exposed for api/observations.js#convertObservationToMaterialRequest so the
// conversion path uses the same item shape + persistence helper as the
// direct create. Not on the HTTP surface; required internally.
module.exports.buildItem = buildItem;
module.exports.persistItem = persistItem;
