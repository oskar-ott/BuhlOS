// Daywork register endpoint — #370.
//
//   GET   /api/dayworks?jobId=<id>   → one job's dockets + summary
//                                       (admin-tier OR field/LH on an assigned job)
//   GET   /api/dayworks              → cross-job rollup (admin-tier only)
//   POST  /api/dayworks?jobId=<id>   → create a docket
//                                       (admin-tier OR field/LH on an assigned job)
//   PATCH /api/dayworks  (body: { id, jobId, action })
//         action='sign'    → unsigned → signed (typed supervisor name; assigned
//                            field/LH OR admin — the supervisor signs on the
//                            worker's phone)
//         action='invoice' → signed → invoiced (manual invoiceRef; admin-tier —
//                            commercial)
//         action='amend'   → on a signed/invoiced docket, mint a NEW unsigned
//                            amendment back-linked to the immutable original
//                            (assigned field/LH OR admin)
//
// Daywork is the most perishable money in construction: 100 Arthur St's terms
// require day-labour sheets signed DAILY by the builder's supervisor — unsigned
// dockets age into disputed invoices. This is the server-backed register the
// field captures into and the office watches for payment risk.
//
// Storage — PER-JOB at `jobs/<jobId>/dayworks.json`: { dockets: [Daywork, ...] }.
// Per-job (not a top-level blob) because dockets belong to a job and the
// cross-job rollup scans job blobs (the hours/variations pattern).
//
// Hard rules (mirrored from src/domains/dayworks/service.ts — the pure logic is
// duplicated here in plain JS to avoid a TS build dependency; parity is covered
// by src/domains/dayworks/dayworks.test.ts):
//   - Unsigned saves freely — a docket without a signature is `unsigned`, never
//     blocked, never faked. No signature image is ever synthesised.
//   - Sequential refs are gap-safe — max(seq)+1, never array length.
//   - Forward-only pipeline — unsigned → signed → invoiced. No un-signing.
//   - Signed/invoiced is IMMUTABLE — changes go through a linked amendment; the
//     original is never mutated (only flagged `amended`).
//   - COMMERCIAL, not payroll — nothing here writes to time-entries;
//     `linkedTimeEntryIds` is a one-way cross-reference.
//
// Deferred (per the issue): the on-glass DRAWN signature (build once, with
// #328/#295 — a typed supervisor name signs today) and the Phil docket-create UI
// (lands with the #132 job-screen review wave). The API already accepts
// field-tier creates/signs on assigned jobs so the Phil entry is a front-end
// follow-on.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isClientRole } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { append: appendAuditLog } = require('./_lib/audit-log');

// ── Limits (mirror src/domains/dayworks/schema.ts DAYWORK_LIMITS) ────────────
const LIMITS = {
  maxDescription: 2000,
  maxLabourLines: 50,
  maxMaterialLines: 100,
  maxPhotos: 10,
  maxSupervisorName: 140,
  maxUnit: 24,
  maxNote: 2000,
  maxInvoiceRef: 200,
};
const MAX_LINK_IDS = 50;
const UNSIGNED_AGING_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

// ── Pure logic mirror (src/domains/dayworks/service.ts) ──────────────────────
const VALID_STATUSES = new Set(['unsigned', 'signed', 'invoiced']);
const ALLOWED_TRANSITIONS = new Set(['unsigned→signed', 'signed→invoiced']);
function canTransition(from, to) {
  return ALLOWED_TRANSITIONS.has(`${from}→${to}`);
}
function isImmutable(status) {
  return status === 'signed' || status === 'invoiced';
}
function nextDayworkSeq(dockets) {
  let max = 0;
  for (const d of dockets || []) {
    const n = Number(d && d.seq);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}
function formatDayworkRef(seq) {
  return 'DW-' + String(seq).padStart(3, '0');
}
function isUnsignedAging(d, nowMs) {
  if (!d || d.status !== 'unsigned') return false;
  const created = Date.parse(d.createdAt);
  if (Number.isNaN(created)) return false;
  return nowMs - created > UNSIGNED_AGING_THRESHOLD_MS;
}
const STATUS_RANK = { unsigned: 1, signed: 2, invoiced: 3 };
// Exception-first ordering: unsigned-aging at the top, then unsigned, signed,
// invoiced; within a bucket newest first.
function compareForRegister(a, b, nowMs) {
  const agingA = isUnsignedAging(a, nowMs) ? 0 : 1;
  const agingB = isUnsignedAging(b, nowMs) ? 0 : 1;
  if (agingA !== agingB) return agingA - agingB;
  const ra = STATUS_RANK[a.status] || 9;
  const rb = STATUS_RANK[b.status] || 9;
  if (ra !== rb) return ra - rb;
  return (b.seq || 0) - (a.seq || 0);
}
function summariseRegister(dockets, nowMs) {
  const s = { total: dockets.length, unsigned: 0, signed: 0, invoiced: 0, unsignedAging: 0 };
  for (const d of dockets) {
    if (s[d.status] !== undefined) s[d.status] += 1;
    if (isUnsignedAging(d, nowMs)) s.unsignedAging += 1;
  }
  return s;
}

// ── Storage ──────────────────────────────────────────────────────────────────
function storeKey(jobId) {
  return `jobs/${jobId}/dayworks.json`;
}
function emptyStore() {
  return { dockets: [] };
}
async function readStore(jobId) {
  const store = await readBlob(storeKey(jobId), emptyStore());
  if (!store || !Array.isArray(store.dockets)) return emptyStore();
  return store;
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

function actorNameOf(user) {
  return user.name || user.username || 'Unknown';
}

// ── Create validation (mirror CreateDaywork* schemas) ────────────────────────
function validateCreateBody(body, user, actorName) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['body must be an object'] };
  }

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) errors.push('description is required');
  if (description.length > LIMITS.maxDescription) {
    errors.push(`description must be ${LIMITS.maxDescription} characters or fewer`);
  }

  // date — defaults to today; if supplied it must be a parseable ISO date.
  let date;
  if (body.date == null) {
    date = new Date().toISOString();
  } else {
    date = String(body.date);
    if (Number.isNaN(Date.parse(date))) errors.push('date must be an ISO date');
  }

  // labourLines — defaults to a single self line (worker + hours, "defaulting to
  // self"). Each line: workerName required, hours a number 0–24.
  let labourLines = [];
  if (body.labourLines == null) {
    labourLines = [{ id: nanoid('dwl_'), workerId: user.id, workerName: actorName, hours: 0, note: null }];
  } else if (!Array.isArray(body.labourLines)) {
    errors.push('labourLines must be an array');
  } else if (body.labourLines.length > LIMITS.maxLabourLines) {
    errors.push(`labourLines must be ${LIMITS.maxLabourLines} or fewer`);
  } else {
    body.labourLines.forEach((l, i) => {
      if (!l || typeof l !== 'object') {
        errors.push(`labourLines[${i}] must be an object`);
        return;
      }
      const workerName = typeof l.workerName === 'string' ? l.workerName.trim() : '';
      if (!workerName) errors.push(`labourLines[${i}].workerName is required`);
      const hours = l.hours;
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > 24) {
        errors.push(`labourLines[${i}].hours must be a number between 0 and 24`);
      }
      labourLines.push({
        id: nanoid('dwl_'),
        workerId: l.workerId != null ? String(l.workerId) : null,
        workerName,
        hours: typeof hours === 'number' ? hours : 0,
        note: l.note != null ? String(l.note).slice(0, LIMITS.maxNote) : null,
      });
    });
  }

  // materialLines — optional. description required, quantity a number >= 0.
  let materialLines = [];
  if (body.materialLines != null) {
    if (!Array.isArray(body.materialLines)) {
      errors.push('materialLines must be an array');
    } else if (body.materialLines.length > LIMITS.maxMaterialLines) {
      errors.push(`materialLines must be ${LIMITS.maxMaterialLines} or fewer`);
    } else {
      body.materialLines.forEach((m, i) => {
        if (!m || typeof m !== 'object') {
          errors.push(`materialLines[${i}] must be an object`);
          return;
        }
        const mDesc = typeof m.description === 'string' ? m.description.trim() : '';
        if (!mDesc) errors.push(`materialLines[${i}].description is required`);
        const qty = m.quantity;
        if (typeof qty !== 'number' || !Number.isFinite(qty) || qty < 0) {
          errors.push(`materialLines[${i}].quantity must be a number >= 0`);
        }
        materialLines.push({
          id: nanoid('dwm_'),
          description: mDesc,
          quantity: typeof qty === 'number' ? qty : 0,
          unit: m.unit != null ? String(m.unit).slice(0, LIMITS.maxUnit) : null,
        });
      });
    }
  }

  // photoIds — optional, ≤10 strings (the existing capture tray).
  let photoIds = [];
  if (body.photoIds != null) {
    if (!Array.isArray(body.photoIds)) {
      errors.push('photoIds must be an array');
    } else if (body.photoIds.length > LIMITS.maxPhotos) {
      errors.push(`photoIds must be ${LIMITS.maxPhotos} or fewer`);
    } else {
      photoIds = body.photoIds.map((p) => String(p)).slice(0, LIMITS.maxPhotos);
    }
  }

  // Link-only cross-references (no fan-out).
  const workPackageId = body.workPackageId != null ? String(body.workPackageId) : null;
  const variationId = body.variationId != null ? String(body.variationId) : null;
  let linkedTimeEntryIds = [];
  if (body.linkedTimeEntryIds != null) {
    if (!Array.isArray(body.linkedTimeEntryIds)) {
      errors.push('linkedTimeEntryIds must be an array');
    } else {
      linkedTimeEntryIds = body.linkedTimeEntryIds.map((x) => String(x)).slice(0, MAX_LINK_IDS);
    }
  }

  return {
    errors,
    description,
    date,
    labourLines,
    materialLines,
    photoIds,
    workPackageId,
    variationId,
    linkedTimeEntryIds,
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function listJobDockets(req, res, jobId) {
  const store = await readStore(jobId);
  const dockets = store.dockets;
  const nowMs = Date.now();
  const sorted = dockets.slice().sort((a, b) => compareForRegister(a, b, nowMs));
  const summary = summariseRegister(dockets, nowMs);
  return res.status(200).json({ dockets: sorted, summary });
}

async function crossJobRollup(req, res) {
  const jobsBlob = await readBlob('jobs.json', null);
  if (!jobsBlob || typeof jobsBlob !== 'object' || !Array.isArray(jobsBlob.jobs)) {
    return res.status(500).json({ error: 'jobs storage unavailable' });
  }
  const nowMs = Date.now();
  const all = [];
  const byJob = [];
  for (const job of jobsBlob.jobs) {
    if (!job || !job.id || job.archived === true) continue;
    const store = await readStore(job.id);
    if (store.dockets.length === 0) continue;
    const stamped = store.dockets.map((d) => ({ ...d, jobName: job.name || d.jobName || null }));
    all.push(...stamped);
    byJob.push({ jobId: job.id, jobName: job.name || null, ...summariseRegister(stamped, nowMs) });
  }
  const sorted = all.slice().sort((a, b) => compareForRegister(a, b, nowMs));
  byJob.sort((a, b) => b.unsignedAging - a.unsignedAging || b.total - a.total);
  return res.status(200).json({ dockets: sorted, summary: summariseRegister(all, nowMs), byJob });
}

async function createDocket(req, res, user, jobId) {
  const job = await loadJobOrFail(res, jobId);
  if (!job) return;

  const actorName = actorNameOf(user);
  const v = validateCreateBody(req.body || {}, user, actorName);
  if (v.errors && v.errors.length) {
    return res.status(400).json({ error: v.errors[0], errors: v.errors });
  }

  const store = await readStore(jobId);
  const seq = nextDayworkSeq(store.dockets);
  const ref = formatDayworkRef(seq);
  const nowIso = new Date().toISOString();

  const docket = {
    id: nanoid('dw_'),
    jobId,
    jobName: job.name || null,
    ref,
    seq,
    date: v.date,
    description: v.description,
    labourLines: v.labourLines,
    materialLines: v.materialLines,
    photoIds: v.photoIds,
    status: 'unsigned',
    signature: null,
    invoiceRef: null,
    linkedTimeEntryIds: v.linkedTimeEntryIds,
    workPackageId: v.workPackageId,
    variationId: v.variationId,
    createdById: user.id,
    createdByName: actorName,
    createdByRole: user.role || null,
    createdAt: nowIso,
    updatedAt: nowIso,
    amendmentOfId: null,
    amended: false,
    auditLogIds: [],
  };

  // Audit BEFORE the write so the intent survives a flaky writeBlob; catch+null
  // so an audit failure never blocks the docket.
  const audit = await appendAuditLog({
    action: 'daywork.created',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId,
    targetType: 'daywork',
    targetId: docket.id,
    summary: `daywork docket raised — ${docket.ref} "${String(docket.description).slice(0, 60)}"`,
    metadata: { ref: docket.ref, status: docket.status, labourLines: docket.labourLines.length },
  }).catch(() => null);
  if (audit && audit.id) docket.auditLogIds.push(audit.id);

  store.dockets.push(docket);
  try {
    await writeBlob(storeKey(jobId), store);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }
  return res.status(201).json({ docket });
}

async function signDocket(req, res, user, jobId, body) {
  const supervisorName =
    typeof body.supervisorName === 'string' ? body.supervisorName.trim() : '';
  if (!supervisorName) return res.status(400).json({ error: 'supervisorName required' });
  if (supervisorName.length > LIMITS.maxSupervisorName) {
    return res
      .status(400)
      .json({ error: `supervisorName must be ${LIMITS.maxSupervisorName} characters or fewer` });
  }

  const store = await readStore(jobId);
  const idx = store.dockets.findIndex((d) => d && d.id === body.id);
  if (idx === -1) return res.status(404).json({ error: 'daywork docket not found' });
  const current = store.dockets[idx];
  if (!canTransition(current.status, 'signed')) {
    return res.status(409).json({ error: `cannot sign a ${current.status} docket` });
  }

  const nowIso = new Date().toISOString();
  const actorName = actorNameOf(user);
  // Server-stamped signature. The drawn image is the deferred follow-on
  // (#328/#295) — a typed supervisor name signs today; no image is ever faked.
  const next = {
    ...current,
    status: 'signed',
    signature: {
      supervisorName,
      imageUrl: null,
      imageSha256: null,
      signedAt: nowIso,
      capturedById: user.id,
      capturedByName: actorName,
    },
    updatedAt: nowIso,
  };
  store.dockets[idx] = next;
  try {
    await writeBlob(storeKey(jobId), store);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  await appendAuditLog({
    action: 'daywork.signed',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId,
    targetType: 'daywork',
    targetId: current.id,
    summary: `daywork ${current.ref} signed by ${supervisorName}`,
    metadata: { ref: current.ref, supervisorName, from: current.status, to: 'signed' },
  }).catch(() => null);

  return res.status(200).json({ docket: next });
}

async function invoiceDocket(req, res, user, jobId, body) {
  const invoiceRef = typeof body.invoiceRef === 'string' ? body.invoiceRef.trim() : '';
  if (!invoiceRef) return res.status(400).json({ error: 'invoiceRef required when invoicing' });
  if (invoiceRef.length > LIMITS.maxInvoiceRef) {
    return res
      .status(400)
      .json({ error: `invoiceRef must be ${LIMITS.maxInvoiceRef} characters or fewer` });
  }

  const store = await readStore(jobId);
  const idx = store.dockets.findIndex((d) => d && d.id === body.id);
  if (idx === -1) return res.status(404).json({ error: 'daywork docket not found' });
  const current = store.dockets[idx];
  if (!canTransition(current.status, 'invoiced')) {
    return res.status(409).json({ error: `cannot invoice a ${current.status} docket` });
  }

  const nowIso = new Date().toISOString();
  const actorName = actorNameOf(user);
  const next = {
    ...current,
    status: 'invoiced',
    invoiceRef,
    invoicedById: user.id,
    invoicedByName: actorName,
    invoicedAt: nowIso,
    updatedAt: nowIso,
  };
  store.dockets[idx] = next;
  try {
    await writeBlob(storeKey(jobId), store);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  await appendAuditLog({
    action: 'daywork.transitioned',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId,
    targetType: 'daywork',
    targetId: current.id,
    summary: `daywork ${current.ref}: ${current.status} → invoiced (${invoiceRef})`,
    metadata: { ref: current.ref, from: current.status, to: 'invoiced', invoiceRef },
  }).catch(() => null);

  return res.status(200).json({ docket: next });
}

async function amendDocket(req, res, user, jobId, body) {
  const store = await readStore(jobId);
  const idx = store.dockets.findIndex((d) => d && d.id === body.id);
  if (idx === -1) return res.status(404).json({ error: 'daywork docket not found' });
  const original = store.dockets[idx];
  // You only AMEND an immutable docket — an unsigned one is edited directly.
  if (!isImmutable(original.status)) {
    return res
      .status(409)
      .json({ error: 'only a signed or invoiced docket is amended — edit an unsigned docket directly' });
  }

  const seq = nextDayworkSeq(store.dockets);
  const ref = formatDayworkRef(seq);
  const nowIso = new Date().toISOString();
  const actorName = actorNameOf(user);

  // The amendment carries the original's content + a back-link, resets to
  // unsigned and drops the signature. The original is NEVER mutated beyond the
  // `amended` flag.
  const amendment = {
    id: nanoid('dw_'),
    jobId,
    jobName: original.jobName || null,
    ref,
    seq,
    date: original.date,
    description: original.description,
    labourLines: original.labourLines,
    materialLines: original.materialLines,
    photoIds: original.photoIds || [],
    status: 'unsigned',
    signature: null,
    invoiceRef: null,
    linkedTimeEntryIds: original.linkedTimeEntryIds || [],
    workPackageId: original.workPackageId || null,
    variationId: original.variationId || null,
    createdById: user.id,
    createdByName: actorName,
    createdByRole: user.role || null,
    createdAt: nowIso,
    updatedAt: nowIso,
    amendmentOfId: original.id,
    amended: false,
    auditLogIds: [],
  };

  const updatedOriginal = { ...original, amended: true, updatedAt: nowIso };
  store.dockets[idx] = updatedOriginal;
  store.dockets.push(amendment);
  try {
    await writeBlob(storeKey(jobId), store);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  await appendAuditLog({
    action: 'daywork.amended',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId,
    targetType: 'daywork',
    targetId: original.id,
    summary: `daywork ${original.ref} amended → ${amendment.ref}`,
    metadata: { ref: original.ref, amendmentRef: amendment.ref, amendmentId: amendment.id },
  }).catch(() => null);

  return res.status(200).json({ docket: amendment, original: updatedOriginal });
}

// ── HTTP surface ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';

  if (req.method === 'GET') {
    // Cross-job rollup (no jobId) is admin-tier; a job list admits assigned
    // field/LH too so the worker sees their own job's dockets.
    if (!jobId) {
      const user = await requireAuth(req, res, { roles: ['admin'] });
      if (!user) return;
      try {
        return await crossJobRollup(req, res);
      } catch (e) {
        return res.status(500).json({ error: e.message || 'rollup failed' });
      }
    }
    const user = await requireAuth(req, res, { jobId });
    if (!user) return;
    if (isClientRole(user.role)) return res.status(403).json({ error: 'forbidden' });
    try {
      return await listJobDockets(req, res, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'list failed' });
    }
  }

  if (req.method === 'POST') {
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const user = await requireAuth(req, res, { jobId });
    if (!user) return;
    if (isClientRole(user.role)) return res.status(403).json({ error: 'forbidden' });
    try {
      return await createDocket(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'create failed' });
    }
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const id = body.id ? String(body.id) : '';
    const bodyJobId = body.jobId ? String(body.jobId) : '';
    const action = String(body.action || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!bodyJobId) return res.status(400).json({ error: 'jobId required' });

    // Invoicing is a commercial, admin-tier action; sign/amend admit assigned
    // field/LH (the supervisor signs on the worker's phone).
    const user =
      action === 'invoice'
        ? await requireAuth(req, res, { roles: ['admin'] })
        : await requireAuth(req, res, { jobId: bodyJobId });
    if (!user) return;
    if (isClientRole(user.role)) return res.status(403).json({ error: 'forbidden' });

    try {
      if (action === 'sign') return await signDocket(req, res, user, bodyJobId, body);
      if (action === 'invoice') return await invoiceDocket(req, res, user, bodyJobId, body);
      if (action === 'amend') return await amendDocket(req, res, user, bodyJobId, body);
      return res.status(400).json({ error: 'unknown action — expected sign | invoice | amend' });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'update failed' });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};

// Exposed for reuse / parity tests (not on the HTTP surface).
module.exports.storeKey = storeKey;
module.exports.readStore = readStore;
module.exports.nextDayworkSeq = nextDayworkSeq;
module.exports.formatDayworkRef = formatDayworkRef;
module.exports.summariseRegister = summariseRegister;
