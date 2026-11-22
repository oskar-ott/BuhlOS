'use strict';

// What on a job can be put on an invoice, and what already is (#1162).
//
// BuhlOS already holds a job's approved hours and its materials. This module
// turns them into things an itemised invoice can bill, and answers the one
// question that stops double billing: is this already on an invoice?
//
// "BILLED" IS DERIVED, NEVER FLAGGED. Each charge on an itemised invoice
// carries `refs` — what job data it bills. What is on an invoice is read back
// from those refs on the job's LIVE invoices, so it cannot drift from the
// invoices themselves: remove an invoice, or have Xero show it deleted or
// voided, and what it billed is free again with no extra step.
//
// A ref is one of:
//   { t: 'h',  u: userId, d: 'YYYY-MM-DD', m: hoursMilli }  approved hours, one worker one day
//   { t: 'sl', id }   one line of a captured supplier invoice
//   { t: 'si', id }   a captured supplier invoice taken as one amount
//   { t: 'ml', id }   a docket typed into the job's materials ledger
//   { t: 'v',  id }   an approved variation (#1163)
//
// COST IS WORKED OUT HERE, on the server, from the job's own data — never
// taken from the browser. The sell price is the office's to set; the cost is
// not. Cost and refs never go to Xero.
//
// Pure where it can be: `loadSources` does the reading, everything else is a
// function of what it returned.

const { DEAD_XERO, itemsOf, lineAmountCents } = require('./amounts');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REFS_PER_LINE = 400;

/** Hours as logged (a decimal) → whole thousandths of an hour. */
function hoursMilli(hours) {
  const n = Number(hours);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

/** hours (thousandths) × an hourly rate (cents) → cents, rounded once. */
function hoursCost(milli, rateCents) {
  if (!Number.isInteger(milli) || !Number.isInteger(rateCents) || rateCents <= 0) return null;
  return Math.floor((milli * rateCents + 500) / 1000);
}

/** An invoice that still holds what it billed: not cancelled, and not one
 *  Xero shows as deleted or voided. */
function holdsItsRefs(row) {
  if (!row || row.state === 'cancelled') return false;
  if (row.state === 'sent' && DEAD_XERO.has(String(row.xeroStatus || ''))) return false;
  return true;
}

const hourKey = (u, d) => `${u}|${d}`;

/** What a row's label is when a person is told "that is already on …". */
function invoiceLabel(row) {
  return row.invoiceNumber || row.title || 'another invoice';
}

/**
 * Everything the job's live invoices already bill.
 * @param {Array<object>} rows   the job's invoice rows
 * @param {{ excludeInvoiceId?: string|null }} [o]  the invoice being edited —
 *        its own refs don't count against it
 */
function billedIndex(rows, { excludeInvoiceId = null } = {}) {
  const hours = new Map(); // 'user|day' → thousandths already billed
  const hoursOn = new Map(); // 'user|day' → label of an invoice holding them
  const ids = new Map(); // 'sl:<id>' etc → label
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!holdsItsRefs(row) || (excludeInvoiceId && row.id === excludeInvoiceId)) continue;
    const label = invoiceLabel(row);
    for (const it of itemsOf(row)) {
      if (it.type !== 'line') continue;
      for (const r of it.refs) {
        if (!r || typeof r !== 'object') continue;
        if (r.t === 'h' && typeof r.u === 'string' && DAY.test(String(r.d)) && Number.isInteger(r.m) && r.m > 0) {
          const k = hourKey(r.u, r.d);
          hours.set(k, (hours.get(k) || 0) + r.m);
          hoursOn.set(k, label);
        } else if ((r.t === 'sl' || r.t === 'si' || r.t === 'ml' || r.t === 'v') && typeof r.id === 'string') {
          ids.set(`${r.t}:${r.id}`, label);
        }
      }
    }
    for (const l of Array.isArray(row.extraLines) ? row.extraLines : []) {
      if (l && typeof l.variationId === 'string') ids.set(`v:${l.variationId}`, label);
    }
  }
  return { hours, hoursOn, ids };
}

/**
 * Read the job's hours and materials. Each source reports `available: false`
 * (with a reason) instead of throwing, so one unreadable source never stops an
 * invoice being typed by hand.
 *
 * @param {{ job: object, sql: any, tenantId: string,
 *           flags: { supplierInvoices: boolean, ledger: boolean },
 *           deps: {
 *             timeEntries: () => Promise<object[]>,
 *             costRates: () => Promise<object>,
 *             historyFor: Function, effectiveCostRate: Function,
 *             users: () => Promise<{ users: object[], employees: object[] }>,
 *             labeller: Function,
 *             supplierBreakdown: (sql: any, tenantId: string, jobId: string) => Promise<object>,
 *             ledger: (jobId: string) => Promise<object>,
 *             ledgerLines: (data: object) => object[],
 *           } }} ctx
 */
async function loadSources(ctx) {
  const { job, sql, tenantId, flags, deps } = ctx;
  const jobId = job.id;

  // ── hours ──
  const labour = { available: true, reason: null, days: [], pendingMilli: 0 };
  try {
    const [entries, rates, people] = await Promise.all([deps.timeEntries(), deps.costRates(), deps.users()]);
    const labelFor = deps.labeller({ users: people.users, employees: people.employees });
    const byKey = new Map();
    for (const e of entries || []) {
      if (!e || !e.userId || !DAY.test(String(e.date || '').slice(0, 10))) continue;
      if (e.status !== 'approved' && e.status !== 'submitted') continue;
      const milli = (e.allocations || [])
        .filter((a) => a && a.jobId === jobId)
        .reduce((s, a) => s + hoursMilli(a.hours), 0);
      if (!milli) continue;
      if (e.status === 'submitted') { labour.pendingMilli += milli; continue; }
      const day = String(e.date).slice(0, 10);
      const k = hourKey(e.userId, day);
      const cur = byKey.get(k);
      if (cur) { cur.milli += milli; continue; }
      const rate = deps.effectiveCostRate(deps.historyFor(rates, e.userId), day);
      byKey.set(k, {
        userId: e.userId,
        name: labelFor(e.userId, e.userName || null),
        date: day,
        milli,
        costRateCents: rate && rate.costRateCents > 0 ? rate.costRateCents : null,
        chargeOutRateCents: rate && rate.chargeOutRateCents > 0 ? rate.chargeOutRateCents : null,
      });
    }
    labour.days = Array.from(byKey.values()).sort(
      (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)
    );
  } catch (e) {
    console.error('[customer-invoices] billable: hours unreadable', { code: (e && e.code) || 'hours' });
    labour.available = false;
    labour.reason = 'unreadable';
  }

  // ── captured supplier invoices ──
  const supplier = { available: false, reason: flags.supplierInvoices ? null : 'off', lines: [], whole: [] };
  if (flags.supplierInvoices) {
    try {
      const b = await deps.supplierBreakdown(sql, tenantId, jobId);
      const linesByInvoice = new Map();
      for (const l of b.lines || []) {
        const list = linesByInvoice.get(l.invoiceId) || [];
        list.push(l);
        linesByInvoice.set(l.invoiceId, list);
      }
      for (const inv of b.invoices || []) {
        const lines = linesByInvoice.get(inv.invoiceId) || [];
        const sum = lines.reduce((s, l) => s + (Number.isInteger(l.signedCents) ? l.signedCents : 0), 0);
        const head = {
          invoiceId: inv.invoiceId,
          supplier: inv.supplierName || 'Unknown supplier',
          number: inv.supplierInvoiceNumber || null,
          date: inv.invoiceDate ? String(inv.invoiceDate).slice(0, 10) : null,
          credit: inv.documentType === 'credit_note',
        };
        // The lines are only offered one by one when they ADD UP to what was
        // booked to this job. An invoice split across jobs, or one whose
        // lines weren't read, is offered as the one amount booked here —
        // never as lines that would overstate this job's cost.
        if (lines.length > 0 && sum === inv.amountCents) {
          for (const l of lines) {
            supplier.lines.push({
              ...head,
              id: l.id,
              description: l.description,
              quantity: l.quantity,
              unit: l.unit,
              unitCostCents: l.unitPriceCents,
              costCents: l.signedCents,
            });
          }
        } else if (Number.isInteger(inv.amountCents)) {
          supplier.whole.push({ ...head, id: inv.invoiceId, costCents: inv.amountCents, lineCount: lines.length });
        }
      }
      supplier.available = true;
    } catch (e) {
      console.error('[customer-invoices] billable: supplier invoices unreadable', { code: (e && e.code) || 'db' });
      supplier.reason = 'unreadable';
    }
  }

  // ── dockets typed into the job's materials ledger ──
  const ledger = { available: false, reason: flags.ledger ? null : 'off', lines: [] };
  if (flags.ledger) {
    try {
      const data = await deps.ledger(jobId);
      ledger.lines = (deps.ledgerLines(data) || [])
        .filter((l) => l && typeof l.id === 'string' && Number.isInteger(l.amountCents))
        .map((l) => ({
          id: l.id,
          date: l.date || null,
          supplier: l.supplier || 'Unknown supplier',
          description: l.description || null,
          number: l.reference || null,
          costCents: l.amountCents,
        }))
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
      ledger.available = true;
    } catch (e) {
      console.error('[customer-invoices] billable: materials ledger unreadable', { code: (e && e.code) || 'blob' });
      ledger.reason = 'unreadable';
    }
  }

  return { labour, supplier, ledger };
}

/**
 * The sources, each marked with what is already on an invoice — what the
 * "Add from this job" picker shows, and the job's "not yet on an invoice".
 */
function present(sources, rows, { excludeInvoiceId = null } = {}) {
  const idx = billedIndex(rows, { excludeInvoiceId });
  const days = sources.labour.days.map((d) => {
    const billed = Math.min(d.milli, idx.hours.get(hourKey(d.userId, d.date)) || 0);
    return {
      userId: d.userId,
      name: d.name,
      date: d.date,
      hoursMilli: d.milli,
      billedMilli: billed,
      unbilledMilli: d.milli - billed,
      onInvoice: billed > 0 ? idx.hoursOn.get(hourKey(d.userId, d.date)) || null : null,
      chargeOutRateCents: d.chargeOutRateCents,
      costRateCents: d.costRateCents,
      hasCostRate: d.costRateCents != null,
    };
  });
  const mark = (t) => (x) => ({ ...x, onInvoice: idx.ids.get(`${t}:${x.id}`) || null });
  const supplierLines = sources.supplier.lines.map(mark('sl'));
  const supplierWhole = sources.supplier.whole.map(mark('si'));
  const ledgerLines = sources.ledger.lines.map(mark('ml'));

  const unbilledMilli = days.reduce((s, d) => s + d.unbilledMilli, 0);
  const materialUnbilled = [...supplierLines, ...supplierWhole, ...ledgerLines].filter((m) => !m.onInvoice);
  return {
    labour: {
      available: sources.labour.available,
      reason: sources.labour.reason,
      days,
      pendingMilli: sources.labour.pendingMilli,
    },
    supplier: { available: sources.supplier.available, reason: sources.supplier.reason, lines: supplierLines, whole: supplierWhole },
    ledger: { available: sources.ledger.available, reason: sources.ledger.reason, lines: ledgerLines },
    summary: {
      unbilledHoursMilli: unbilledMilli,
      unbilledMaterialCount: materialUnbilled.length,
      unbilledMaterialCostCents: materialUnbilled.reduce((s, m) => s + m.costCents, 0),
      // anything at all on this job has been put on an invoice from its data
      anyBilled: idx.hours.size > 0 || Array.from(idx.ids.keys()).some((k) => !k.startsWith('v:')),
    },
  };
}

class BillableError extends Error {
  /** @param {string} code  a stable code the handler answers with */
  constructor(code, extra) {
    super(code);
    this.name = 'BillableError';
    this.code = code;
    this.extra = extra || {};
  }
}

/** Does any line of these items bill job data (so the sources must be read)? */
function needsSources(items) {
  return (Array.isArray(items) ? items : []).some(
    (it) => it && Array.isArray(it.refs) && it.refs.some((r) => r && r.t !== 'v')
  );
}

/**
 * Check an itemised invoice's lines against the job's data and stamp each one
 * with what it cost. Throws BillableError when a line bills something that
 * isn't on the job, or that another invoice already holds.
 *
 * @param {{ items: object[], sources: object|null, rows: object[],
 *           variations: object[], excludeInvoiceId?: string|null }} ctx
 * @returns {object[]} the items as they will be stored
 */
function resolveItems(ctx) {
  const { items, sources, rows, variations } = ctx;
  const idx = billedIndex(rows, { excludeInvoiceId: ctx.excludeInvoiceId || null });
  const dayByKey = new Map();
  const cost = new Map();
  if (sources) {
    for (const d of sources.labour.days) dayByKey.set(hourKey(d.userId, d.date), d);
    for (const l of sources.supplier.lines) cost.set(`sl:${l.id}`, l.costCents);
    for (const l of sources.supplier.whole) cost.set(`si:${l.id}`, l.costCents);
    for (const l of sources.ledger.lines) cost.set(`ml:${l.id}`, l.costCents);
  }
  const variationById = new Map((variations || []).map((v) => [v.id, v]));
  // Within this one invoice, too: nothing may be billed by two of its lines.
  const seenIds = new Set();
  const seenHours = new Map();
  const out = [];

  for (const raw of items) {
    if (raw.type === 'note') {
      out.push({ id: raw.id, type: 'note', description: raw.description });
      continue;
    }
    const refs = Array.isArray(raw.refs) ? raw.refs : [];
    if (refs.length > MAX_REFS_PER_LINE) throw new BillableError('too_many_refs');
    const item = {
      id: raw.id,
      type: 'line',
      description: raw.description,
      quantityMilli: raw.quantityMilli,
      unit: raw.unit || null,
      unitCents: raw.unitCents,
      source: 'manual',
      costCents: null,
      refs: [],
    };
    if (lineAmountCents(item.quantityMilli, item.unitCents) == null) throw new BillableError('line_invalid');

    if (refs.length === 0) {
      // A typed line may carry the office's own cost figure; it is theirs.
      item.source = raw.source === 'labour' || raw.source === 'material' ? raw.source : 'manual';
      item.costCents = Number.isInteger(raw.costCents) && raw.costCents >= 0 ? raw.costCents : null;
      out.push(item);
      continue;
    }

    const kinds = new Set(refs.map((r) => (r && r.t === 'h' ? 'labour' : r && r.t === 'v' ? 'variation' : 'material')));
    if (kinds.size !== 1) throw new BillableError('mixed_refs');
    item.source = Array.from(kinds)[0];

    let costCents = 0;
    let costKnown = true;
    for (const r of refs) {
      if (!r || typeof r !== 'object') throw new BillableError('ref_invalid');
      if (r.t === 'h') {
        if (typeof r.u !== 'string' || !DAY.test(String(r.d)) || !Number.isInteger(r.m) || r.m <= 0) throw new BillableError('ref_invalid');
        const k = hourKey(r.u, r.d);
        const day = dayByKey.get(k);
        if (!day) throw new BillableError('ref_not_found', { what: 'hours' });
        const taken = (idx.hours.get(k) || 0) + (seenHours.get(k) || 0);
        if (r.m > day.milli - taken) {
          throw new BillableError('already_billed', { what: 'hours', on: idx.hoursOn.get(k) || null });
        }
        seenHours.set(k, (seenHours.get(k) || 0) + r.m);
        const c = day.costRateCents == null ? null : hoursCost(r.m, day.costRateCents);
        if (c == null) costKnown = false; else costCents += c;
        item.refs.push({ t: 'h', u: r.u, d: r.d, m: r.m });
      } else if (r.t === 'sl' || r.t === 'si' || r.t === 'ml') {
        if (typeof r.id !== 'string' || !r.id) throw new BillableError('ref_invalid');
        const k = `${r.t}:${r.id}`;
        if (!cost.has(k)) throw new BillableError('ref_not_found', { what: 'materials' });
        if (idx.ids.has(k) || seenIds.has(k)) {
          throw new BillableError('already_billed', { what: 'materials', on: idx.ids.get(k) || null });
        }
        seenIds.add(k);
        costCents += cost.get(k);
        item.refs.push({ t: r.t, id: r.id });
      } else if (r.t === 'v') {
        if (refs.length !== 1) throw new BillableError('mixed_refs');
        const v = variationById.get(r.id);
        if (!v) throw new BillableError('ref_not_found', { what: 'variation' });
        if (v.status !== 'approved' || !Number.isInteger(v.approvedCents)) throw new BillableError('variation_not_approved');
        const k = `v:${r.id}`;
        if (idx.ids.has(k) || seenIds.has(k)) throw new BillableError('already_billed', { what: 'variation', on: idx.ids.get(k) || null });
        seenIds.add(k);
        // An approved variation is billed once, at what was approved.
        if (lineAmountCents(item.quantityMilli, item.unitCents) !== v.approvedCents) throw new BillableError('variation_amount');
        costKnown = false; // a variation's cost isn't known here
        item.refs.push({ t: 'v', id: r.id });
      } else {
        throw new BillableError('ref_invalid');
      }
    }
    item.costCents = costKnown && item.source !== 'variation' ? costCents : null;
    out.push(item);
  }
  return out;
}

/**
 * A stage's extra lines that bill a variation: each must be approved, not on
 * another invoice, and billed at exactly what was approved.
 */
function checkVariationLines({ extraLines, rows, variations, excludeInvoiceId }) {
  const idx = billedIndex(rows, { excludeInvoiceId: excludeInvoiceId || null });
  const byId = new Map((variations || []).map((v) => [v.id, v]));
  const seen = new Set();
  for (const l of Array.isArray(extraLines) ? extraLines : []) {
    if (!l || !l.variationId) continue;
    const v = byId.get(l.variationId);
    if (!v) throw new BillableError('ref_not_found', { what: 'variation' });
    if (v.status !== 'approved' || !Number.isInteger(v.approvedCents)) throw new BillableError('variation_not_approved');
    const k = `v:${l.variationId}`;
    if (idx.ids.has(k) || seen.has(k)) throw new BillableError('already_billed', { what: 'variation', on: idx.ids.get(k) || null });
    seen.add(k);
    if (l.amountCents !== v.approvedCents) throw new BillableError('variation_amount');
  }
}

/** Which invoice (if any) each variation is on. */
function variationBilling(rows) {
  const idx = billedIndex(rows);
  const out = new Map();
  for (const [k, label] of idx.ids) if (k.startsWith('v:')) out.set(k.slice(2), label);
  return out;
}

module.exports = {
  MAX_REFS_PER_LINE,
  BillableError,
  hoursMilli,
  hoursCost,
  holdsItsRefs,
  billedIndex,
  loadSources,
  present,
  needsSources,
  resolveItems,
  checkVariationLines,
  variationBilling,
};
