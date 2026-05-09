// Tenders / Quotes / Estimating — Phase 1 foundation.
//
// Single endpoint with action-based routing covering everything except
// document file uploads (handled by /api/quote-documents.js).
//
// Storage:
//   quotes.json                                       → master index
//   quotes/<quoteId>/structure.json                   → area groups + work packages
//   quotes/<quoteId>/materials-estimate.json          → materials list (estimate)
//   quotes/<quoteId>/labour-estimate.json             → labour estimate lines
//   quotes/<quoteId>/notes.json                       → assumptions / risks / exclusions
//   quotes/<quoteId>/ai-review.json                   → AI-assisted review suggestions
//
// Routing:
//   GET    /api/quotes                                → list quotes (admin)
//   POST   /api/quotes                                → create quote (admin)
//   GET    /api/quotes?id=<quoteId>                   → full bundle (basics + all sections)
//   PATCH  /api/quotes?id=<quoteId>                   → update basics / status
//   DELETE /api/quotes?id=<quoteId>                   → soft-archive
//
//   GET    /api/quotes?id=<quoteId>&action=structure  → area groups
//   PATCH  /api/quotes?id=<quoteId>&action=structure  → save areaGroups (full replace)
//
//   GET    /api/quotes?id=<quoteId>&action=materials  → list
//   POST   /api/quotes?id=<quoteId>&action=materials  → add (or bulk via {lines:[]})
//   PATCH  /api/quotes?id=<quoteId>&action=materials&itemId=X
//   DELETE /api/quotes?id=<quoteId>&action=materials&itemId=X
//
//   GET    /api/quotes?id=<quoteId>&action=labour     → list
//   POST   /api/quotes?id=<quoteId>&action=labour     → add
//   PATCH  /api/quotes?id=<quoteId>&action=labour&lineId=X
//   DELETE /api/quotes?id=<quoteId>&action=labour&lineId=X
//
//   GET    /api/quotes?id=<quoteId>&action=notes      → { assumptions, exclusions, risks, clarifications }
//   PATCH  /api/quotes?id=<quoteId>&action=notes      → save full notes object
//
//   POST   /api/quotes?id=<quoteId>&action=ai-review  → run / save AI suggestions
//                                                       body: { sourceText, sourceDocumentIds }
//   GET    /api/quotes?id=<quoteId>&action=ai-review  → read latest review
//
//   POST   /api/quotes?id=<quoteId>&action=convert    → convert to live job
//                                                       body: { copyDocuments?: bool }
//                                                       returns { jobId }
//
//   GET    /api/quotes?id=<quoteId>&action=pricing    → pricing settings object
//   PATCH  /api/quotes?id=<quoteId>&action=pricing    → save pricing settings
//                                                       body: { materialMarkupPct,
//                                                               labourSellRate, labourCostMode,
//                                                               labourCostRate, contingencyPct,
//                                                               gstPct, validityDays,
//                                                               overrideTotalExGst }
//
//   GET    /api/quotes?id=<quoteId>&action=provisional → list { items: [] }
//   POST   /api/quotes?id=<quoteId>&action=provisional → add (PS or allowance)
//                                                        body: { kind, name, amountExGst, ... }
//   PATCH  /api/quotes?id=<quoteId>&action=provisional&itemId=X
//   DELETE /api/quotes?id=<quoteId>&action=provisional&itemId=X
//
//   GET    /api/quotes?id=<quoteId>&action=totals     → computed roll-up
//                                                       { totals: { materials, labour,
//                                                                   provisional, contingency,
//                                                                   subtotalExGst, gst,
//                                                                   totalIncGst, margin } }
//
// Permissions: admin only on writes; admin/LH for read (LH read kept off
// for v1 — quoting is admin-facing). Tradies + clients always 403.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const VALID_STATUSES = [
  'draft', 'reviewing', 'estimating', 'submitted',
  'won', 'lost', 'declined', 'converted_to_job', 'archived',
];

const QUOTES_KEY = 'quotes.json';

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function readQuotes() {
  return await readBlob(QUOTES_KEY, { quotes: [] });
}
async function writeQuotes(data) {
  await writeBlob(QUOTES_KEY, data);
}

const SECTION_KEYS = {
  structure:    q => 'quotes/' + q + '/structure.json',
  materials:    q => 'quotes/' + q + '/materials-estimate.json',
  labour:       q => 'quotes/' + q + '/labour-estimate.json',
  notes:        q => 'quotes/' + q + '/notes.json',
  ai:           q => 'quotes/' + q + '/ai-review.json',
  documents:    q => 'quotes/' + q + '/documents-index.json',
  pricing:      q => 'quotes/' + q + '/pricing.json',
  provisional:  q => 'quotes/' + q + '/provisional.json',
};

const PRICING_DEFAULTS = {
  // Per-category markup applied to materials cost when computing sell price.
  // Keys are category names; "default" is the fallback for items without a
  // matching category override.
  materialMarkupPct: { default: 25 },
  // Hourly rate billed to the client for labour. Cost rate per line still
  // comes from the labour line itself (hourlyRate) when present; sellRate
  // is what the client sees on the printed quote.
  labourSellRate: 95,
  // Whether labour cost is computed line-by-line (using each line's
  // hourlyRate) or via a single shared cost rate (labourCostRate).
  labourCostMode: 'per-line', // 'per-line' | 'shared'
  labourCostRate: 65,
  // Fixed overhead/contingency added on top of subtotal-of-cost-marked-up.
  contingencyPct: 0,
  // GST rate (Australia: 10%). Applied to subtotal.
  gstPct: 10,
  // Quote validity (days) — printed on the client document.
  validityDays: 30,
  // Override total — when set, replaces the computed total (e.g. negotiated).
  overrideTotalExGst: null,
};

const SECTION_DEFAULTS = {
  structure:   { areaGroups: [] },
  materials:   { items: [] },
  labour:      { lines: [] },
  notes:       { assumptions: [], exclusions: [], risks: [], clarifications: [] },
  ai:          { reviews: [] },
  documents:   { documents: [] },
  pricing:     PRICING_DEFAULTS,
  provisional: { items: [] },
};

async function readSection(quoteId, key) {
  return await readBlob(SECTION_KEYS[key](quoteId), SECTION_DEFAULTS[key]);
}
async function writeSection(quoteId, key, data) {
  await writeBlob(SECTION_KEYS[key](quoteId), data);
}

// ── Handlers ─────────────────────────────────────────────────────────────

async function handleListQuotes(req, res, user) {
  const data = await readQuotes();
  const includeArchived = req.query && req.query.includeArchived === '1';
  let quotes = data.quotes || [];
  if (!includeArchived) quotes = quotes.filter(q => q.status !== 'archived');
  // Enrich each with cheap counts pulled from section files. Done in
  // parallel; tolerates missing section files.
  const enriched = await Promise.all(quotes.map(async q => {
    const [docs, mat, lab] = await Promise.all([
      readSection(q.id, 'documents').catch(() => SECTION_DEFAULTS.documents),
      readSection(q.id, 'materials').catch(() => SECTION_DEFAULTS.materials),
      readSection(q.id, 'labour').catch(() => SECTION_DEFAULTS.labour),
    ]);
    return {
      ...q,
      counts: {
        documents: (docs.documents || []).filter(d => d.status !== 'archived').length,
        materials: (mat.items || []).length,
        labourLines: (lab.lines || []).length,
        labourHours: (lab.lines || []).reduce((s, l) => s + (Number(l.estimatedHours) || 0), 0),
      },
    };
  }));
  return res.status(200).json({ quotes: enriched });
}

async function handleCreateQuote(req, res, user) {
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const data = await readQuotes();
  data.quotes = data.quotes || [];
  const now = new Date().toISOString();
  const quote = {
    id:              newId('quote'),
    name:            String(body.name).trim(),
    builder:         body.builder ? String(body.builder).trim() : '',
    contactName:     body.contactName ? String(body.contactName).trim() : '',
    contactEmail:    body.contactEmail ? String(body.contactEmail).trim() : '',
    contactPhone:    body.contactPhone ? String(body.contactPhone).trim() : '',
    siteAddress:     body.siteAddress ? String(body.siteAddress).trim() : '',
    dueDate:         body.dueDate || '',
    expectedStartDate: body.expectedStartDate || '',
    jobType:         body.jobType ? String(body.jobType).trim() : '',
    description:     body.description ? String(body.description).trim() : '',
    status:          (body.status && VALID_STATUSES.includes(body.status)) ? body.status : 'draft',
    notes:           body.notes ? String(body.notes).trim() : '',
    convertedJobId:  null,
    createdAt:       now,
    createdBy:       user.username,
    updatedAt:       now,
  };
  data.quotes.push(quote);
  await writeQuotes(data);
  return res.status(201).json({ quote });
}

async function handleGetQuote(req, res, user) {
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = await readQuotes();
  const quote = (data.quotes || []).find(q => q.id === id);
  if (!quote) return res.status(404).json({ error: 'not found' });
  // Bundle every section in parallel for the workspace.
  const [structure, materials, labour, notes, ai, documents, pricing, provisional] = await Promise.all([
    readSection(id, 'structure'),
    readSection(id, 'materials'),
    readSection(id, 'labour'),
    readSection(id, 'notes'),
    readSection(id, 'ai'),
    readSection(id, 'documents'),
    readSection(id, 'pricing'),
    readSection(id, 'provisional'),
  ]);
  // Pre-compute totals for the bundle so the client doesn't need a second
  // round-trip on workspace open.
  const totals = computeQuoteTotals({ pricing, materials, labour, provisional });
  return res.status(200).json({
    quote, structure, materials, labour, notes, ai, documents,
    pricing, provisional, totals,
  });
}

async function handleUpdateQuote(req, res, user) {
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const body = req.body || {};
  const data = await readQuotes();
  const idx = (data.quotes || []).findIndex(q => q.id === id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const editable = ['name', 'builder', 'contactName', 'contactEmail', 'contactPhone',
                    'siteAddress', 'dueDate', 'expectedStartDate', 'jobType',
                    'description', 'notes'];
  for (const k of editable) {
    if (body[k] !== undefined) data.quotes[idx][k] = String(body[k] || '').trim();
  }
  if (body.status && VALID_STATUSES.includes(body.status)) {
    data.quotes[idx].status = body.status;
  }
  data.quotes[idx].updatedAt = new Date().toISOString();
  await writeQuotes(data);
  return res.status(200).json({ quote: data.quotes[idx] });
}

async function handleArchiveQuote(req, res, user) {
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = await readQuotes();
  const idx = (data.quotes || []).findIndex(q => q.id === id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  data.quotes[idx].status = 'archived';
  data.quotes[idx].updatedAt = new Date().toISOString();
  await writeQuotes(data);
  return res.status(200).json({ ok: true });
}

// ── Section: structure ───────────────────────────────────────────────────
async function handleStructureGet(req, res, user, id) {
  const s = await readSection(id, 'structure');
  return res.status(200).json(s);
}
async function handleStructureSet(req, res, user, id) {
  const body = req.body || {};
  if (!Array.isArray(body.areaGroups)) {
    return res.status(400).json({ error: 'areaGroups array required' });
  }
  // Sanitise: each group needs id + name; areas need id + name; workPackages
  // optional. Generate ids server-side if missing.
  const cleaned = body.areaGroups.map(g => ({
    id: g.id || newId('qag'),
    name: String(g.name || '').trim(),
    areas: Array.isArray(g.areas) ? g.areas.map(a => ({
      id: a.id || newId('qar'),
      name: String(a.name || '').trim(),
      workPackages: Array.isArray(a.workPackages) ? a.workPackages.map(wp => ({
        name: String(wp.name || '').trim(),
        stage: wp.stage === 'fit-off' ? 'fit-off' : 'rough-in',
        tasks: Array.isArray(wp.tasks) ? wp.tasks.map(t => String(t || '').trim()).filter(Boolean) : [],
      })) : [],
    })) : [],
  }));
  await writeSection(id, 'structure', { areaGroups: cleaned });
  await touchQuote(id);
  return res.status(200).json({ areaGroups: cleaned });
}

// ── Section: materials ───────────────────────────────────────────────────
async function handleMaterialsAdd(req, res, user, id) {
  const body = req.body || {};
  const data = await readSection(id, 'materials');
  data.items = data.items || [];

  if (Array.isArray(body.lines)) {
    // Bulk add: each line is parsed via the same shape as POST.
    const created = [];
    for (const raw of body.lines) {
      if (!raw || !raw.name) continue;
      created.push(_buildMaterial(raw, user, id));
    }
    data.items.push(...created);
    await writeSection(id, 'materials', data);
    await touchQuote(id);
    return res.status(201).json({ items: created });
  }

  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const item = _buildMaterial(body, user, id);
  data.items.push(item);
  await writeSection(id, 'materials', data);
  await touchQuote(id);
  return res.status(201).json({ item });
}

function _buildMaterial(body, user, quoteId) {
  const now = new Date().toISOString();
  return {
    id:            newId('qmat'),
    quoteId,
    name:          String(body.name || '').trim(),
    description:   body.description ? String(body.description).trim() : '',
    category:      body.category ? String(body.category).trim() : 'Other',
    subcategory:   body.subcategory ? String(body.subcategory).trim() : '',
    quantity:      body.quantity != null ? Number(body.quantity) : 1,
    unit:          body.unit ? String(body.unit).trim() : 'each',
    brandOrSpec:   body.brandOrSpec ? String(body.brandOrSpec).trim() : '',
    drawingRef:    body.drawingRef ? String(body.drawingRef).trim() : '',
    documentId:    body.documentId ? String(body.documentId).trim() : '',
    level:         body.level ? String(body.level).trim() : '',
    area:          body.area ? String(body.area).trim() : '',
    source:        ['manual', 'ai_suggested', 'imported'].includes(body.source) ? body.source : 'manual',
    confidence:    ['low', 'medium', 'high'].includes(body.confidence) ? body.confidence : 'medium',
    unitCost:      body.unitCost != null ? Number(body.unitCost) : null,
    totalCost:     body.totalCost != null ? Number(body.totalCost) : null,
    notes:         body.notes ? String(body.notes).trim() : '',
    status:        body.status || 'draft',
    createdAt:     now,
    createdBy:     user.username,
    updatedAt:     now,
  };
}

async function handleMaterialsUpdate(req, res, user, id) {
  const itemId = req.query && req.query.itemId;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  const body = req.body || {};
  const data = await readSection(id, 'materials');
  const idx = (data.items || []).findIndex(i => i.id === itemId);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const editable = ['name', 'description', 'category', 'subcategory', 'quantity',
                    'unit', 'brandOrSpec', 'drawingRef', 'documentId', 'level',
                    'area', 'confidence', 'unitCost', 'totalCost', 'notes', 'status'];
  for (const k of editable) {
    if (body[k] !== undefined) data.items[idx][k] = body[k];
  }
  data.items[idx].updatedAt = new Date().toISOString();
  await writeSection(id, 'materials', data);
  await touchQuote(id);
  return res.status(200).json({ item: data.items[idx] });
}

async function handleMaterialsDelete(req, res, user, id) {
  const itemId = req.query && req.query.itemId;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  const data = await readSection(id, 'materials');
  data.items = (data.items || []).filter(i => i.id !== itemId);
  await writeSection(id, 'materials', data);
  await touchQuote(id);
  return res.status(200).json({ ok: true });
}

// ── Section: labour ──────────────────────────────────────────────────────
async function handleLabourAdd(req, res, user, id) {
  const body = req.body || {};
  if (!body.task || !String(body.task).trim()) {
    return res.status(400).json({ error: 'task required' });
  }
  const data = await readSection(id, 'labour');
  data.lines = data.lines || [];
  const now = new Date().toISOString();
  const line = {
    id:               newId('qlab'),
    quoteId:          id,
    areaGroup:        body.areaGroup ? String(body.areaGroup).trim() : '',
    area:             body.area ? String(body.area).trim() : '',
    system:           body.system ? String(body.system).trim() : '',
    stage:            body.stage === 'fit-off' ? 'fit-off' : 'rough-in',
    task:             String(body.task).trim(),
    estimatedHours:   body.estimatedHours != null ? Number(body.estimatedHours) : 0,
    crewSize:         body.crewSize != null ? Number(body.crewSize) : 1,
    rateType:         body.rateType ? String(body.rateType).trim() : 'standard',
    hourlyRate:       body.hourlyRate != null ? Number(body.hourlyRate) : null,
    difficulty:       body.difficulty ? String(body.difficulty).trim() : 'normal',
    riskFactor:       body.riskFactor != null ? Number(body.riskFactor) : 1.0,
    notes:            body.notes ? String(body.notes).trim() : '',
    source:           ['manual', 'ai_suggested', 'imported'].includes(body.source) ? body.source : 'manual',
    createdAt:        now,
    updatedAt:        now,
  };
  data.lines.push(line);
  await writeSection(id, 'labour', data);
  await touchQuote(id);
  return res.status(201).json({ line });
}

async function handleLabourUpdate(req, res, user, id) {
  const lineId = req.query && req.query.lineId;
  if (!lineId) return res.status(400).json({ error: 'lineId required' });
  const body = req.body || {};
  const data = await readSection(id, 'labour');
  const idx = (data.lines || []).findIndex(l => l.id === lineId);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const editable = ['areaGroup', 'area', 'system', 'stage', 'task', 'estimatedHours',
                    'crewSize', 'rateType', 'hourlyRate', 'difficulty', 'riskFactor', 'notes'];
  for (const k of editable) {
    if (body[k] !== undefined) data.lines[idx][k] = body[k];
  }
  data.lines[idx].updatedAt = new Date().toISOString();
  await writeSection(id, 'labour', data);
  await touchQuote(id);
  return res.status(200).json({ line: data.lines[idx] });
}

async function handleLabourDelete(req, res, user, id) {
  const lineId = req.query && req.query.lineId;
  if (!lineId) return res.status(400).json({ error: 'lineId required' });
  const data = await readSection(id, 'labour');
  data.lines = (data.lines || []).filter(l => l.id !== lineId);
  await writeSection(id, 'labour', data);
  await touchQuote(id);
  return res.status(200).json({ ok: true });
}

// ── Section: notes (assumptions / exclusions / risks / clarifications) ───
async function handleNotesGet(req, res, user, id) {
  const n = await readSection(id, 'notes');
  return res.status(200).json(n);
}
async function handleNotesSet(req, res, user, id) {
  const body = req.body || {};
  const cleanArr = a => Array.isArray(a) ? a.map(s => String(s || '').trim()).filter(Boolean) : [];
  const out = {
    assumptions:    cleanArr(body.assumptions),
    exclusions:     cleanArr(body.exclusions),
    risks:          cleanArr(body.risks),
    clarifications: cleanArr(body.clarifications),
  };
  await writeSection(id, 'notes', out);
  await touchQuote(id);
  return res.status(200).json(out);
}

// ── Section: pricing settings ────────────────────────────────────────────
// Stored as a single object (not a list). Defines how cost lines roll up
// into a sell-side total: per-category material markup, labour sell rate,
// labour cost mode, contingency %, GST %, validity, and an optional
// override total for negotiated quotes.

async function handlePricingGet(req, res, user, id) {
  const p = await readSection(id, 'pricing');
  return res.status(200).json({ pricing: p });
}

async function handlePricingSet(req, res, user, id) {
  const body = req.body || {};
  const cur = await readSection(id, 'pricing');
  // Sanitise + merge — never let a stray field clobber existing data.
  const out = Object.assign({}, cur);
  if (body.materialMarkupPct && typeof body.materialMarkupPct === 'object') {
    const clean = {};
    for (const k of Object.keys(body.materialMarkupPct)) {
      const v = Number(body.materialMarkupPct[k]);
      if (isFinite(v) && v >= -50 && v <= 500) clean[String(k).trim() || 'default'] = v;
    }
    if (!clean.default) clean.default = (cur.materialMarkupPct && cur.materialMarkupPct.default) || 25;
    out.materialMarkupPct = clean;
  }
  if (body.labourSellRate != null) {
    const v = Number(body.labourSellRate);
    if (isFinite(v) && v >= 0 && v <= 1000) out.labourSellRate = v;
  }
  if (body.labourCostMode && ['per-line', 'shared'].includes(body.labourCostMode)) {
    out.labourCostMode = body.labourCostMode;
  }
  if (body.labourCostRate != null) {
    const v = Number(body.labourCostRate);
    if (isFinite(v) && v >= 0 && v <= 1000) out.labourCostRate = v;
  }
  if (body.contingencyPct != null) {
    const v = Number(body.contingencyPct);
    if (isFinite(v) && v >= 0 && v <= 50) out.contingencyPct = v;
  }
  if (body.gstPct != null) {
    const v = Number(body.gstPct);
    if (isFinite(v) && v >= 0 && v <= 30) out.gstPct = v;
  }
  if (body.validityDays != null) {
    const v = Number(body.validityDays);
    if (isFinite(v) && v >= 1 && v <= 365) out.validityDays = Math.round(v);
  }
  if (body.overrideTotalExGst === null || body.overrideTotalExGst === '') {
    out.overrideTotalExGst = null;
  } else if (body.overrideTotalExGst !== undefined) {
    const v = Number(body.overrideTotalExGst);
    if (isFinite(v) && v >= 0) out.overrideTotalExGst = v;
  }
  await writeSection(id, 'pricing', out);
  await touchQuote(id);
  return res.status(200).json({ pricing: out });
}

// ── Section: provisional sums + allowances ───────────────────────────────
// PS items are dollar amounts the contractor bills the client without
// going through cost+markup — typical for items the client will choose
// later (e.g. light fittings client-supplied) or scoped allowances.

async function handleProvisionalGet(req, res, user, id) {
  const p = await readSection(id, 'provisional');
  return res.status(200).json(p);
}

async function handleProvisionalAdd(req, res, user, id) {
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const data = await readSection(id, 'provisional');
  data.items = data.items || [];
  const now = new Date().toISOString();
  const item = {
    id:          newId('qps'),
    quoteId:     id,
    kind:        body.kind === 'allowance' ? 'allowance' : 'provisional',
    name:        String(body.name).trim(),
    description: body.description ? String(body.description).trim() : '',
    amountExGst: body.amountExGst != null ? Number(body.amountExGst) : 0,
    notes:       body.notes ? String(body.notes).trim() : '',
    createdAt:   now,
    createdBy:   user.username,
    updatedAt:   now,
  };
  data.items.push(item);
  await writeSection(id, 'provisional', data);
  await touchQuote(id);
  return res.status(201).json({ item });
}

async function handleProvisionalUpdate(req, res, user, id) {
  const itemId = req.query && req.query.itemId;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  const body = req.body || {};
  const data = await readSection(id, 'provisional');
  const idx = (data.items || []).findIndex(i => i.id === itemId);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const editable = ['kind', 'name', 'description', 'amountExGst', 'notes'];
  for (const k of editable) {
    if (body[k] !== undefined) {
      if (k === 'amountExGst') data.items[idx][k] = Number(body[k]);
      else if (k === 'kind') data.items[idx][k] = body[k] === 'allowance' ? 'allowance' : 'provisional';
      else data.items[idx][k] = String(body[k] || '').trim();
    }
  }
  data.items[idx].updatedAt = new Date().toISOString();
  await writeSection(id, 'provisional', data);
  await touchQuote(id);
  return res.status(200).json({ item: data.items[idx] });
}

async function handleProvisionalDelete(req, res, user, id) {
  const itemId = req.query && req.query.itemId;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  const data = await readSection(id, 'provisional');
  data.items = (data.items || []).filter(i => i.id !== itemId);
  await writeSection(id, 'provisional', data);
  await touchQuote(id);
  return res.status(200).json({ ok: true });
}

// ── Totals computation (pure function — also used by the bundle) ─────────
function computeQuoteTotals({ pricing, materials, labour, provisional }) {
  const p = Object.assign({}, PRICING_DEFAULTS, pricing || {});
  const items = (materials && materials.items) || [];
  const lines = (labour && labour.lines) || [];
  const psItems = (provisional && provisional.items) || [];
  const markupTbl = p.materialMarkupPct || { default: 25 };
  const defaultMarkup = Number(markupTbl.default) || 0;

  // Materials cost + sell
  let matCost = 0, matSell = 0;
  const matBreakdown = {};
  for (const m of items) {
    const qty = Number(m.quantity) || 0;
    const lineCost = (m.totalCost != null && Number(m.totalCost)) ||
                     (m.unitCost != null ? Number(m.unitCost) * qty : 0);
    if (!isFinite(lineCost)) continue;
    const cat = String(m.category || 'Other');
    const markup = (markupTbl[cat] != null) ? Number(markupTbl[cat]) : defaultMarkup;
    const lineSell = lineCost * (1 + markup / 100);
    matCost += lineCost;
    matSell += lineSell;
    if (!matBreakdown[cat]) matBreakdown[cat] = { cost: 0, sell: 0, count: 0, markupPct: markup };
    matBreakdown[cat].cost += lineCost;
    matBreakdown[cat].sell += lineSell;
    matBreakdown[cat].count += 1;
  }

  // Labour cost + sell
  let labHours = 0, labCost = 0, labSell = 0;
  for (const l of lines) {
    const hours = (Number(l.estimatedHours) || 0) * (Number(l.crewSize) || 1);
    const risk = Number(l.riskFactor) || 1.0;
    const adjHours = hours * risk;
    labHours += adjHours;
    const costRate = (p.labourCostMode === 'shared')
      ? Number(p.labourCostRate)
      : (l.hourlyRate != null ? Number(l.hourlyRate) : Number(p.labourCostRate));
    if (isFinite(costRate)) labCost += adjHours * costRate;
    const sellRate = Number(p.labourSellRate);
    if (isFinite(sellRate)) labSell += adjHours * sellRate;
  }

  // Provisional sums + allowances (not marked up — billed at face value)
  let psTotal = 0;
  for (const ps of psItems) {
    const a = Number(ps.amountExGst) || 0;
    if (isFinite(a)) psTotal += a;
  }

  // Subtotal-of-sell + contingency
  const subBeforeContingency = matSell + labSell + psTotal;
  const contingencyPct = Number(p.contingencyPct) || 0;
  const contingency = subBeforeContingency * (contingencyPct / 100);

  let subtotalExGst = subBeforeContingency + contingency;
  let overridden = false;
  if (p.overrideTotalExGst != null && isFinite(Number(p.overrideTotalExGst))) {
    subtotalExGst = Number(p.overrideTotalExGst);
    overridden = true;
  }

  const gstPct = Number(p.gstPct) || 0;
  const gst = subtotalExGst * (gstPct / 100);
  const totalIncGst = subtotalExGst + gst;

  // Margin (sell - cost across materials + labour); PS is excluded since
  // we don't book a markup against it.
  const totalCost = matCost + labCost;
  const totalSell = matSell + labSell;
  const marginAmount = totalSell - totalCost;
  const marginPct = totalSell > 0 ? (marginAmount / totalSell) * 100 : 0;

  return {
    materials: {
      cost: round2(matCost),
      sell: round2(matSell),
      breakdown: Object.keys(matBreakdown).map(k => ({
        category: k,
        cost: round2(matBreakdown[k].cost),
        sell: round2(matBreakdown[k].sell),
        markupPct: matBreakdown[k].markupPct,
        count: matBreakdown[k].count,
      })),
    },
    labour: {
      hours: round2(labHours),
      cost:  round2(labCost),
      sell:  round2(labSell),
      sellRate: Number(p.labourSellRate) || 0,
    },
    provisional: {
      total: round2(psTotal),
      count: psItems.length,
    },
    contingency: {
      pct:    contingencyPct,
      amount: round2(contingency),
    },
    subtotalExGst: round2(subtotalExGst),
    gstPct,
    gst:           round2(gst),
    totalIncGst:   round2(totalIncGst),
    totalCost:     round2(totalCost),
    totalSell:     round2(totalSell),
    margin: {
      amount: round2(marginAmount),
      pct:    round1(marginPct),
    },
    overridden,
  };
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

async function handleTotals(req, res, user, id) {
  const [pricing, materials, labour, provisional] = await Promise.all([
    readSection(id, 'pricing'),
    readSection(id, 'materials'),
    readSection(id, 'labour'),
    readSection(id, 'provisional'),
  ]);
  return res.status(200).json({ totals: computeQuoteTotals({ pricing, materials, labour, provisional }) });
}

// ── Section: AI review ───────────────────────────────────────────────────
// V1 implementation: server-side stub that accepts pasted scope text and
// either calls Anthropic (if ANTHROPIC_API_KEY is set) or falls back to a
// "review queued — paste applied" record. AI output is always saved as
// suggestions only; the admin must accept/edit/discard before any of it
// reaches the live structure/materials/labour data.

async function handleAiGet(req, res, user, id) {
  const ai = await readSection(id, 'ai');
  return res.status(200).json(ai);
}

async function handleAiRun(req, res, user, id) {
  const body = req.body || {};
  const sourceText = (body.sourceText || '').trim();
  if (!sourceText) return res.status(400).json({ error: 'sourceText required (paste scope/spec text)' });

  const ai = await readSection(id, 'ai');
  ai.reviews = ai.reviews || [];

  const review = {
    id:                newId('air'),
    createdAt:         new Date().toISOString(),
    createdBy:         user.username,
    sourceDocumentIds: Array.isArray(body.sourceDocumentIds) ? body.sourceDocumentIds : [],
    status:            'needs_review',
    summary:           '',
    suggestedAreaGroups: [],
    suggestedSystems:    [],
    suggestedTasks:      { roughIn: [], fitOff: [] },
    suggestedMaterials:  [],
    risks:               [],
    assumptions:         [],
    rawModelNotes:       '',
  };

  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (apiKey) {
    try {
      const out = await _callAnthropic(apiKey, sourceText);
      Object.assign(review, out);
    } catch (e) {
      review.rawModelNotes = 'Anthropic call failed: ' + (e.message || String(e)) +
                             '. Pasted text is preserved; admin can re-run or fill in manually.';
    }
  } else {
    review.rawModelNotes =
      'AI not configured (ANTHROPIC_API_KEY not set). Paste preserved for manual review.';
    review.summary = sourceText.slice(0, 280) +
                     (sourceText.length > 280 ? '…' : '');
  }

  ai.reviews.push(review);
  await writeSection(id, 'ai', ai);
  await touchQuote(id);
  return res.status(201).json({ review });
}

// Anthropic call — server-side only, never exposed to the client. Asks for
// strict JSON. If parsing fails, drops back to summary-only output.
async function _callAnthropic(apiKey, sourceText) {
  const prompt =
    'You are an Australian commercial-electrical estimator helping summarise a tender scope. ' +
    'Read the scope text and reply with STRICT JSON only — no prose around it — using this shape:\n' +
    '{\n' +
    '  "summary": "1-2 sentence project summary",\n' +
    '  "suggestedAreaGroups": [{"name":"...","areas":["...","..."]}],\n' +
    '  "suggestedSystems": ["Lighting","Power","Data"],\n' +
    '  "suggestedTasks": {"roughIn":["..."],"fitOff":["..."]},\n' +
    '  "suggestedMaterials": [{"name":"Twin GPO","category":"Power","quantity":null,"confidence":"low","notes":"..."}],\n' +
    '  "risks": ["..."],\n' +
    '  "assumptions": ["..."]\n' +
    '}\n' +
    'Use Australian construction language. Keep quantities null unless explicitly given.\n\n' +
    'Scope text:\n' + sourceText.slice(0, 12000);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Anthropic ' + r.status + ': ' + txt.slice(0, 400));
  }
  const j = await r.json();
  const text = (j.content && j.content[0] && j.content[0].text) || '';
  // Extract first { … } block in case the model wrapped JSON in prose.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { summary: text.slice(0, 280), rawModelNotes: 'No JSON in response.' };
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch (e) { return { summary: text.slice(0, 280), rawModelNotes: 'Could not parse JSON: ' + e.message }; }
  return {
    summary:             parsed.summary || '',
    suggestedAreaGroups: Array.isArray(parsed.suggestedAreaGroups) ? parsed.suggestedAreaGroups : [],
    suggestedSystems:    Array.isArray(parsed.suggestedSystems) ? parsed.suggestedSystems : [],
    suggestedTasks:      parsed.suggestedTasks || { roughIn: [], fitOff: [] },
    suggestedMaterials:  Array.isArray(parsed.suggestedMaterials) ? parsed.suggestedMaterials : [],
    risks:               Array.isArray(parsed.risks) ? parsed.risks : [],
    assumptions:         Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    rawModelNotes:       '',
  };
}

// ── Convert won quote → live job ─────────────────────────────────────────
async function handleConvert(req, res, user, id) {
  const data = await readQuotes();
  const qIdx = (data.quotes || []).findIndex(q => q.id === id);
  if (qIdx < 0) return res.status(404).json({ error: 'quote not found' });
  const quote = data.quotes[qIdx];
  if (quote.convertedJobId) {
    return res.status(409).json({
      error: 'already converted',
      convertedJobId: quote.convertedJobId,
    });
  }
  if (quote.status === 'lost' || quote.status === 'declined' || quote.status === 'archived') {
    return res.status(409).json({ error: 'cannot convert from status ' + quote.status });
  }

  // Read structure + labour for area/task derivation, and materials so we
  // can hand them off to the materials-list seed.
  const [structure, materials, labour, notes] = await Promise.all([
    readSection(id, 'structure'),
    readSection(id, 'materials'),
    readSection(id, 'labour'),
    readSection(id, 'notes'),
  ]);

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  jobsBlob.jobs = jobsBlob.jobs || [];

  // Derive a job id from the quote name. Mirrors the existing /admin
  // create-job pattern: lowercase, hyphenated, with a short random suffix
  // for collision resistance.
  const slug = String(quote.name || 'job')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  let jobId = slug || 'job';
  let suffix = '';
  while (jobsBlob.jobs.find(j => j.id === (jobId + suffix))) {
    suffix = '-' + Math.random().toString(36).slice(2, 5);
  }
  jobId = jobId + suffix;

  // Map quote area groups into the live job shape. The tradie task UI
  // still uses the unioned global rough-in/fit-off task lists below, but
  // we also preserve the area-specific workPackages on each area so the
  // future "custom checklists per area" feature has the data to work
  // from without a re-convert. Existing live-job consumers ignore the
  // extra field (it's lazy-tolerated everywhere).
  const areaGroups = (structure.areaGroups || []).map(g => ({
    id:    'g_' + Math.random().toString(36).slice(2, 8),
    name:  g.name,
    areas: (g.areas || []).map(a => ({
      id:   'a_' + Math.random().toString(36).slice(2, 8),
      name: a.name,
      workPackages: Array.isArray(a.workPackages)
        ? a.workPackages.map(wp => ({
            name: wp.name || '',
            stage: wp.stage === 'fit-off' ? 'fit-off' : 'rough-in',
            tasks: Array.isArray(wp.tasks) ? wp.tasks.slice() : [],
          }))
        : [],
    })),
  }));

  // Distill rough-in / fit-off tasks: union across every area's work
  // packages. Admin can refine in Job Setup afterwards.
  const roughSet = new Set();
  const fitSet   = new Set();
  for (const g of (structure.areaGroups || [])) {
    for (const a of (g.areas || [])) {
      for (const wp of (a.workPackages || [])) {
        const target = wp.stage === 'fit-off' ? fitSet : roughSet;
        for (const t of (wp.tasks || [])) target.add(t);
      }
    }
  }
  const roughInTasks = [...roughSet].map(name => ({ id: 't_' + Math.random().toString(36).slice(2, 8), name }));
  const fitOffTasks  = [...fitSet].map(name => ({ id: 't_' + Math.random().toString(36).slice(2, 8), name }));

  const now = new Date().toISOString();
  const newJob = {
    id:           jobId,
    name:         quote.name,
    type:         quote.jobType || '',
    status:       'active',
    address:      quote.siteAddress || '',
    builder:      quote.builder || '',
    areaGroups,
    roughInTasks,
    fitOffTasks,
    fromQuoteId:  quote.id,
    createdAt:    now,
  };
  jobsBlob.jobs.push(newJob);
  await writeBlob('jobs.json', jobsBlob);

  // Seed an empty job data.json so per-job APIs don't 404 on first read.
  await writeBlob('jobs/' + jobId + '/data.json', { dwellings: {}, snags: [] });

  // Carry materials into the live job's materials-list (same shape as
  // /api/materials-list). Pricing fields preserved if captured.
  if ((materials.items || []).length) {
    const liveMaterials = { items: (materials.items || []).map(m => ({
      ...m,
      id:       'mat_' + Math.random().toString(36).slice(2, 8),
      jobId,
      status:   m.status === 'priced' ? 'priced' : (m.status === 'ordered' ? 'ordered' : 'draft'),
      // Drop quote-specific fields that don't belong in a live job context
      source:    undefined,
      confidence:undefined,
    })), emailRequests: [] };
    await writeBlob('jobs/' + jobId + '/materials-list.json', liveMaterials);
  }

  // Mark quote as converted; preserve the quote payload so historical
  // estimates remain reviewable.
  data.quotes[qIdx].status         = 'converted_to_job';
  data.quotes[qIdx].convertedJobId = jobId;
  data.quotes[qIdx].updatedAt      = now;
  await writeQuotes(data);

  return res.status(201).json({
    jobId,
    job: newJob,
    summary: {
      areaGroups: areaGroups.length,
      areas:      areaGroups.reduce((s, g) => s + (g.areas || []).length, 0),
      roughInTasks: roughInTasks.length,
      fitOffTasks:  fitOffTasks.length,
      materials:    (materials.items || []).length,
      labourLines:  (labour.lines || []).length,
      assumptions:  (notes.assumptions || []).length,
    },
  });
}

// Duplicate / revise a quote.
//   mode='duplicate' — clean copy for a different tender; new name + (copy);
//                       no parent linkage.
//   mode='revise'    — same tender, new revision pack received; same name
//                       suffixed with " (rev N)"; parentQuoteId links back
//                       to the original so the list view can group revisions.
// In both modes we copy basics + structure + materials + labour + notes
// (NOT documents — binary blobs are large; admin uploads the new pack
// for revisions). Status resets to 'draft' and convertedJobId clears.
async function handleDuplicate(req, res, user, srcId, opts) {
  const mode = (opts && opts.mode) || 'duplicate';
  const data = await readQuotes();
  const src = (data.quotes || []).find(q => q.id === srcId);
  if (!src) return res.status(404).json({ error: 'source quote not found' });

  const [structure, materials, labour, notes] = await Promise.all([
    readSection(srcId, 'structure'),
    readSection(srcId, 'materials'),
    readSection(srcId, 'labour'),
    readSection(srcId, 'notes'),
  ]);

  const now = new Date().toISOString();
  let derivedName, parentId, version;
  if (mode === 'revise') {
    // Walk to the root (in case the source is itself a revision) and
    // count siblings to compute the next rev number for the same root.
    const rootId = src.parentQuoteId || src.id;
    const siblings = (data.quotes || []).filter(q =>
      q.id === rootId || q.parentQuoteId === rootId);
    version = (Math.max(0, ...siblings.map(s => s.version || 1)) + 1);
    // Strip any existing "(rev N)" / "(copy)" suffix before re-suffixing.
    const stripped = String(src.name || '').replace(/\s*\((rev\s*\d+|copy)\)\s*$/i, '');
    derivedName = stripped + ' (rev ' + version + ')';
    parentId = rootId;
  } else {
    derivedName = (src.name || '') + ' (copy)';
    parentId = null;
    version = null;
  }

  const newQuote = {
    ...src,
    id:              newId('quote'),
    name:            derivedName,
    status:          'draft',
    convertedJobId:  null,
    parentQuoteId:   parentId,
    version:         version,
    createdAt:       now,
    createdBy:       user.username,
    updatedAt:       now,
  };
  data.quotes = data.quotes || [];
  data.quotes.push(newQuote);
  await writeQuotes(data);

  // Re-id everything inside the structure so references don't collide
  // with the source quote (helpful if both stay open in the workspace).
  const newStructure = {
    areaGroups: (structure.areaGroups || []).map(g => ({
      ...g,
      id: newId('qag'),
      areas: (g.areas || []).map(a => ({
        ...a,
        id: newId('qar'),
        workPackages: a.workPackages || [],
      })),
    })),
  };
  const newMaterials = {
    items: (materials.items || []).map(i => ({
      ...i,
      id: newId('qmat'),
      quoteId: newQuote.id,
      createdAt: now,
      updatedAt: now,
    })),
  };
  const newLabour = {
    lines: (labour.lines || []).map(l => ({
      ...l,
      id: newId('qlab'),
      quoteId: newQuote.id,
      createdAt: now,
      updatedAt: now,
    })),
  };

  await Promise.all([
    writeSection(newQuote.id, 'structure', newStructure),
    writeSection(newQuote.id, 'materials', newMaterials),
    writeSection(newQuote.id, 'labour', newLabour),
    writeSection(newQuote.id, 'notes', {
      assumptions:    notes.assumptions || [],
      exclusions:     notes.exclusions || [],
      risks:          notes.risks || [],
      clarifications: notes.clarifications || [],
    }),
  ]);

  return res.status(201).json({ quote: newQuote });
}

// Previous-job benchmarking — labour-estimate reference data.
// Walks all jobs + every user's per-day time-entries blob, aggregates
// total hours per job, joins to each job's area count, and returns a
// list sorted by total hours descending. Admin-only — internal cost
// and labour data must not leak.
//
// This is intentionally a heavy read (one blob per user-day across the
// whole window), so we cap to 180 days and ignore drafts. Acceptable
// because it's manually triggered from the Labour estimate panel and
// not on every page load.
async function handleBenchmark(req, res, user) {
  // Parallel: jobs index + users index. We need users to know which
  // per-user time-entries blobs to read.
  const [jobsBlob, usersBlob] = await Promise.all([
    readBlob('jobs.json', { jobs: [] }),
    readBlob('users.json', { users: [] }),
  ]);

  const jobs = jobsBlob.jobs || [];
  const users = (usersBlob.users || []).filter(u =>
    u.role === 'tradie' || u.role === 'leadingHand' || u.role === 'admin');

  // Walk the last 180 days of time-entries for crew users. Per-user
  // per-day blobs are small; we use Promise.all + a soft concurrency cap
  // by chunking through users.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = 180;
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    dates.push(
      d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }

  const totals = {};        // jobId -> { hours, days: Set, lastDate }
  const internalTotal = { hours: 0 };

  // Cap concurrent reads to keep blob throughput sane on Vercel. 12 is a
  // safe spot — single-digit tens of files in flight at once.
  const CONCURRENCY = 12;
  const tasks = [];
  for (const u of users) {
    for (const date of dates) {
      tasks.push({ u, date });
    }
  }

  let inflight = 0, idx = 0;
  await new Promise(resolve => {
    if (!tasks.length) return resolve();
    const next = () => {
      if (idx >= tasks.length && inflight === 0) return resolve();
      while (inflight < CONCURRENCY && idx < tasks.length) {
        const { u, date } = tasks[idx++];
        inflight++;
        readBlob('users/' + u.id + '/time-entries/' + date + '.json', null)
          .then(entry => {
            if (entry && Array.isArray(entry.allocations)) {
              for (const a of entry.allocations) {
                const jid = a.jobId || '__internal__';
                if (jid === '__internal__') {
                  internalTotal.hours += Number(a.hours) || 0;
                  continue;
                }
                if (!totals[jid]) totals[jid] = { hours: 0, days: new Set(), lastDate: '' };
                totals[jid].hours += Number(a.hours) || 0;
                totals[jid].days.add(date);
                if (date > totals[jid].lastDate) totals[jid].lastDate = date;
              }
            }
          })
          .catch(() => { /* missing day blob = no entry, normal */ })
          .finally(() => { inflight--; next(); });
      }
    };
    next();
  });

  // Build the response: one row per known job (omit jobs with zero hours
  // unless they're complete — admin still wants to see "0 logged" jobs).
  const rows = jobs.map(j => {
    const t = totals[j.id] || { hours: 0, days: new Set(), lastDate: '' };
    const areaCount = (j.areaGroups || []).reduce((s, g) => s + (g.areas || []).length, 0);
    const hoursPerArea = areaCount > 0 ? (t.hours / areaCount) : 0;
    return {
      jobId:        j.id,
      name:         j.name,
      type:         j.type || '',
      status:       j.status || 'active',
      areaCount,
      areaGroupsCount: (j.areaGroups || []).length,
      totalHours:   Math.round(t.hours * 10) / 10,
      daysWorked:   t.days.size,
      hoursPerArea: areaCount > 0 ? Math.round(hoursPerArea * 10) / 10 : null,
      lastDate:     t.lastDate || null,
    };
  })
  .filter(r => r.totalHours > 0 || r.status === 'complete')
  .sort((a, b) => b.totalHours - a.totalHours);

  return res.status(200).json({
    rows,
    coverage: {
      windowDays: days,
      jobsScanned: jobs.length,
      usersScanned: users.length,
      enoughData: rows.length >= 2,
    },
  });
}

// Helper — bumps the parent quote's updatedAt so the list view sorts right.
async function touchQuote(id) {
  try {
    const data = await readQuotes();
    const idx = (data.quotes || []).findIndex(q => q.id === id);
    if (idx < 0) return;
    data.quotes[idx].updatedAt = new Date().toISOString();
    await writeQuotes(data);
  } catch (e) { /* swallow */ }
}

// ── Router ───────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  // Quoting is admin-only for v1. Tradies/clients always 403.
  if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const action = (req.query && req.query.action) || '';
  const id = (req.query && req.query.id) || '';

  // Section-level routes (require id)
  if (action === 'structure') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method === 'GET')   return handleStructureGet(req, res, user, id);
    if (req.method === 'PATCH') return handleStructureSet(req, res, user, id);
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (action === 'materials') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method === 'GET')    return res.status(200).json(await readSection(id, 'materials'));
    if (req.method === 'POST')   return handleMaterialsAdd(req, res, user, id);
    if (req.method === 'PATCH')  return handleMaterialsUpdate(req, res, user, id);
    if (req.method === 'DELETE') return handleMaterialsDelete(req, res, user, id);
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (action === 'labour') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method === 'GET')    return res.status(200).json(await readSection(id, 'labour'));
    if (req.method === 'POST')   return handleLabourAdd(req, res, user, id);
    if (req.method === 'PATCH')  return handleLabourUpdate(req, res, user, id);
    if (req.method === 'DELETE') return handleLabourDelete(req, res, user, id);
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (action === 'notes') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method === 'GET')   return handleNotesGet(req, res, user, id);
    if (req.method === 'PATCH') return handleNotesSet(req, res, user, id);
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (action === 'pricing') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method === 'GET')   return handlePricingGet(req, res, user, id);
    if (req.method === 'PATCH') return handlePricingSet(req, res, user, id);
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (action === 'provisional') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method === 'GET')    return handleProvisionalGet(req, res, user, id);
    if (req.method === 'POST')   return handleProvisionalAdd(req, res, user, id);
    if (req.method === 'PATCH')  return handleProvisionalUpdate(req, res, user, id);
    if (req.method === 'DELETE') return handleProvisionalDelete(req, res, user, id);
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (action === 'totals') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' });
    return handleTotals(req, res, user, id);
  }
  if (action === 'ai-review') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method === 'GET')  return handleAiGet(req, res, user, id);
    if (req.method === 'POST') return handleAiRun(req, res, user, id);
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (action === 'convert') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    return handleConvert(req, res, user, id);
  }
  if (action === 'duplicate') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    return handleDuplicate(req, res, user, id, { mode: 'duplicate' });
  }
  if (action === 'revise') {
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    return handleDuplicate(req, res, user, id, { mode: 'revise' });
  }
  if (action === 'benchmark') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' });
    return handleBenchmark(req, res, user);
  }

  // Top-level routes
  if (req.method === 'GET' && id)     return handleGetQuote(req, res, user);
  if (req.method === 'GET')           return handleListQuotes(req, res, user);
  if (req.method === 'POST')          return handleCreateQuote(req, res, user);
  if (req.method === 'PATCH')         return handleUpdateQuote(req, res, user);
  if (req.method === 'DELETE')        return handleArchiveQuote(req, res, user);

  return res.status(405).json({ error: 'method not allowed' });
};
