// Variations (CLAIMS) domain endpoint — #280.
//
//   GET   /api/variations?jobId=<id>          → one job's claims (admin-tier)
//   POST  /api/variations?jobId=<id>          → create a claim (admin-tier)
//   PATCH /api/variations   (id + jobId body) → edit / status transition (admin)
//
// A variation CLAIM is how the contractor gets paid for work outside the
// contract — every missed or undocumented one is pure lost revenue. This is
// the server-backed home for the data: the legacy localStorage register
// (`public/admin/variations.html`, `buhlos.variations.v1`) was DELETED in the
// 2026-06 legacy-interface cutover, so there is NO live persisted register to
// migrate — this is the first durable store (#280 "no silent data loss" is
// satisfied vacuously: there is no persisted legacy data).
//
// Storage — PER-JOB at `jobs/<jobId>/variations.json`:
//   { claims: [VariationClaim, ...] }
// Per-job (not a top-level blob) because claims belong to a job and the
// cross-job open-value rollup scans job blobs (the hours pattern) — that
// rollup UI is a deferred follow-up; this PR ships the data + the pure
// summariseVariationClaims helper it will read.
//
// Money: integer cents (valueCents). The rollup sums integers only so the
// open-value total can't float-drift. See src/domains/variations/claim-schema.ts.
//
// Status pipeline: draft → quoted → submitted → approved → rejected → invoiced
// (carried over from the legacy register's working set + the `quoted` step).
// The APPROVAL GATE: a claim cannot reach `approved` without complete approval
// evidence (approvedBy, approvedAt, method ∈ email|verbal|signed|portal,
// reference). "Mark invoiced" stores a manual invoice reference ONLY — creating
// the Xero invoice is Epic 8 / #184. No fake integration.
//
// Permissions — admin-tier (matches the BuhlOS admin surface gate + the
// observations/material-requests cross-job APIs):
//   - unauthenticated   → 401
//   - field / LH        → 403 (claims are an office/commercial concern)
//   - admin-tier        → full GET / POST / PATCH on any job
//
// Mirrors src/domains/variations/claim-{schema,service}.ts. The pure claim
// logic (transition table, approval-evidence gate, ref minting) is duplicated
// here in plain JS to avoid a TS build dependency; parity is covered by
// src/domains/variations/variations.test.ts.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isClientRole } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { append: appendAuditLog } = require('./_lib/audit-log');

const VALID_STATUSES = new Set([
  'draft',
  'quoted',
  'submitted',
  'approved',
  'rejected',
  'invoiced',
]);
const VALID_METHODS = new Set(['email', 'verbal', 'signed', 'portal']);

const SCOPE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const REF_MAX = 200;
const INVOICE_REF_MAX = 200;
const NOTE_MAX = 2000;
const MAX_VALUE_CENTS = 10_000_000_000; // ~$100M ceiling — above this is a typo.

// State machine — mirrored from src/domains/variations/claim-service.ts.
const ALLOWED_TRANSITIONS = new Set([
  'draft→quoted',
  'draft→submitted',
  'quoted→submitted',
  'submitted→approved',
  'submitted→rejected',
  'approved→invoiced',
  // Re-work paths.
  'quoted→draft',
  'submitted→draft',
  'rejected→draft',
]);
function canTransition(from, to) {
  return ALLOWED_TRANSITIONS.has(`${from}→${to}`);
}

// Mirror of src/domains/variations/claim-service.ts isApprovalEvidenceComplete.
function isApprovalEvidenceComplete(ev) {
  if (!ev || typeof ev !== 'object') return false;
  return (
    typeof ev.approvedBy === 'string' &&
    ev.approvedBy.trim().length > 0 &&
    typeof ev.approvedAt === 'string' &&
    ev.approvedAt.trim().length > 0 &&
    typeof ev.reference === 'string' &&
    ev.reference.trim().length > 0 &&
    VALID_METHODS.has(ev.method)
  );
}

// Mirror of src/domains/variations/claim-service.ts nextClaimRef. Collision-safe:
// max(existing) + 1, zero-padded to VO-001 — never count + 1 (a removed claim
// must never re-mint a live ref).
function nextClaimRef(claims) {
  let max = 0;
  for (const c of claims || []) {
    const m = /^VO-(\d+)$/.exec(String((c && c.ref) || '').trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return 'VO-' + String(max + 1).padStart(3, '0');
}

function storeKey(jobId) {
  return `jobs/${jobId}/variations.json`;
}

function emptyStore() {
  return { claims: [] };
}

async function readStore(jobId) {
  return readBlob(storeKey(jobId), emptyStore());
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

// Validate the optional links bag. evidenceIds/documentIds are arrays of
// strings; observationId is a string. Honest about shape; the deeper
// "does this evidence id exist on the job" check is left to the UI follow-up
// (the legacy register linked free-text refs too).
function validateLinks(body) {
  const errors = [];
  const links = { observationId: null, evidenceIds: [], documentIds: [] };
  if (body.links == null) return { errors, links };
  if (typeof body.links !== 'object' || Array.isArray(body.links)) {
    errors.push('links must be an object');
    return { errors, links };
  }
  const L = body.links;
  if (L.observationId != null) links.observationId = String(L.observationId);
  for (const key of ['evidenceIds', 'documentIds']) {
    if (L[key] == null) continue;
    if (!Array.isArray(L[key])) {
      errors.push(`links.${key} must be an array`);
      continue;
    }
    links[key] = L[key].map((x) => String(x)).slice(0, 50);
  }
  return { errors, links };
}

function validateValueCents(raw, errors) {
  if (raw == null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    errors.push('valueCents must be an integer number of cents');
    return null;
  }
  if (raw < 0) {
    errors.push('valueCents must be >= 0');
    return null;
  }
  if (raw > MAX_VALUE_CENTS) {
    errors.push(`valueCents must be <= ${MAX_VALUE_CENTS}`);
    return null;
  }
  return raw;
}

function validateCreateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['body must be an object'] };
  }

  const scope = typeof body.scope === 'string' ? body.scope.trim() : '';
  if (!scope) errors.push('scope is required');
  if (scope.length > SCOPE_MAX) errors.push(`scope must be ${SCOPE_MAX} characters or fewer`);

  let description = null;
  if (body.description != null) {
    description = String(body.description);
    if (description.length > DESCRIPTION_MAX) {
      errors.push(`description must be ${DESCRIPTION_MAX} characters or fewer`);
    }
  }

  const valueCents = validateValueCents(body.valueCents, errors);

  const { errors: linkErrors, links } = validateLinks(body);
  errors.push(...linkErrors);

  return { errors, scope, description, valueCents, links };
}

async function listJobClaims(req, res, jobId) {
  const store = await readStore(jobId);
  const all = Array.isArray(store.claims) ? store.claims : [];
  // Newest-first by createdAt.
  const sorted = all
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return res.status(200).json({ claims: sorted });
}

async function createClaim(req, res, user, jobId) {
  const job = await loadJobOrFail(res, jobId);
  if (!job) return;

  const v = validateCreateBody(req.body || {});
  if (v.errors && v.errors.length) {
    return res.status(400).json({ error: v.errors[0], errors: v.errors });
  }

  const nowIso = new Date().toISOString();
  const actorName = user.name || user.username || 'Unknown';

  const store = await readStore(jobId);
  if (!Array.isArray(store.claims)) store.claims = [];
  const ref = nextClaimRef(store.claims);

  const claim = {
    id: nanoid('vc_'),
    jobId,
    ref,
    scope: v.scope,
    description: v.description,
    status: 'draft',
    valueCents: v.valueCents,
    links: v.links,
    approval: null,
    decisionNote: null,
    invoiceRef: null,
    invoicedAt: null,
    createdAt: nowIso,
    createdById: user.id,
    createdByName: actorName,
    updatedAt: nowIso,
    auditLogIds: [],
  };

  // Audit BEFORE write so the intent is captured even on a flaky writeBlob;
  // catch + null so a log failure never blocks the claim write.
  const audit = await appendAuditLog({
    action: 'variation.created',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId,
    targetType: 'variation',
    targetId: claim.id,
    summary: `variation claim raised — ${claim.ref} "${String(claim.scope).slice(0, 60)}"`,
    metadata: {
      ref: claim.ref,
      valueCents: claim.valueCents,
      status: claim.status,
      observationId: claim.links.observationId,
    },
  }).catch(() => null);
  if (audit && audit.id) claim.auditLogIds.push(audit.id);

  store.claims.push(claim);
  try {
    await writeBlob(storeKey(jobId), store);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  return res.status(201).json({ claim });
}

async function updateClaim(req, res, user) {
  const body = req.body || {};
  const id = body.id ? String(body.id) : '';
  const jobId = body.jobId ? String(body.jobId) : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const store = await readStore(jobId);
  const arr = Array.isArray(store.claims) ? store.claims : [];
  const idx = arr.findIndex((c) => c && c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'variation claim not found' });

  const current = arr[idx];
  const nowIso = new Date().toISOString();
  const actorName = user.name || user.username || 'Unknown';
  const next = { ...current, updatedAt: nowIso };

  // ── editable fields (only on a non-terminal claim's scope/value/desc) ──
  if (body.scope !== undefined) {
    const scope = typeof body.scope === 'string' ? body.scope.trim() : '';
    if (!scope) return res.status(400).json({ error: 'scope cannot be empty' });
    if (scope.length > SCOPE_MAX) {
      return res.status(400).json({ error: `scope must be ${SCOPE_MAX} characters or fewer` });
    }
    next.scope = scope;
  }
  if (body.description !== undefined) {
    const d = body.description == null ? null : String(body.description);
    if (d && d.length > DESCRIPTION_MAX) {
      return res.status(400).json({ error: `description must be ${DESCRIPTION_MAX} characters or fewer` });
    }
    next.description = d;
  }
  if (body.valueCents !== undefined) {
    const verrors = [];
    const value = validateValueCents(body.valueCents, verrors);
    if (verrors.length) return res.status(400).json({ error: verrors[0] });
    next.valueCents = value;
  }
  if (body.links !== undefined) {
    const { errors: linkErrors, links } = validateLinks(body);
    if (linkErrors.length) return res.status(400).json({ error: linkErrors[0] });
    next.links = links;
  }

  // ── status transition ──
  let transitioned = false;
  if (body.status !== undefined) {
    const to = String(body.status);
    if (!VALID_STATUSES.has(to)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    if (to !== current.status) {
      if (!canTransition(current.status, to)) {
        return res.status(409).json({
          error: `invalid transition: ${current.status} → ${to}`,
        });
      }

      // THE APPROVAL GATE — approved is unreachable without complete evidence.
      if (to === 'approved') {
        const ev = body.approval;
        if (!isApprovalEvidenceComplete(ev)) {
          return res.status(400).json({
            error:
              'approval requires approvedBy, approvedAt, method (email|verbal|signed|portal) and a reference',
          });
        }
        next.approval = {
          approvedBy: String(ev.approvedBy).trim(),
          approvedAt: String(ev.approvedAt).trim(),
          method: ev.method,
          reference: String(ev.reference).trim(),
        };
        next.decisionNote = null;
      }

      if (to === 'rejected') {
        next.decisionNote =
          body.decisionNote != null ? String(body.decisionNote).slice(0, NOTE_MAX) : null;
      }

      // "Mark invoiced" — manual reference ONLY. No integration (Epic 8 / #184).
      if (to === 'invoiced') {
        const invoiceRef = typeof body.invoiceRef === 'string' ? body.invoiceRef.trim() : '';
        if (!invoiceRef) {
          return res.status(400).json({ error: 'invoiceRef required when marking invoiced' });
        }
        if (invoiceRef.length > INVOICE_REF_MAX) {
          return res
            .status(400)
            .json({ error: `invoiceRef must be ${INVOICE_REF_MAX} characters or fewer` });
        }
        next.invoiceRef = invoiceRef;
        next.invoicedAt = nowIso;
      }

      // Re-work to draft clears the prior decision so a re-submit starts clean.
      if (to === 'draft') {
        next.decisionNote = null;
      }

      next.status = to;
      transitioned = true;
    }
  }

  arr[idx] = next;
  store.claims = arr;
  try {
    await writeBlob(storeKey(jobId), store);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  // ── audit (best-effort) ── one transitioned row per status change; the
  // metadata.from/to carry the direction (the snag pattern). metadata.method
  // on the approve move so a dispute review sees HOW it was approved.
  if (transitioned) {
    await appendAuditLog({
      action: 'variation.transitioned',
      actorId: user.id,
      actorName,
      actorRole: user.role || null,
      jobId,
      targetType: 'variation',
      targetId: current.id,
      summary: `variation claim ${current.ref}: ${current.status} → ${next.status}`,
      metadata: {
        ref: current.ref,
        from: current.status,
        to: next.status,
        valueCents: next.valueCents,
        ...(next.status === 'approved' && next.approval
          ? { method: next.approval.method }
          : {}),
        ...(next.status === 'invoiced' ? { invoiceRef: next.invoiceRef } : {}),
      },
    }).catch(() => null);
  }

  return res.status(200).json({ claim: next });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';

  // --- POST create: admin-tier, job-scoped --------------------------------
  if (req.method === 'POST') {
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const user = await requireAuth(req, res, { roles: ['admin'] });
    if (!user) return;
    try {
      return await createClaim(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'create failed' });
    }
  }

  // --- PATCH update / transition: admin-tier ------------------------------
  if (req.method === 'PATCH') {
    const user = await requireAuth(req, res, { roles: ['admin'] });
    if (!user) return;
    try {
      return await updateClaim(req, res, user);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'update failed' });
    }
  }

  // --- GET: per-job list, admin-tier --------------------------------------
  if (req.method === 'GET') {
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const user = await requireAuth(req, res, { roles: ['admin'] });
    if (!user) return;
    // Defence in depth — a client must never reach a claims list.
    if (isClientRole(user.role)) return res.status(403).json({ error: 'forbidden' });
    try {
      return await listJobClaims(req, res, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'list failed' });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};

// Exposed for api/observations.js#convertObservationToVariation so the
// conversion path uses the same ref minting + storage shape. Not on the HTTP
// surface; required internally.
module.exports.nextClaimRef = nextClaimRef;
module.exports.storeKey = storeKey;
module.exports.readStore = readStore;
