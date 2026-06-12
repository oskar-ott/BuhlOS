// /api/quotes-v2 — v2 quote builder foundation (#183).
//
// Built per the #172 MIGRATE-BY-REBUILD ruling (docs/quoting-legacy-audit.md):
// the legacy api/quotes.js module is a design reference, never a runtime
// dependency. This endpoint NEVER reads or writes the legacy stores
// (quotes.json / quotes/<id>/*) — the two legacy draft shells stay readable
// there until retirement (#172 §8 step 7).
//
// STORAGE MODEL (the #172 §4.7 fixes, deliberately inverted from legacy):
//   - quotes-v2.json            registry of summary rows:
//                               { quotes: [{ id, name, status, updatedAt,
//                                            totalIncGst, lineCount }] }
//   - quotes-v2/<id>.json       ONE full document per quote (sections→lines).
//
// A save is ONE atomic document write, then a registry read-modify-write to
// refresh that quote's summary row. The document is the source of truth; the
// registry is derived (a failed registry update self-heals on the next save).
// No per-keystroke section PATCHes, no touchQuote write amplification.
//
// CONCURRENCY (issue #183 requirement 3): the client echoes the `updatedAt`
// it loaded; a PUT whose echo doesn't match the stored document 409s and
// returns the CURRENT server document so the builder can offer "load
// latest". Defence-in-depth: the document write also threads the stored
// __rev as expectedRev so blob-guards' revision check (#157) narrows the
// read-check-write race window; a StaleWriteError maps to the same 409.
//
// VALIDATION mirrors src/domains/quoting/schema.ts BY HAND (CJS cannot
// import the TS domain — repo law). Change LIMITS / statuses / kinds in BOTH
// files in the same commit; the harness test pins both. Totals math mirrors
// src/domains/quoting/totals.ts the same way (golden fixtures duplicated in
// src/domains/quoting/quotes-v2-api.test.ts keep the two from drifting).
//
// FOUNDATION SCOPE ONLY: totals are sum-of-lines → GST. Markup, provisional
// sums, contingency and margin belong to the calculator children
// (#193/#195/#214/#223 — legacy §4.4 math is their acceptance spec). The
// quote→job convert path arrives with #244 THROUGH api/jobs.js.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');

const REGISTRY_KEY = 'quotes-v2.json';
const docKey = (id) => `quotes-v2/${id}.json`;

// ── Mirrors of src/domains/quoting/schema.ts (change together) ───────────
const QUOTE_STATUSES = new Set(['draft', 'submitted', 'won', 'lost', 'archived']);
const LINE_KINDS = new Set(['material', 'labour', 'other']);
const LIMITS = {
  maxSections: 50,
  maxLinesPerSection: 200,
  maxName: 120,
  maxClientName: 120,
  maxSectionTitle: 80,
  maxLineDescription: 200,
  maxUnit: 20,
  maxQty: 1_000_000,
  maxRate: 1_000_000,
  maxId: 40,
};

// ── Mirrors of src/domains/quoting/totals.ts (change together) ───────────
const GST_RATE = 0.1;
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function lineTotal(line) {
  return roundMoney(Number(line.qty) * Number(line.rate));
}
/** Round at the line, then sum — the pinned rule from totals.ts. */
function computeQuoteTotals(sections) {
  let subtotal = 0;
  let lineCount = 0;
  for (const section of sections) {
    for (const line of section.lines) {
      subtotal += lineTotal(line);
      lineCount += 1;
    }
  }
  const subtotalExGst = roundMoney(subtotal);
  const gst = roundMoney(subtotalExGst * GST_RATE);
  const totalIncGst = roundMoney(subtotalExGst + gst);
  return { subtotalExGst, gst, totalIncGst, lineCount };
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Validation (hard 400s — never silent truncation, per api/jobs.js
//    validateScopeOfWork precedent) ──────────────────────────────────────

function validString(value, field, { required = false, max }) {
  if (value === undefined || value === null) {
    return required ? { error: `${field} required` } : { value: '' };
  }
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (required && !trimmed) return { error: `${field} required` };
  if (trimmed.length > max) return { error: `${field} too long (${max} max)` };
  return { value: trimmed };
}

function validNumber(value, field, { min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `${field} must be a finite number` };
  }
  if (value < min || value > max) return { error: `${field} out of range (${min}..${max})` };
  return { value };
}

/** Existing ids round-trip; anything missing/foreign gets a fresh server id. */
function normaliseId(raw, prefix) {
  if (typeof raw === 'string' && raw && raw.length <= LIMITS.maxId) return raw;
  return uid(prefix);
}

function validateCreate(body) {
  const name = validString(body && body.name, 'name', { required: true, max: LIMITS.maxName });
  if (name.error) return { ok: false, error: name.error };
  const clientName = validString(body && body.clientName, 'clientName', { max: LIMITS.maxClientName });
  if (clientName.error) return { ok: false, error: clientName.error };
  return { ok: true, name: name.value, clientName: clientName.value };
}

/**
 * Full-document save payload → normalised sections + basics.
 * Section order is the array order; sortOrder is rewritten 0..n-1 so the
 * persisted document is deterministic and table-portable (Supabase later).
 */
function validateSave(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };

  const name = validString(body.name, 'name', { required: true, max: LIMITS.maxName });
  if (name.error) return { ok: false, error: name.error };
  const clientName = validString(body.clientName, 'clientName', { max: LIMITS.maxClientName });
  if (clientName.error) return { ok: false, error: clientName.error };

  if (typeof body.updatedAt !== 'string' || !body.updatedAt) {
    return { ok: false, error: 'updatedAt precondition required (echo the loaded value)' };
  }

  let status;
  if (body.status !== undefined) {
    if (!QUOTE_STATUSES.has(body.status)) return { ok: false, error: 'unknown status' };
    status = body.status;
  }

  if (!Array.isArray(body.sections)) return { ok: false, error: 'sections must be an array' };
  if (body.sections.length > LIMITS.maxSections) {
    return { ok: false, error: `sections: ${LIMITS.maxSections} max` };
  }

  const sections = [];
  for (let i = 0; i < body.sections.length; i++) {
    const raw = body.sections[i];
    if (!raw || typeof raw !== 'object') return { ok: false, error: `sections[${i}] must be an object` };
    const title = validString(raw.title, `sections[${i}].title`, {
      required: true,
      max: LIMITS.maxSectionTitle,
    });
    if (title.error) return { ok: false, error: title.error };
    if (!Array.isArray(raw.lines)) return { ok: false, error: `sections[${i}].lines must be an array` };
    if (raw.lines.length > LIMITS.maxLinesPerSection) {
      return { ok: false, error: `sections[${i}].lines: ${LIMITS.maxLinesPerSection} max` };
    }

    const lines = [];
    for (let j = 0; j < raw.lines.length; j++) {
      const l = raw.lines[j];
      const at = `sections[${i}].lines[${j}]`;
      if (!l || typeof l !== 'object') return { ok: false, error: `${at} must be an object` };
      if (!LINE_KINDS.has(l.kind)) return { ok: false, error: `${at}.kind must be material|labour|other` };
      const description = validString(l.description, `${at}.description`, { max: LIMITS.maxLineDescription });
      if (description.error) return { ok: false, error: description.error };
      const unit = validString(l.unit, `${at}.unit`, { max: LIMITS.maxUnit });
      if (unit.error) return { ok: false, error: unit.error };
      const qty = validNumber(l.qty, `${at}.qty`, { min: 0, max: LIMITS.maxQty });
      if (qty.error) return { ok: false, error: qty.error };
      // Negative rate within range is a discount line — allowed.
      const rate = validNumber(l.rate, `${at}.rate`, { min: -LIMITS.maxRate, max: LIMITS.maxRate });
      if (rate.error) return { ok: false, error: rate.error };
      lines.push({
        id: normaliseId(l.id, 'qline'),
        kind: l.kind,
        description: description.value,
        qty: qty.value,
        unit: unit.value,
        rate: rate.value,
      });
    }

    sections.push({ id: normaliseId(raw.id, 'qsec'), title: title.value, sortOrder: i, lines });
  }

  return {
    ok: true,
    name: name.value,
    clientName: clientName.value,
    status,
    sections,
    updatedAt: body.updatedAt,
  };
}

// ── Storage helpers ──────────────────────────────────────────────────────

async function readRegistry() {
  const data = await readBlob(REGISTRY_KEY, { quotes: [] });
  if (!data || !Array.isArray(data.quotes)) return { quotes: [] };
  return data;
}

function summaryRow(doc) {
  return {
    id: doc.id,
    name: doc.name,
    status: doc.status,
    updatedAt: doc.updatedAt,
    totalIncGst: doc.totals.totalIncGst,
    lineCount: doc.totals.lineCount,
  };
}

/** Registry read-modify-write AFTER the document write (doc is the truth;
 *  a row that's missing — e.g. a previously failed registry write — is
 *  re-appended, so the registry self-heals on the next save). */
async function upsertRegistryRow(doc) {
  const registry = await readRegistry();
  const row = summaryRow(doc);
  const idx = registry.quotes.findIndex((q) => q && q.id === doc.id);
  if (idx >= 0) registry.quotes[idx] = { ...registry.quotes[idx], ...row };
  else registry.quotes.push(row);
  await writeBlob(REGISTRY_KEY, registry);
}

function currentRevOf(doc) {
  return doc && Number.isFinite(doc.__rev) ? doc.__rev : 0;
}

/** Strip storage stamps so wire documents are exactly the domain shape. */
function toWire(doc) {
  const { __rev, __updatedAt, ...wire } = doc;
  return wire;
}

// ── Handlers ─────────────────────────────────────────────────────────────

async function handleList(req, res) {
  const registry = await readRegistry();
  const includeArchived = req.query && req.query.includeArchived === '1';
  const quotes = registry.quotes
    .filter((q) => includeArchived || q.status !== 'archived')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return res.status(200).json({ quotes });
}

async function handleGet(req, res, id) {
  const doc = await readBlob(docKey(id), null);
  if (!doc) return res.status(404).json({ error: 'quote not found' });
  return res.status(200).json({ quote: toWire(doc) });
}

async function handleCreate(req, res, user) {
  const input = validateCreate(req.body || {});
  if (!input.ok) return res.status(400).json({ error: input.error });

  const now = new Date().toISOString();
  const doc = {
    id: uid('qv2'),
    name: input.name,
    clientName: input.clientName || null,
    status: 'draft',
    createdAt: now,
    createdBy: user.username || user.id,
    updatedAt: now,
    sections: [],
    totals: computeQuoteTotals([]),
  };

  await writeBlob(docKey(doc.id), doc);
  await upsertRegistryRow(doc);
  return res.status(201).json({ quote: doc });
}

async function handleSave(req, res, id) {
  const input = validateSave(req.body || {});
  if (!input.ok) return res.status(400).json({ error: input.error });

  const current = await readBlob(docKey(id), null);
  if (!current) return res.status(404).json({ error: 'quote not found' });

  // Stale-save precondition: the client must hold the latest document.
  if (input.updatedAt !== current.updatedAt) {
    return res.status(409).json({
      error: 'quote changed since you loaded it',
      quote: toWire(current),
    });
  }

  const next = {
    id: current.id,
    name: input.name,
    clientName: input.clientName || null,
    status: input.status || current.status,
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    updatedAt: new Date().toISOString(),
    sections: input.sections,
    totals: computeQuoteTotals(input.sections),
  };

  try {
    await writeBlob(docKey(id), next, { expectedRev: currentRevOf(current) });
  } catch (err) {
    if (err && err.code === 'stale_write') {
      // Lost the read-check-write race to a parallel save — same contract
      // as the updatedAt mismatch: hand back the winner's document.
      const latest = await readBlob(docKey(id), null);
      return res.status(409).json({
        error: 'quote changed since you loaded it',
        quote: latest ? toWire(latest) : null,
      });
    }
    throw err;
  }

  await upsertRegistryRow(next);
  return res.status(200).json({ quote: next });
}

/** DELETE = archive (status flip). Never destructive — the document and its
 *  registry row stay; the default list view just stops showing the row. */
async function handleArchive(req, res, id) {
  const current = await readBlob(docKey(id), null);
  if (!current) return res.status(404).json({ error: 'quote not found' });

  if (current.status === 'archived') {
    return res.status(200).json({ quote: toWire(current) }); // idempotent
  }

  const next = { ...toWire(current), status: 'archived', updatedAt: new Date().toISOString() };
  await writeBlob(docKey(id), next, { expectedRev: currentRevOf(current) });
  await upsertRegistryRow(next);
  return res.status(200).json({ quote: next });
}

// ── Router ───────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  // Quoting is commercial — admin TIER only (boss/owner/manager/office/pm/
  // estimator all pass; field, LH and client roles never do).
  if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin tier only' });

  const id = (req.query && req.query.id) || '';

  if (req.method === 'GET') return id ? handleGet(req, res, id) : handleList(req, res);
  if (req.method === 'POST') return handleCreate(req, res, user);
  if (req.method === 'PUT') {
    if (!id) return res.status(400).json({ error: 'id required' });
    return handleSave(req, res, id);
  }
  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'id required' });
    return handleArchive(req, res, id);
  }
  return res.status(405).json({ error: 'method not allowed' });
};

// Exposed for the harness mirror test (totals parity with totals.ts).
module.exports.computeQuoteTotals = computeQuoteTotals;
module.exports.QUOTE_LIMITS = LIMITS;
