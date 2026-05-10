// Materials Takeoff / Order List + Wholesaler Pricing — Phase 10 (extends Phase 1).
//
// Job-scoped materials list. Each job has its own materials-list.json with
// items + saved email request drafts. Phase 10 adds:
//   * Provenance — items track `source` ('manual' | 'plan-takeoff') and a
//     per-dwelling breakdown for takeoff items.
//   * Schedule rollup — aggregates per-dwelling materials (admin-confirmed
//     counts from data.json) against the legend (ai-takeoff.json) into a
//     job-level material schedule, ready to push into the items list.
//   * Cost rollup — sums quantity × quotedUnitPrice across all priced items
//     so the per-job Overview can show projected materials cost.
//   * Wholesaler reply capture — records per-item unit prices from a
//     wholesaler's reply, with option to mark the reply as the chosen
//     supplier (lock-in pricing).
//
// Existing actions unchanged:
//   GET    /api/materials-list?jobId=<id>                  → list items + drafts
//   POST   /api/materials-list?jobId=<id>                  → add item
//   POST   /api/materials-list?jobId=<id>&action=bulk-add  → add many items
//   POST   /api/materials-list?jobId=<id>&action=email     → save email draft
//   PATCH  /api/materials-list?jobId=<id>&id=<itemId>      → update item
//   DELETE /api/materials-list?jobId=<id>&id=<itemId>      → remove item
//
// New actions:
//   GET    /api/materials-list?jobId=<id>&action=schedule
//                        → Computed (no storage). Reads
//                          jobs/<id>/data.json (dwellings[id].materials)
//                          and jobs/<id>/ai-takeoff.json (legendItems)
//                          and returns a normalised schedule:
//                          { items: [{ code, label, category, totalQty,
//                                       perDwelling: { dwId: qty, ... } }] }
//
//   POST   /api/materials-list?jobId=<id>&action=sync-from-takeoff
//                        body: {} (or { confirmedDwellingsOnly: true })
//                        → Upserts schedule items into the materials list.
//                          Items keyed by `legendCode` — existing takeoff
//                          items get qty + provenance updated; new takeoff
//                          items are inserted; manual items are never
//                          touched. Returns { added, updated, kept }.
//
//   POST   /api/materials-list?jobId=<id>&action=record-reply
//                        body: { requestId, replyTotalExGst?, replyNotes?,
//                                replyAt?, perItemPrices?: { itemId: unit$ },
//                                markChosen?: boolean }
//                        → Annotates an emailRequest with the wholesaler's
//                          reply. If perItemPrices is set, each price is
//                          written to the matching item's quotedUnitPrice
//                          (only items still attached to this request).
//                          markChosen flips the request's chosen flag and
//                          un-flags any previously-chosen request for the
//                          same items.
//
//   GET    /api/materials-list?jobId=<id>&action=cost-rollup
//                        → { items: <count>, priced: <count>,
//                            totalCostExGst: <sum quantity × quotedUnitPrice
//                                              over priced items>,
//                            unpricedQty: <units waiting for pricing> }
//
// Permissions:
//   admin:        full access
//   leadingHand:  full on managed jobs (canManageJob)
//   tradie:       read on jobs they're on
//   client:       403
//
// Storage: jobs/<jobId>/materials-list.json — { items: [...], emailRequests: [...] }

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');

const VALID_STATUSES = ['draft', 'ready_to_price', 'priced', 'ordered', 'received', 'cancelled'];
const VALID_SOURCES  = ['manual', 'plan-takeoff'];

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function readList(jobId) {
  return await readBlob('jobs/' + jobId + '/materials-list.json', { items: [], emailRequests: [] });
}
async function writeList(jobId, data) {
  await writeBlob('jobs/' + jobId + '/materials-list.json', data);
}

// Parse a free-text bulk-add line into a partial item.
function parseLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const m = raw.match(/^([\d.]+)\s*([a-zA-Z]*)\s*[x×]\s*(.+)$/i);
  if (m) {
    const qty = parseFloat(m[1]) || 0;
    const unit = (m[2] || '').toLowerCase() || 'each';
    let rest = m[3].trim();
    let spec = '';
    const dashIdx = rest.indexOf(' - ');
    if (dashIdx > 0) { spec = rest.slice(dashIdx + 3).trim(); rest = rest.slice(0, dashIdx).trim(); }
    return { name: rest, brandOrSpec: spec, quantity: qty, unit };
  }
  return { name: raw, brandOrSpec: '', quantity: 1, unit: 'each' };
}

function buildItem(body, user) {
  const now = new Date().toISOString();
  return {
    id:            newId('mat'),
    jobId:         body.jobId || null,
    name:          body.name ? String(body.name).trim() : '',
    description:   body.description ? String(body.description).trim() : '',
    brandOrSpec:   body.brandOrSpec ? String(body.brandOrSpec).trim() : '',
    category:      body.category ? String(body.category).trim() : 'Other',
    subcategory:   body.subcategory ? String(body.subcategory).trim() : '',
    quantity:      body.quantity != null ? Number(body.quantity) : 1,
    unit:          body.unit ? String(body.unit).trim() : 'each',
    drawingRef:    body.drawingRef ? String(body.drawingRef).trim() : '',
    level:         body.level ? String(body.level).trim() : '',
    area:          body.area ? String(body.area).trim() : '',
    notes:         body.notes ? String(body.notes).trim() : '',
    status:        body.status && VALID_STATUSES.includes(body.status) ? body.status : 'draft',
    quotedUnitPrice:    body.quotedUnitPrice != null ? Number(body.quotedUnitPrice) : null,
    quotedTotal:        body.quotedTotal != null ? Number(body.quotedTotal) : null,
    selectedWholesaler: body.selectedWholesaler ? String(body.selectedWholesaler).trim() : '',
    quoteStatus:        body.quoteStatus ? String(body.quoteStatus).trim() : '',
    // Phase 10 — provenance
    source:        VALID_SOURCES.includes(body.source) ? body.source : 'manual',
    legendCode:    body.legendCode ? String(body.legendCode).trim() : '',
    perDwelling:   body.perDwelling && typeof body.perDwelling === 'object' ? body.perDwelling : null,
    pricedFrom:    body.pricedFrom || null, // requestId of wholesaler email
    createdAt:     now,
    createdBy:     user.username,
    updatedAt:     now,
  };
}

// ─── Phase 10: schedule + sync helpers ────────────────────────────────────

// Read the per-dwelling materials confirmed by the admin (data.json) and the
// extracted legend (ai-takeoff.json), and produce a job-level rollup keyed
// by legend code. Items the legend doesn't define are still surfaced under
// their bare code so the admin can decide what to do.
async function computeSchedule(jobId) {
  const [data, takeoff] = await Promise.all([
    readBlob('jobs/' + jobId + '/data.json',       { dwellings: {} }),
    readBlob('jobs/' + jobId + '/ai-takeoff.json', { legendItems: [], dwellings: {} }),
  ]);
  const dwellings = (data && data.dwellings) || {};
  const legendByCode = {};
  for (const lit of (takeoff.legendItems || [])) {
    if (lit && lit.code) legendByCode[lit.code] = lit;
  }

  // bucket: code -> { totalQty, perDwelling }
  const bucket = {};
  for (const [dwId, dw] of Object.entries(dwellings)) {
    const mats = (dw && dw.materials) || {};
    for (const [code, qty] of Object.entries(mats)) {
      const n = Number(qty) || 0;
      if (!n) continue;
      if (!bucket[code]) bucket[code] = { totalQty: 0, perDwelling: {} };
      bucket[code].totalQty += n;
      bucket[code].perDwelling[dwId] = n;
    }
  }

  const items = Object.entries(bucket).map(([code, agg]) => {
    const lit = legendByCode[code] || {};
    return {
      code,
      label:    lit.label    || code,
      category: lit.category || 'Other',
      totalQty: agg.totalQty,
      perDwelling: agg.perDwelling,
      legendKnown: !!legendByCode[code],
    };
  }).sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.label.localeCompare(b.label));

  return {
    items,
    dwellingCount: Object.keys(dwellings).filter(d => Object.keys((dwellings[d] && dwellings[d].materials) || {}).length).length,
    legendItemCount: Object.keys(legendByCode).length,
    computedAt: new Date().toISOString(),
  };
}

// Upsert schedule items into the materials-list, keyed by legendCode.
// Manual items are never touched. Existing takeoff items with the same
// legendCode get qty + perDwelling updated; new takeoff items are added.
// Takeoff items that no longer appear in the schedule are kept (admin may
// want to manually reduce the count) but flagged with `staleAfter`.
async function syncFromTakeoff(jobId, user) {
  const schedule = await computeSchedule(jobId);
  const list = await readList(jobId);
  list.items = list.items || [];
  const now = new Date().toISOString();

  const byCode = {};
  for (const it of list.items) {
    if (it.source === 'plan-takeoff' && it.legendCode) byCode[it.legendCode] = it;
  }

  let added = 0, updated = 0;
  const seen = new Set();
  for (const sch of schedule.items) {
    seen.add(sch.code);
    const existing = byCode[sch.code];
    if (existing) {
      // Preserve admin-edited descriptive fields (name override, brand, notes,
      // pricing). Only refresh the auto-derived qty + provenance.
      existing.quantity   = sch.totalQty;
      existing.perDwelling = sch.perDwelling;
      // If admin hasn't customised the name/category yet, fill from legend.
      if (!existing._nameLocked && sch.label && sch.label !== sch.code) existing.name = sch.label;
      if (!existing._categoryLocked && sch.category) existing.category = sch.category;
      existing.updatedAt = now;
      delete existing.staleAfter;
      updated++;
    } else {
      list.items.push(buildItem({
        jobId, name: sch.label, category: sch.category, quantity: sch.totalQty, unit: 'each',
        source: 'plan-takeoff', legendCode: sch.code, perDwelling: sch.perDwelling,
      }, user));
      added++;
    }
  }
  // Mark dropped takeoff items as stale (don't auto-delete — admin may
  // have ordered against an earlier count).
  let staled = 0;
  for (const it of list.items) {
    if (it.source === 'plan-takeoff' && it.legendCode && !seen.has(it.legendCode) && !it.staleAfter) {
      it.staleAfter = now;
      staled++;
    }
  }
  await writeList(jobId, list);
  return { added, updated, staled, total: list.items.length };
}

// Per-job cost rollup. Pure read; computed on the fly so it always
// reflects current item state.
function rollupCost(list) {
  const items = list.items || [];
  let totalCostExGst = 0;
  let priced = 0;
  let unpricedQty = 0;
  for (const it of items) {
    const qty = Number(it.quantity) || 0;
    const unit = Number(it.quotedUnitPrice);
    if (Number.isFinite(unit) && unit > 0) {
      totalCostExGst += qty * unit;
      priced++;
    } else {
      unpricedQty += qty;
    }
  }
  return {
    itemsCount: items.length,
    pricedCount: priced,
    unpricedCount: items.length - priced,
    unpricedQty,
    totalCostExGst: Math.round(totalCostExGst * 100) / 100,
  };
}

// Apply a wholesaler's reply to an email request — both annotates the
// request with the reply and (optionally) writes per-item unit prices
// back to the items in that request.
async function recordReply(jobId, body, user) {
  const requestId = body.requestId;
  if (!requestId) return { error: 'requestId required', status: 400 };
  const list = await readList(jobId);
  const req = (list.emailRequests || []).find(r => r.id === requestId);
  if (!req) return { error: 'request not found', status: 404 };

  if (body.replyTotalExGst != null) req.replyTotalExGst = Number(body.replyTotalExGst);
  if (body.replyNotes      != null) req.replyNotes      = String(body.replyNotes).trim();
  req.replyAt = body.replyAt || new Date().toISOString();
  req.replyBy = user.username;
  req.status  = 'replied';

  const perItemPrices = body.perItemPrices || {};
  const itemsTouched = [];
  if (Object.keys(perItemPrices).length) {
    const itemsById = {};
    for (const it of (list.items || [])) itemsById[it.id] = it;
    for (const [itemId, unitPrice] of Object.entries(perItemPrices)) {
      const it = itemsById[itemId];
      if (!it) continue;
      // Only price items that are part of THIS request.
      if (req.itemIds && req.itemIds.length && !req.itemIds.includes(itemId)) continue;
      const u = Number(unitPrice);
      if (!Number.isFinite(u) || u < 0) continue;
      it.quotedUnitPrice = u;
      it.quotedTotal     = Math.round(u * (Number(it.quantity) || 0) * 100) / 100;
      it.pricedFrom      = req.id;
      it.selectedWholesaler = req.wholesalerName || it.selectedWholesaler;
      it.status          = 'priced';
      it.updatedAt       = new Date().toISOString();
      itemsTouched.push(itemId);
    }
  }

  if (body.markChosen) {
    // Un-flag any previously-chosen request that overlaps these items.
    for (const otherReq of (list.emailRequests || [])) {
      if (otherReq.id === req.id) continue;
      const overlaps = (otherReq.itemIds || []).some(id => (req.itemIds || []).includes(id));
      if (overlaps && otherReq.chosen) otherReq.chosen = false;
    }
    req.chosen = true;
  }

  await writeList(jobId, list);
  return { request: req, itemsTouched };
}

// ─── Router ───────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const action = (req.query && req.query.action) || '';

  if (req.method === 'GET') {
    const isCrew = (user.assignedJobIds || []).includes(jobId);
    if (user.role !== 'admin' && !canManageJob(user, jobId) && !isCrew) {
      return res.status(403).json({ error: 'no access to this job' });
    }
    if (action === 'schedule') {
      // Computed read — admin/LH only (it depends on data.json materials
      // that crew aren't expected to edit).
      if (user.role !== 'admin' && !canManageJob(user, jobId)) {
        return res.status(403).json({ error: 'admin / LH only' });
      }
      const sched = await computeSchedule(jobId);
      return res.status(200).json(sched);
    }
    if (action === 'cost-rollup') {
      const data = await readList(jobId);
      return res.status(200).json(rollupCost(data));
    }
    const data = await readList(jobId);
    return res.status(200).json(data);
  }

  // Mutations require manager-level access.
  if (!canManageJob(user, jobId) && user.role !== 'admin') {
    return res.status(403).json({ error: 'cannot manage this job' });
  }

  if (req.method === 'POST') {
    const body = req.body || {};

    if (action === 'sync-from-takeoff') {
      const result = await syncFromTakeoff(jobId, user);
      return res.status(200).json(result);
    }

    if (action === 'record-reply') {
      const result = await recordReply(jobId, body, user);
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      return res.status(200).json(result);
    }

    if (action === 'bulk-add') {
      const lines = Array.isArray(body.lines) ? body.lines : [];
      if (!lines.length) return res.status(400).json({ error: 'no lines provided' });
      const data = await readList(jobId);
      data.items = data.items || [];
      const created = [];
      for (const raw of lines) {
        const parsed = parseLine(raw);
        if (!parsed) continue;
        const item = buildItem({
          ...parsed, jobId,
          category: body.category || 'Other',
          level: body.level || '',
          drawingRef: body.drawingRef || '',
          source: 'manual',
        }, user);
        data.items.push(item);
        created.push(item);
      }
      await writeList(jobId, data);
      return res.status(201).json({ items: created });
    }

    if (action === 'email') {
      if (!body.subject || !body.body) {
        return res.status(400).json({ error: 'subject and body required' });
      }
      const data = await readList(jobId);
      data.emailRequests = data.emailRequests || [];
      const request = {
        id:              newId('req'),
        createdAt:       new Date().toISOString(),
        createdBy:       user.username,
        wholesalerName:  body.wholesalerName ? String(body.wholesalerName).trim() : '',
        recipientEmail:  body.recipientEmail ? String(body.recipientEmail).trim() : '',
        subject:         String(body.subject),
        body:            String(body.body),
        itemIds:         Array.isArray(body.itemIds) ? body.itemIds : [],
        status:          'draft',
        chosen:          false,
      };
      data.emailRequests.push(request);
      await writeList(jobId, data);
      return res.status(201).json({ request });
    }

    // Default POST: add single item
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    const data = await readList(jobId);
    data.items = data.items || [];
    const item = buildItem({ ...body, jobId, source: body.source || 'manual' }, user);
    data.items.push(item);
    await writeList(jobId, data);
    return res.status(201).json({ item });
  }

  if (req.method === 'PATCH') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    const data = await readList(jobId);
    const idx = (data.items || []).findIndex(i => i.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    const editable = ['name', 'description', 'brandOrSpec', 'category', 'subcategory',
                      'quantity', 'unit', 'drawingRef', 'level', 'area', 'notes',
                      'quotedUnitPrice', 'quotedTotal', 'selectedWholesaler', 'quoteStatus',
                      'pricedFrom'];
    for (const k of editable) {
      if (body[k] !== undefined) data.items[idx][k] = body[k];
    }
    if (body.status && VALID_STATUSES.includes(body.status)) data.items[idx].status = body.status;
    // Track admin overrides on takeoff items so re-syncing doesn't clobber
    // a manually-renamed item.
    if (body.name        !== undefined) data.items[idx]._nameLocked     = true;
    if (body.category    !== undefined) data.items[idx]._categoryLocked = true;
    // Recompute total when unit price + quantity are present.
    const it = data.items[idx];
    const u = Number(it.quotedUnitPrice);
    const q = Number(it.quantity);
    if (Number.isFinite(u) && Number.isFinite(q)) {
      it.quotedTotal = Math.round(u * q * 100) / 100;
    }
    it.updatedAt = new Date().toISOString();
    await writeList(jobId, data);
    return res.status(200).json({ item: it });
  }

  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readList(jobId);
    const before = (data.items || []).length;
    data.items = (data.items || []).filter(i => i.id !== id);
    if (data.items.length === before) return res.status(404).json({ error: 'not found' });
    await writeList(jobId, data);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
