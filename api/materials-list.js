// Materials Takeoff / Order List + Pricing + Procurement — Phase 11 (extends Phase 10).
//
// Phase 11 adds the procurement loop: priced items become purchase orders,
// receipts draw down the order, and the per-item status auto-advances
// (priced → ordered → received). The Overview cost rollup gains
// committedExGst (sum of sent POs) and receivedExGst (sum of received qty
// × unit) so admins see commitment vs actual spend at a glance.
//
// New actions:
//   POST   /api/materials-list?jobId=X&action=create-po
//                        body: { requestId } | { itemIds: [...] }
//                        → Snapshots priced items + chosen wholesaler into
//                          a draft PO. Items without a quotedUnitPrice are
//                          skipped. Returns { po }.
//   POST   /api/materials-list?jobId=X&action=update-po&poId=Y
//                        body: { status?, expectedDeliveryDate?, notes?, confirmedAt? }
//                        → Status flow: draft → sent → confirmed → partial
//                          → fulfilled (or cancelled at any point). When
//                          flipped to 'sent' records sentAt + sentBy.
//   POST   /api/materials-list?jobId=X&action=record-receipt&poId=Y
//                        body: { items: [{ itemId, qtyReceived, notes? }],
//                                notes? }
//                        → Logs a receipt event against the PO. Per-item
//                          qtyReceived sums across all events. PO status
//                          auto-advances to partial/fulfilled. Items'
//                          quoteStatus auto-flips to 'received' when their
//                          ordered qty is fully covered.
//
// Phase 10 actions (still here):
//   GET    ...&action=schedule       Computed roll-up from data.json
//   POST   ...&action=sync-from-takeoff
//   POST   ...&action=record-reply
//   GET    ...&action=cost-rollup    Now also returns committedExGst /
//                                    receivedExGst / poCount / openPoCount.
//
// Phase 1 actions (CRUD + bulk-add + email) unchanged.

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
  const pos = list.purchaseOrders || [];
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
  // Phase 11 — committed (sent POs) and received (line × unit, summed
  // across all receivedEvents). Cancelled POs don't count.
  let committedExGst = 0;
  let receivedExGst = 0;
  let openPos = 0;
  for (const po of pos) {
    if (po.status === 'cancelled' || po.status === 'draft') continue;
    committedExGst += Number(po.totalExGst) || 0;
    if (['sent', 'confirmed', 'partial'].includes(po.status)) openPos++;
    const unitByItemId = {};
    for (const snap of (po.itemSnapshots || [])) unitByItemId[snap.itemId] = Number(snap.unitPriceExGst) || 0;
    for (const ev of (po.receivedEvents || [])) {
      for (const r of (ev.items || [])) {
        const u = unitByItemId[r.itemId] || 0;
        receivedExGst += u * (Number(r.qtyReceived) || 0);
      }
    }
  }
  return {
    itemsCount: items.length,
    pricedCount: priced,
    unpricedCount: items.length - priced,
    unpricedQty,
    totalCostExGst:  Math.round(totalCostExGst  * 100) / 100,
    committedExGst:  Math.round(committedExGst  * 100) / 100,
    receivedExGst:   Math.round(receivedExGst   * 100) / 100,
    poCount: pos.length,
    openPoCount: openPos,
  };
}

// ─── Phase 11: purchase orders + receipts ──────────────────────────────
//
// A purchase order snapshots the items + chosen wholesaler + agreed prices
// from a replied email request. Once sent, it commits the spend; receipts
// against it (full or partial) draw down the outstanding balance and tip
// items into 'received' status when fully delivered.
//
// Lifecycle:
//   draft     — created, not yet sent to wholesaler
//   sent      — wholesaler notified
//   confirmed — wholesaler ack received
//   partial   — at least one receipt logged but not all qty in
//   fulfilled — every snapshot line fully received
//   cancelled — admin cancelled (commitments backed out)

const PO_STATUSES = ['draft', 'sent', 'confirmed', 'partial', 'fulfilled', 'cancelled'];

// Recompute per-item qtyOrdered + qtyReceived + status across all live POs.
// Cheap O(items × pos × snapshots × receipts) — fine at job scale.
function reconcileItemFlows(list) {
  const items = list.items || [];
  const pos = list.purchaseOrders || [];
  const ord = {}, rec = {}; // itemId -> qty
  for (const po of pos) {
    if (po.status === 'cancelled' || po.status === 'draft') continue;
    for (const snap of (po.itemSnapshots || [])) {
      ord[snap.itemId] = (ord[snap.itemId] || 0) + (Number(snap.qty) || 0);
    }
    for (const ev of (po.receivedEvents || [])) {
      for (const r of (ev.items || [])) {
        rec[r.itemId] = (rec[r.itemId] || 0) + (Number(r.qtyReceived) || 0);
      }
    }
  }
  for (const it of items) {
    it.qtyOrdered  = ord[it.id] || 0;
    it.qtyReceived = rec[it.id] || 0;
    // Status flow only auto-advances forward; admin can manually set
    // anything via PATCH.
    const qty = Number(it.quantity) || 0;
    if (it.qtyReceived >= qty && qty > 0) it.status = 'received';
    else if (it.qtyOrdered > 0 && it.status !== 'cancelled') it.status = 'ordered';
  }
}

// PO line totals derived from item snapshots (immutable once PO is sent —
// admin must cancel + redo to change pricing on a sent PO, intentional).
function recomputePoTotals(po) {
  let sub = 0;
  for (const snap of (po.itemSnapshots || [])) {
    snap.lineTotalExGst = Math.round((Number(snap.unitPriceExGst) || 0) * (Number(snap.qty) || 0) * 100) / 100;
    sub += snap.lineTotalExGst;
  }
  po.totalExGst = Math.round(sub * 100) / 100;
  po.gstAmount  = Math.round(sub * 0.10 * 100) / 100;
  po.totalIncGst = Math.round(sub * 1.10 * 100) / 100;
}

// Update PO status based on receipt coverage (partial / fulfilled).
function reconcilePoStatus(po) {
  if (['draft', 'cancelled'].includes(po.status)) return;
  const ordered = {}; let totalOrdered = 0;
  for (const snap of (po.itemSnapshots || [])) {
    ordered[snap.itemId] = Number(snap.qty) || 0;
    totalOrdered += ordered[snap.itemId];
  }
  const recv = {};
  for (const ev of (po.receivedEvents || [])) {
    for (const r of (ev.items || [])) {
      recv[r.itemId] = (recv[r.itemId] || 0) + (Number(r.qtyReceived) || 0);
    }
  }
  let totalRecv = 0;
  let allComplete = true;
  for (const [id, ordQty] of Object.entries(ordered)) {
    const r = recv[id] || 0;
    totalRecv += Math.min(r, ordQty);
    if (r < ordQty) allComplete = false;
  }
  if (totalRecv === 0) {
    if (po.status === 'partial') po.status = 'sent'; // backed out fully
  } else if (allComplete) {
    po.status = 'fulfilled';
  } else {
    po.status = 'partial';
  }
}

async function createPo(jobId, body, user) {
  const requestId = body.requestId;
  const list = await readList(jobId);
  list.purchaseOrders = list.purchaseOrders || [];
  let req = null;
  let itemIds = body.itemIds || null;
  let wholesalerName = body.wholesalerName || '';
  let recipientEmail = body.recipientEmail || '';

  if (requestId) {
    req = (list.emailRequests || []).find(r => r.id === requestId);
    if (!req) return { error: 'request not found', status: 404 };
    itemIds = req.itemIds || [];
    wholesalerName = req.wholesalerName || wholesalerName;
    recipientEmail = req.recipientEmail || recipientEmail;
  }
  if (!itemIds || !itemIds.length) return { error: 'no items to order', status: 400 };

  const itemsById = {};
  for (const it of (list.items || [])) itemsById[it.id] = it;
  const snapshots = [];
  for (const id of itemIds) {
    const it = itemsById[id];
    if (!it) continue;
    const qty = Number(it.quantity) || 0;
    const unit = Number(it.quotedUnitPrice);
    if (!Number.isFinite(unit) || unit <= 0) continue; // skip unpriced
    snapshots.push({
      itemId: id, name: it.name, brandOrSpec: it.brandOrSpec || '',
      qty, unit: it.unit || 'each', unitPriceExGst: unit,
      lineTotalExGst: Math.round(unit * qty * 100) / 100,
    });
  }
  if (!snapshots.length) return { error: 'no priced items in this request', status: 400 };

  const po = {
    id: newId('po'), jobId,
    poNumber: 'PO-' + Date.now().toString(36).toUpperCase(),
    createdAt: new Date().toISOString(), createdBy: user.username,
    wholesalerName, recipientEmail,
    fromRequestId: requestId || null,
    itemSnapshots: snapshots,
    status: 'draft',
    receivedEvents: [],
    expectedDeliveryDate: body.expectedDeliveryDate || '',
    notes: body.notes ? String(body.notes).trim() : '',
  };
  recomputePoTotals(po);
  list.purchaseOrders.push(po);
  reconcileItemFlows(list);
  await writeList(jobId, list);
  return { po };
}

async function updatePo(jobId, poId, body, user) {
  const list = await readList(jobId);
  const po = (list.purchaseOrders || []).find(p => p.id === poId);
  if (!po) return { error: 'PO not found', status: 404 };
  if (body.status && PO_STATUSES.includes(body.status)) {
    if (body.status === 'sent' && po.status === 'draft') {
      po.sentAt = new Date().toISOString();
      po.sentBy = user.username;
    }
    if (body.status === 'cancelled') {
      po.cancelledAt = new Date().toISOString();
      po.cancelledBy = user.username;
    }
    po.status = body.status;
  }
  if (body.expectedDeliveryDate !== undefined) po.expectedDeliveryDate = String(body.expectedDeliveryDate || '').trim();
  if (body.notes !== undefined) po.notes = String(body.notes || '').trim();
  if (body.confirmedAt !== undefined) po.confirmedAt = body.confirmedAt;
  reconcileItemFlows(list);
  await writeList(jobId, list);
  return { po };
}

async function recordReceipt(jobId, poId, body, user) {
  const list = await readList(jobId);
  const po = (list.purchaseOrders || []).find(p => p.id === poId);
  if (!po) return { error: 'PO not found', status: 404 };
  if (po.status === 'draft' || po.status === 'cancelled') {
    return { error: 'cannot receive against a ' + po.status + ' PO', status: 400 };
  }
  const incoming = Array.isArray(body.items) ? body.items : [];
  const allowed = new Set((po.itemSnapshots || []).map(s => s.itemId));
  const cleaned = [];
  for (const r of incoming) {
    if (!r || !r.itemId || !allowed.has(r.itemId)) continue;
    const q = Number(r.qtyReceived);
    if (!Number.isFinite(q) || q <= 0) continue;
    cleaned.push({ itemId: r.itemId, qtyReceived: q, notes: r.notes ? String(r.notes).trim() : '' });
  }
  if (!cleaned.length) return { error: 'no valid receipts in body.items', status: 400 };

  po.receivedEvents = po.receivedEvents || [];
  po.receivedEvents.push({
    id: newId('rcpt'),
    at: new Date().toISOString(),
    by: user.username,
    items: cleaned,
    notes: body.notes ? String(body.notes).trim() : '',
  });
  reconcilePoStatus(po);
  reconcileItemFlows(list);
  await writeList(jobId, list);
  return { po, eventId: po.receivedEvents[po.receivedEvents.length - 1].id };
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

    // Phase 11 — purchase orders + receipts
    if (action === 'create-po') {
      const result = await createPo(jobId, body, user);
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      return res.status(201).json(result);
    }
    if (action === 'update-po') {
      const poId = (req.query && req.query.poId) || body.poId;
      if (!poId) return res.status(400).json({ error: 'poId required' });
      const result = await updatePo(jobId, poId, body, user);
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      return res.status(200).json(result);
    }
    if (action === 'record-receipt') {
      const poId = (req.query && req.query.poId) || body.poId;
      if (!poId) return res.status(400).json({ error: 'poId required' });
      const result = await recordReceipt(jobId, poId, body, user);
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
