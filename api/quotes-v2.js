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
//
// #246 — AI QUOTE DRAFTS (flag `ai_quote_drafts`, dark by default):
//   POST ?id=X&action=ai-draft         paste scope text → suggested lines,
//                                      stored under the ADDITIVE doc field
//                                      `aiDraft` (runs + suggestions). Never
//                                      touches sections/totals.
//   POST ?id=X&action=ai-draft-review  accept/edit/reject ONE suggestion;
//                                      accept/edit writes a real line at
//                                      rate 0 + needsPricing (never invents a
//                                      price) in the SAME atomic doc write.
// Suggestion contract mirrors src/domains/quoting/ai-draft.ts (change
// together); envelope/review rules live in api/_lib/ai-suggestions.js.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { aiComplete, isAiConfigured } = require('./_lib/ai');
const { suggestionEnvelope, reviewSuggestion, parseModelJson } = require('./_lib/ai-suggestions');

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
  maxCategory: 60,
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
      const line = {
        id: normaliseId(l.id, 'qline'),
        kind: l.kind,
        description: description.value,
        qty: qty.value,
        unit: unit.value,
        rate: rate.value,
      };
      // #214/#193 — optional INTERNAL cost fields. Persisted on the document but
      // stripped from the client by the sell-side projection (#186). Present →
      // validated (hard 400, never silent); absent → omitted (line stays uncosted).
      if (l.unitCost !== undefined && l.unitCost !== null) {
        const unitCost = validNumber(l.unitCost, `${at}.unitCost`, { min: -LIMITS.maxRate, max: LIMITS.maxRate });
        if (unitCost.error) return { ok: false, error: unitCost.error };
        line.unitCost = unitCost.value;
      }
      if (l.category !== undefined && l.category !== null) {
        const category = validString(l.category, `${at}.category`, { max: LIMITS.maxCategory });
        if (category.error) return { ok: false, error: category.error };
        if (category.value) line.category = category.value;
      }
      if (l.ratePresetId !== undefined && l.ratePresetId !== null) {
        const rp = validString(l.ratePresetId, `${at}.ratePresetId`, { max: LIMITS.maxId });
        if (rp.error) return { ok: false, error: rp.error };
        if (rp.value) line.ratePresetId = rp.value;
      }
      if (l.ratePresetName !== undefined && l.ratePresetName !== null) {
        const rpn = validString(l.ratePresetName, `${at}.ratePresetName`, { max: LIMITS.maxName });
        if (rpn.error) return { ok: false, error: rpn.error };
        if (rpn.value) line.ratePresetName = rpn.value;
      }
      // #246 — AI-draft provenance flags round-trip through the full-document
      // save so the "AI · needs pricing" badge survives an ordinary save.
      if (l.source !== undefined && l.source !== null) {
        if (l.source !== 'ai_suggested') return { ok: false, error: `${at}.source must be "ai_suggested"` };
        line.source = 'ai_suggested';
      }
      if (l.aiSuggestionId !== undefined && l.aiSuggestionId !== null) {
        const sid = validString(l.aiSuggestionId, `${at}.aiSuggestionId`, { max: LIMITS.maxId });
        if (sid.error) return { ok: false, error: sid.error };
        if (sid.value) line.aiSuggestionId = sid.value;
      }
      if (l.needsPricing !== undefined && l.needsPricing !== null) {
        if (typeof l.needsPricing !== 'boolean') {
          return { ok: false, error: `${at}.needsPricing must be a boolean` };
        }
        if (l.needsPricing) line.needsPricing = true; // false ≡ absent (priced)
      }
      lines.push(line);
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
    // clientName is already captured on the document; the list surface shows it
    // as a Client column (admin-only surface). null when not set so the UI shows
    // an honest "—". Older registry rows lack it until the quote is next saved.
    clientName: doc.clientName || null,
    status: doc.status,
    updatedAt: doc.updatedAt,
    totalIncGst: doc.totals.totalIncGst,
    lineCount: doc.totals.lineCount,
  };
}

/** Registry read-modify-write AFTER the document write (doc is the truth;
 *  a row that's missing — e.g. a previously failed registry write — is
 *  re-appended, so the registry self-heals on the next save).
 *
 *  #511: guarded with expectedRev + a re-read retry (the api/users.js pattern).
 *  Without it, two concurrent saves both read the same registry snapshot and
 *  last-write-wins DROPS one quote's row from the office money-list (lost-update
 *  class). On a stale-revision conflict we re-read the fresh registry and
 *  re-apply THIS quote's single-row upsert, so no concurrent row is lost. */
async function upsertRegistryRow(doc) {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const registry = await readRegistry();
    const row = summaryRow(doc);
    const idx = registry.quotes.findIndex((q) => q && q.id === doc.id);
    if (idx >= 0) registry.quotes[idx] = { ...registry.quotes[idx], ...row };
    else registry.quotes.push(row);
    try {
      await writeBlob(REGISTRY_KEY, registry, { expectedRev: currentRevOf(registry) });
      return;
    } catch (e) {
      if (e && e.code === 'stale_write' && attempt < MAX_ATTEMPTS - 1) continue;
      throw e;
    }
  }
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
    // #246 — the AI-draft trail is doc-owned, not part of the save payload;
    // carry it forward so an ordinary save never wipes runs/suggestions.
    ...(current.aiDraft ? { aiDraft: current.aiDraft } : {}),
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

// ── #246: AI quote drafts ────────────────────────────────────────────────
// Mirrors src/domains/quoting/ai-draft.ts (CJS cannot import TS — change
// together; the harness test pins both sides).

// Bare current alias per #378, same env knob as the legacy ai-review.
const QUOTE_DRAFT_AI_MODEL = process.env.QUOTES_AI_MODEL || 'claude-sonnet-4-6';
const QUOTE_DRAFT_PROMPT_VERSION = 'quote-draft-v1';
const SCOPE_TEXT_MAX_CHARS = 12000;
const SOURCE_TEXT_EXCERPT_CHARS = 300;
const TAKEOFF_MAX_ITEMS = 500;

const QUOTE_DRAFT_SYSTEM = [
  'You help an Australian commercial-electrical estimator draft quote line items from a tender scope.',
  'Read the scope text (and measured takeoff items when provided) and propose sections of labour and material lines.',
  'Reply with STRICT JSON only — no prose around it — using exactly this shape:',
  '{"sections":[{"title":"...","lines":[{"kind":"labour"|"material"|"other","description":"...","qty":number|null,"unit":string|null,"uncertainty":string|null}]}]}.',
  'Rules: qty MUST be null unless the input states an explicit quantity — never estimate one.',
  'NEVER propose a rate, price or dollar amount anywhere.',
  'Where you are unsure about a line, say why in its "uncertainty" field; otherwise use null.',
  'Use Australian construction language. Never invent work the scope does not mention.',
].join(' ');

/** Mirror of ai-draft.ts parseTakeoffInput — the typed, STUBBED Epic-5
 *  interface (no producer emits it yet; pasted text is the only live path). */
function validateTakeoff(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'takeoff must be an object' };
  if (raw.source !== 'takeoff') return { ok: false, error: 'takeoff.source must be "takeoff"' };
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    return { ok: false, error: 'takeoff.items must be a non-empty array' };
  }
  if (raw.items.length > TAKEOFF_MAX_ITEMS) {
    return { ok: false, error: `takeoff.items: ${TAKEOFF_MAX_ITEMS} max` };
  }
  const items = [];
  for (let i = 0; i < raw.items.length; i++) {
    const it = raw.items[i];
    const at = `takeoff.items[${i}]`;
    if (!it || typeof it !== 'object') return { ok: false, error: `${at} must be an object` };
    const description = validString(it.description, `${at}.description`, { required: true, max: LIMITS.maxLineDescription });
    if (description.error) return { ok: false, error: description.error };
    const qty = validNumber(it.qty, `${at}.qty`, { min: 0, max: LIMITS.maxQty });
    if (qty.error) return { ok: false, error: qty.error };
    const unit = validString(it.unit, `${at}.unit`, { max: LIMITS.maxUnit });
    if (unit.error) return { ok: false, error: unit.error };
    const item = { description: description.value, qty: qty.value, unit: unit.value };
    if (it.drawingRef !== undefined && it.drawingRef !== null) {
      const ref = validString(it.drawingRef, `${at}.drawingRef`, { max: 80 });
      if (ref.error) return { ok: false, error: ref.error };
      if (ref.value) item.drawingRef = ref.value;
    }
    items.push(item);
  }
  return { ok: true, items };
}

/** Mirror of ai-draft.ts validateProposedLine: kind whitelist, description
 *  non-empty, qty null unless an explicit number was given. An invalid
 *  proposal is DROPPED (draft) or 400s (review edit), never "fixed up". */
function validateProposedLine(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'line must be an object' };
  if (!LINE_KINDS.has(raw.kind)) return { ok: false, error: 'kind must be material|labour|other' };
  if (typeof raw.description !== 'string' || !raw.description.trim()) {
    return { ok: false, error: 'description required' };
  }
  const description = raw.description.trim();
  if (description.length > LIMITS.maxLineDescription) {
    return { ok: false, error: `description too long (${LIMITS.maxLineDescription} max)` };
  }
  let qty = null;
  if (raw.qty !== null && raw.qty !== undefined) {
    if (typeof raw.qty !== 'number' || !Number.isFinite(raw.qty) || raw.qty < 0 || raw.qty > LIMITS.maxQty) {
      return { ok: false, error: 'qty must be null or a finite number ≥ 0' };
    }
    qty = raw.qty;
  }
  let unit = null;
  if (raw.unit !== null && raw.unit !== undefined && raw.unit !== '') {
    if (typeof raw.unit !== 'string') return { ok: false, error: 'unit must be null or a string' };
    const trimmed = raw.unit.trim();
    if (trimmed.length > LIMITS.maxUnit) return { ok: false, error: `unit too long (${LIMITS.maxUnit} max)` };
    unit = trimmed || null;
  }
  const uncertainty =
    typeof raw.uncertainty === 'string' && raw.uncertainty.trim()
      ? raw.uncertainty.trim().slice(0, 300)
      : null;
  return { ok: true, line: { kind: raw.kind, description, qty, unit }, uncertainty };
}

function aiDraftOf(doc) {
  const ai = doc && doc.aiDraft;
  return {
    runs: ai && Array.isArray(ai.runs) ? ai.runs : [],
    suggestions: ai && Array.isArray(ai.suggestions) ? ai.suggestions : [],
  };
}

/**
 * POST ?id=X&action=ai-draft  body { sourceText, takeoff? }
 *
 * Paste-first v1: sourceText is REQUIRED — the register's PDF text extraction
 * does not exist, and the UI says so. Input beyond SCOPE_TEXT_MAX_CHARS is
 * truncated and the run records truncated/usedChars so the UI can disclose it.
 * The model proposes sections + lines ONLY (never a rate); results are stored
 * as suggestions under the additive `aiDraft` field. Sections, totals and
 * updatedAt are UNTOUCHED — an open builder tab's save precondition survives.
 * Re-running supersedes still-'suggested' older suggestions; accepted /
 * rejected history is never rewritten.
 */
async function handleAiDraft(req, res, user, id) {
  if (!(await isFlagEnabled('ai_quote_drafts', user))) {
    return res.status(404).json({ error: 'not found' });
  }
  if (!isAiConfigured()) {
    return res.status(503).json({ error: 'AI is not configured', code: 'UNCONFIGURED' });
  }

  const body = req.body || {};
  const sourceText = typeof body.sourceText === 'string' ? body.sourceText.trim() : '';
  if (!sourceText) {
    return res.status(400).json({
      error: 'sourceText required — paste the scope/spec text (PDF text extraction is not built)',
    });
  }

  let takeoff = null;
  if (body.takeoff !== undefined && body.takeoff !== null) {
    const parsedTakeoff = validateTakeoff(body.takeoff);
    if (!parsedTakeoff.ok) return res.status(400).json({ error: parsedTakeoff.error });
    takeoff = parsedTakeoff;
  }

  const current = await readBlob(docKey(id), null);
  if (!current) return res.status(404).json({ error: 'quote not found' });

  const truncated = sourceText.length > SCOPE_TEXT_MAX_CHARS;
  const usedText = sourceText.slice(0, SCOPE_TEXT_MAX_CHARS);
  const userContent =
    'Scope text:\n' +
    usedText +
    (takeoff
      ? '\n\nTakeoff items (measured from drawings — treat these quantities as explicit):\n' +
        JSON.stringify(takeoff.items)
      : '');

  let completion;
  try {
    completion = await aiComplete({
      system: QUOTE_DRAFT_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
      model: QUOTE_DRAFT_AI_MODEL,
      maxTokens: 2048,
    });
  } catch (e) {
    if (e && e.name === 'AiError') {
      const status = e.code === 'UNCONFIGURED' ? 503 : 502;
      return res.status(status).json({ error: e.message, code: e.code });
    }
    throw e;
  }

  const parsed = parseModelJson(completion.text);
  if (!parsed.ok || !parsed.value || !Array.isArray(parsed.value.sections)) {
    // Honest failure: a non-JSON / wrong-shape reply stores NOTHING.
    return res.status(502).json({
      error: 'the model reply was not the expected JSON — nothing was stored, run it again',
      code: 'PROVIDER_FAILED',
    });
  }

  const run = {
    id: uid('aidr'),
    createdAt: new Date().toISOString(),
    createdById: user.id || user.username || null,
    model: completion.model,
    promptVersion: QUOTE_DRAFT_PROMPT_VERSION,
    sourceTextExcerpt: usedText.slice(0, SOURCE_TEXT_EXCERPT_CHARS),
    truncated,
    usedChars: usedText.length,
    usage: completion.usage || null,
    takeoffProvided: Boolean(takeoff),
  };

  const newSuggestions = [];
  for (const rawSection of parsed.value.sections) {
    if (!rawSection || typeof rawSection !== 'object') continue;
    const title =
      typeof rawSection.title === 'string'
        ? rawSection.title.trim().slice(0, LIMITS.maxSectionTitle)
        : '';
    if (!title || !Array.isArray(rawSection.lines)) continue;
    for (const rawLine of rawSection.lines) {
      const v = validateProposedLine(rawLine);
      if (!v.ok) continue; // invalid proposal → dropped, never "fixed up"
      newSuggestions.push({
        ...suggestionEnvelope({
          type: 'quote_draft_line',
          model: completion.model,
          promptVersion: QUOTE_DRAFT_PROMPT_VERSION,
          createdBy: 'system:ai',
        }),
        runId: run.id,
        sectionTitle: title,
        line: v.line,
        uncertainty: v.uncertainty,
      });
    }
  }

  // Re-run: still-'suggested' older suggestions become 'superseded';
  // accepted/edited/rejected history is NEVER rewritten.
  const prior = aiDraftOf(current);
  const carried = prior.suggestions.map((s) => {
    if (!s || s.status !== 'suggested') return s;
    const r = reviewSuggestion(s, { status: 'superseded' });
    return r.ok ? r.record : s;
  });

  // Sections/totals/updatedAt untouched — the aiDraft field is additive
  // metadata and never enters the money math (totals read sections[].lines).
  const next = {
    ...toWire(current),
    aiDraft: { runs: [...prior.runs, run], suggestions: [...carried, ...newSuggestions] },
  };

  try {
    await writeBlob(docKey(id), next, { expectedRev: currentRevOf(current) });
  } catch (err) {
    if (err && err.code === 'stale_write') {
      const latest = await readBlob(docKey(id), null);
      return res.status(409).json({
        error: 'quote changed while drafting — run it again',
        quote: latest ? toWire(latest) : null,
      });
    }
    throw err;
  }

  return res.status(201).json({ quote: next, run });
}

/**
 * POST ?id=X&action=ai-draft-review
 *   body { suggestionId, decision: 'accept'|'edit'|'reject', editedLine?, reviewNote? }
 *
 * accept/edit writes ONE real line into the doc's sections in the SAME atomic
 * doc write: find-or-create the suggestion's section, mint the line at rate 0
 * with source/aiSuggestionId/needsPricing (a price is never invented — the
 * line visibly contributes $0 until the estimator prices it). reject keeps the
 * record ('rejected', auditable). Any decision on a non-'suggested' suggestion
 * → 400, so re-accepting can never duplicate lines.
 */
async function handleAiDraftReview(req, res, user, id) {
  if (!(await isFlagEnabled('ai_quote_drafts', user))) {
    return res.status(404).json({ error: 'not found' });
  }

  const body = req.body || {};
  const suggestionId = typeof body.suggestionId === 'string' ? body.suggestionId : '';
  if (!suggestionId) return res.status(400).json({ error: 'suggestionId required' });

  const DECISION_STATUS = { accept: 'accepted', edit: 'edited', reject: 'rejected' };
  const status = DECISION_STATUS[body.decision];
  if (!status) return res.status(400).json({ error: 'decision must be accept|edit|reject' });

  const reviewNote = validString(body.reviewNote, 'reviewNote', { max: 500 });
  if (reviewNote.error) return res.status(400).json({ error: reviewNote.error });

  const current = await readBlob(docKey(id), null);
  if (!current) return res.status(404).json({ error: 'quote not found' });

  const ai = aiDraftOf(current);
  const idx = ai.suggestions.findIndex((s) => s && s.id === suggestionId);
  if (idx === -1) return res.status(404).json({ error: 'suggestion not found' });
  const suggestion = ai.suggestions[idx];

  let lineContent = suggestion.line;
  let humanCorrection;
  if (body.decision === 'edit') {
    const v = validateProposedLine(body.editedLine);
    if (!v.ok) return res.status(400).json({ error: 'editedLine: ' + v.error });
    lineContent = v.line;
    humanCorrection = { line: v.line };
  }

  const reviewed = reviewSuggestion(suggestion, {
    status,
    reviewedById: user.id || user.username || null,
    reviewedByName: user.name || user.username || null,
    reviewNote: reviewNote.value || null,
    humanCorrection,
  });
  // Covers the terminal-state rule: a second decision on the same suggestion
  // 400s here, so re-accepting can never write a duplicate line.
  if (!reviewed.ok) return res.status(400).json({ error: reviewed.error });

  const writesLine = body.decision === 'accept' || body.decision === 'edit';
  let sections = current.sections;
  let newLine = null;

  if (writesLine) {
    if (!lineContent || !LINE_KINDS.has(lineContent.kind)) {
      return res.status(400).json({ error: 'suggestion has no usable line' });
    }
    sections = current.sections.map((s) => ({ ...s, lines: [...s.lines] }));
    const wanted = String(suggestion.sectionTitle || '').trim();
    let target = sections.find(
      (s) => String(s.title || '').trim().toLowerCase() === wanted.toLowerCase()
    );
    if (!target) {
      if (sections.length >= LIMITS.maxSections) {
        return res.status(400).json({ error: `sections: ${LIMITS.maxSections} max` });
      }
      target = {
        id: uid('qsec'),
        title: (wanted || 'AI draft').slice(0, LIMITS.maxSectionTitle),
        sortOrder: sections.length,
        lines: [],
      };
      sections.push(target);
    }
    if (target.lines.length >= LIMITS.maxLinesPerSection) {
      return res.status(400).json({ error: `sections lines: ${LIMITS.maxLinesPerSection} max` });
    }
    newLine = {
      id: uid('qline'),
      kind: lineContent.kind,
      description: lineContent.description,
      // qty null means the scope gave NO quantity — land at the honest 0,
      // never an invented count.
      qty: lineContent.qty === null || lineContent.qty === undefined ? 0 : lineContent.qty,
      unit: lineContent.unit === null || lineContent.unit === undefined ? '' : lineContent.unit,
      rate: 0, // NEVER an invented price — needsPricing flags it for the estimator
      source: 'ai_suggested',
      aiSuggestionId: suggestion.id,
      needsPricing: true,
    };
    target.lines.push(newLine);
  }

  const suggestions = [...ai.suggestions];
  suggestions[idx] = reviewed.record;

  const next = {
    ...toWire(current),
    sections,
    totals: computeQuoteTotals(sections),
    // reject is metadata-only: sections/updatedAt untouched so an open
    // builder tab's save precondition survives a discard.
    ...(writesLine ? { updatedAt: new Date().toISOString() } : {}),
    aiDraft: { runs: ai.runs, suggestions },
  };

  try {
    await writeBlob(docKey(id), next, { expectedRev: currentRevOf(current) });
  } catch (err) {
    if (err && err.code === 'stale_write') {
      const latest = await readBlob(docKey(id), null);
      return res.status(409).json({
        error: 'quote changed since you loaded it',
        quote: latest ? toWire(latest) : null,
      });
    }
    throw err;
  }

  if (writesLine) await upsertRegistryRow(next); // lineCount changed

  return res.status(200).json({ quote: next, ...(newLine ? { line: newLine } : {}) });
}

// ── Router ───────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await isFlagEnabled('quotes', user))) return res.status(404).json({ error: 'not found' });
  // Quoting is commercial — admin TIER only (boss/owner/manager/office/pm/
  // estimator all pass; field, LH and client roles never do).
  if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin tier only' });

  const id = (req.query && req.query.id) || '';

  const action = (req.query && req.query.action) || '';

  if (req.method === 'GET') return id ? handleGet(req, res, id) : handleList(req, res);
  if (req.method === 'POST') {
    // #246 — AI draft actions live on the quote document, so id is required.
    if (action === 'ai-draft' || action === 'ai-draft-review') {
      if (!id) return res.status(400).json({ error: 'id required' });
      return action === 'ai-draft'
        ? handleAiDraft(req, res, user, id)
        : handleAiDraftReview(req, res, user, id);
    }
    if (action) return res.status(400).json({ error: 'unknown action' });
    return handleCreate(req, res, user);
  }
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
// Exposed for the #511 registry-roll-up concurrency test.
module.exports.__test = { upsertRegistryRow, readRegistry };
// Shared store surface for the workbook importer (#365): api/job-doc-import.js
// attaches an imported BOQ to a v2 quote through these SAME helpers (one doc
// writer convention, one registry upsert, one totals rule) — never a second
// hand-rolled copy of the quote storage model.
module.exports.store = {
  REGISTRY_KEY,
  docKey,
  readRegistry,
  upsertRegistryRow,
  currentRevOf,
  toWire,
  computeQuoteTotals,
  uid,
  LIMITS,
};
