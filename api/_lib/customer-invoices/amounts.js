'use strict';

// Customer stage-invoice money maths — INTEGER CENTS ONLY, pure, no I/O.
// (docs/architecture/customer-invoicing-boundary-adr.md rule 12; same
// discipline as api/_lib/invoices/money.js.) Percentages are basis points
// (500 = 5%). A figure that cannot be worked out is `null` — never 0 (P7).
//
// Two kinds of figure, kept apart on purpose:
//   * BuhlOS's own arithmetic — only for stages NOT yet sent (planned), and
//     for the snapshot frozen at send.
//   * Xero's figures — for anything sent. "Xero's figures win" (ADR rule 6):
//     invoiced / paid / due come from the xero* mirror, never recomputed.

const MAX_CENTS = 100_000_000_00; // $100,000,000 — typo guard, not a policy
const BP_WHOLE = 10000;

const LIVE_XERO = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID']);
const DEAD_XERO = new Set(['VOIDED', 'DELETED']);
const APPROVED_XERO = new Set(['AUTHORISED', 'PAID']);

function isCents(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX_CENTS;
}
function isBp(v) {
  return Number.isInteger(v) && v >= 0 && v <= BP_WHOLE;
}

/** amount × bp / 10000, rounded half-up to the cent. Integer in, integer out. */
function portionCents(amountCents, bp) {
  if (!Number.isInteger(amountCents) || !isBp(bp)) return null;
  // amountCents ≤ 1e10 and bp ≤ 1e4 → product ≤ 1e14, exact in a double.
  return Math.floor((amountCents * bp + BP_WHOLE / 2) / BP_WHOLE);
}

/** Dollars on the job record (job.contractValue) → cents, or null when unset. */
function contractCentsOf(contractValue) {
  if (contractValue == null) return null;
  const n = Number(contractValue);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function extraLinesOf(stage) {
  const raw = stage && Array.isArray(stage.extraLines) ? stage.extraLines : [];
  return raw.filter((l) => l && typeof l.description === 'string' && Number.isInteger(l.amountCents));
}

// ── itemised invoices: quantity × unit price ────────────────────────────────
//
// A quantity is an integer number of THOUSANDTHS (2.5 hours = 2500), a unit
// price is integer cents, so a line total is worked out in integers and
// rounded once. Bounds keep quantity × price inside exact integer range.
const MAX_ITEMS = 100;
const MAX_QUANTITY_MILLI = 100_000_000; // 100,000 units
const MAX_UNIT_CENTS = 10_000_000; // $100,000 a unit

/**
 * quantity (thousandths) × unit price (cents) → the line total in cents,
 * rounded half AWAY from zero (so a discount line rounds the same way as a
 * charge). Null when either figure is unusable. Xero does not document which
 * way it rounds an exact half cent; a line it rounds differently is caught by
 * the read-back after a send, never assumed away.
 */
function lineAmountCents(quantityMilli, unitCents) {
  if (!Number.isInteger(quantityMilli) || quantityMilli <= 0 || quantityMilli > MAX_QUANTITY_MILLI) return null;
  if (!Number.isInteger(unitCents) || Math.abs(unitCents) > MAX_UNIT_CENTS) return null;
  const product = quantityMilli * Math.abs(unitCents);
  const cents = Math.floor((product + 500) / 1000);
  // `|| 0`: a zero price must be 0, never -0 (it would not equal 0 in a compare).
  return (unitCents < 0 ? -cents : cents) || 0;
}

/**
 * An itemised invoice's lines, normalised. Two kinds:
 *   line  a charge — description, quantity, unit price (may be negative for a
 *         discount or credit), optional unit label
 *   note  wording only (the work done, a heading); carries no amount
 * `source` says where a charge came from (typed, or pulled from the job's
 * hours / materials / an approved variation); `costCents` is what it cost the
 * business and `refs` what job data it bills. Cost and refs are BuhlOS's own —
 * they are never sent to Xero.
 */
function itemsOf(stage) {
  const raw = stage && Array.isArray(stage.items) ? stage.items : [];
  const out = [];
  for (const it of raw) {
    if (!it || typeof it.description !== 'string' || !it.description.trim()) continue;
    if (it.type === 'note') {
      out.push({ id: String(it.id || ''), type: 'note', description: it.description });
      continue;
    }
    const amountCents = lineAmountCents(it.quantityMilli, it.unitCents);
    if (amountCents == null) continue;
    out.push({
      id: String(it.id || ''),
      type: 'line',
      description: it.description,
      quantityMilli: it.quantityMilli,
      unit: typeof it.unit === 'string' && it.unit.trim() ? it.unit.trim() : null,
      unitCents: it.unitCents,
      amountCents,
      source: ['labour', 'material', 'variation'].includes(it.source) ? it.source : 'manual',
      // may be negative: a supplier credit note billed through is a negative cost
      costCents: Number.isInteger(it.costCents) ? it.costCents : null,
      refs: Array.isArray(it.refs) ? it.refs : [],
    });
  }
  return out;
}

/**
 * What an itemised invoice adds up to, and what it cost. `costKnown` is false
 * when any charge that came from the job's hours or materials has no cost on
 * it — the margin is then not shown rather than overstated.
 */
function itemsSummary(stage) {
  const lines = itemsOf(stage).filter((l) => l.type === 'line');
  let totalCents = 0;
  let costCents = 0;
  let costedSellCents = 0;
  let costKnown = lines.length > 0;
  const bySource = { labour: 0, material: 0, variation: 0, manual: 0 };
  for (const l of lines) {
    totalCents += l.amountCents;
    bySource[l.source] += l.amountCents;
    if (l.costCents != null) {
      costCents += l.costCents;
      costedSellCents += l.amountCents;
    } else if (l.source === 'labour' || l.source === 'material') {
      costKnown = false;
    }
  }
  return { lineCount: lines.length, totalCents, costCents, costedSellCents, costKnown, bySource };
}

/** The retention % that applies to a stage: its own override, else the job's.
 *  A retention release never has retention taken from it. */
function effectiveRetentionBp(stage, profileRetentionBp) {
  if (stage && stage.kind === 'retention_release') return 0;
  if (stage && isBp(stage.retentionBp)) return stage.retentionBp;
  return isBp(profileRetentionBp) ? profileRetentionBp : 0;
}

/**
 * What a NOT-YET-SENT stage works out to, from its own content and the job's
 * current contract value. Returns nulls (with a `reason`) when it cannot be
 * worked out — e.g. a % stage on a job with no contract value.
 *
 * @param {{ kind?: string, basis: 'amount'|'percent', amountCents?: number|null,
 *           percentBp?: number|null, extraLines?: Array<{description:string, amountCents:number}>,
 *           retentionBp?: number|null }} stage
 * @param {{ contractCents: number|null, retentionBp?: number }} ctx
 * @returns {{ baseCents: number|null, extrasCents: number, grossCents: number|null,
 *             retentionBp: number, retentionCents: number|null, netCents: number|null,
 *             reason: null|'no_contract_value'|'no_lines'|'invalid' }}
 */
function computeStage(stage, ctx) {
  const contractCents = ctx && Number.isInteger(ctx.contractCents) ? ctx.contractCents : null;
  const retentionBp = effectiveRetentionBp(stage, ctx && ctx.retentionBp);
  const extrasCents = extraLinesOf(stage).reduce((s, l) => s + l.amountCents, 0);
  const none = (reason) => ({
    baseCents: null, extrasCents, grossCents: null, retentionBp, retentionCents: null, netCents: null, reason,
  });

  let baseCents;
  if (stage && stage.kind === 'itemised') {
    // The lines ARE the amount; the stored amount is never trusted over them.
    const s = itemsSummary(stage);
    if (s.lineCount === 0) return none('no_lines');
    baseCents = s.totalCents;
    if (baseCents < 0) return none('invalid');
  } else if (stage && stage.basis === 'percent') {
    if (!isBp(stage.percentBp) || stage.percentBp === 0) return none('invalid');
    if (contractCents == null) return none('no_contract_value');
    baseCents = portionCents(contractCents, stage.percentBp);
  } else {
    if (!stage || !isCents(stage.amountCents)) return none('invalid');
    baseCents = stage.amountCents;
  }
  const grossCents = baseCents + extrasCents;
  if (!isCents(grossCents)) return none('invalid');
  const retentionCents = portionCents(grossCents, retentionBp);
  return {
    baseCents, extrasCents, grossCents, retentionBp, retentionCents,
    netCents: grossCents - retentionCents, reason: null,
  };
}

/** True for a sent row whose Xero invoice still exists (not voided / deleted). */
function isLiveSent(row) {
  return !!row && row.state === 'sent' && !DEAD_XERO.has(String(row.xeroStatus || ''));
}

/** GST-inclusive amount → its ex-GST share, pro rata on Xero's own subtotal /
 *  total for that invoice. Null when Xero gave no usable total. */
function exGstShare(amountIncCents, subtotalCents, totalCents) {
  if (!Number.isInteger(amountIncCents)) return null;
  if (!Number.isInteger(subtotalCents) || !Number.isInteger(totalCents) || totalCents <= 0) return null;
  return Math.round((amountIncCents * subtotalCents) / totalCents);
}

/**
 * Roll a job's stages up into the figures the Money card shows.
 *
 * `claimedCents` is measured against the CONTRACT, so it is the gross of each
 * live sent stage (before retention — retention is still contract money) and
 * excludes retention releases (they release money already claimed).
 *
 * @param {Array<object>} rows  mapped stage rows (camelCase, cents as numbers)
 * @param {{ contractCents: number|null, retentionBp?: number, variations?: Array<object> }} ctx
 */
function jobTotals(rows, ctx) {
  const contractCents = ctx && Number.isInteger(ctx.contractCents) ? ctx.contractCents : null;
  const list = Array.isArray(rows) ? rows : [];

  let plannedGrossCents = 0;
  let plannedNetCents = 0;
  let plannedCount = 0;
  let unresolvedCount = 0;
  let claimedCents = 0;
  let retentionTakenCents = 0;
  let retentionReleasedCents = 0;
  let draftedCents = 0;
  let invoicedCents = 0;
  let paidIncGstCents = 0;
  let paidCents = 0;
  let dueIncGstCents = 0;
  let sentCount = 0;
  let unknownPaid = false;

  for (const r of list) {
    if (!r) continue;
    if (r.state === 'planned' || r.state === 'failed' || r.state === 'sending') {
      // Not in Xero (or not known to be): BuhlOS's own arithmetic.
      const frozen = r.state !== 'planned' && Number.isInteger(r.grossCents);
      const c = frozen
        ? { grossCents: r.grossCents, netCents: r.netCents, reason: null }
        : computeStage(r, { contractCents, retentionBp: ctx && ctx.retentionBp });
      plannedCount += 1;
      if (c.grossCents == null) { unresolvedCount += 1; continue; }
      if (r.kind !== 'retention_release') plannedGrossCents += c.grossCents;
      plannedNetCents += c.netCents;
      continue;
    }
    if (!isLiveSent(r)) continue;
    sentCount += 1;
    if (r.kind === 'retention_release') {
      retentionReleasedCents += Number.isInteger(r.grossCents) ? r.grossCents : 0;
    } else {
      claimedCents += Number.isInteger(r.grossCents) ? r.grossCents : 0;
      retentionTakenCents += Number.isInteger(r.retentionCents) ? r.retentionCents : 0;
    }
    const sub = Number.isInteger(r.xeroSubtotalCents) ? r.xeroSubtotalCents : null;
    if (APPROVED_XERO.has(String(r.xeroStatus || ''))) {
      if (sub != null) invoicedCents += sub;
      const paidInc = Number.isInteger(r.xeroAmountPaidCents) ? r.xeroAmountPaidCents : 0;
      paidIncGstCents += paidInc;
      dueIncGstCents += Number.isInteger(r.xeroAmountDueCents) ? r.xeroAmountDueCents : 0;
      if (paidInc > 0) {
        const ex = exGstShare(paidInc, sub, r.xeroTotalCents);
        if (ex == null) unknownPaid = true; else paidCents += ex;
      }
    } else if (sub != null) {
      draftedCents += sub;
    }
  }

  // ── variations (#1163): approved ones are part of what the job is worth ──
  let variationsApprovedCents = 0;
  let variationsApprovedCount = 0;
  let variationsPendingCents = 0;
  let variationsPendingCount = 0;
  let variationsUnpricedCount = 0;
  for (const v of Array.isArray(ctx && ctx.variations) ? ctx.variations : []) {
    if (!v) continue;
    if (v.status === 'approved' && Number.isInteger(v.approvedCents)) {
      variationsApprovedCents += v.approvedCents;
      variationsApprovedCount += 1;
    } else if (v.status === 'proposed') {
      variationsPendingCount += 1;
      if (Number.isInteger(v.quotedCents)) variationsPendingCents += v.quotedCents;
      else variationsUnpricedCount += 1;
    }
  }
  // "Contract + approved variations": what there is to invoice in the end.
  const revisedContractCents = contractCents == null ? null : contractCents + variationsApprovedCents;

  const committedCents = claimedCents + plannedGrossCents;
  return {
    contractCents,
    revisedContractCents,
    variationsApprovedCents,
    variationsApprovedCount,
    variationsPendingCents,
    variationsPendingCount,
    variationsUnpricedCount,
    plannedCount,
    plannedGrossCents,
    plannedNetCents,
    unresolvedCount,
    sentCount,
    claimedCents,
    stillToInvoiceCents: revisedContractCents == null ? null : revisedContractCents - claimedCents,
    overContract: revisedContractCents != null && committedCents > revisedContractCents,
    retentionHeldCents: Math.max(0, retentionTakenCents - retentionReleasedCents),
    draftedCents,
    invoicedCents,
    paidCents: unknownPaid ? null : paidCents,
    paidIncGstCents,
    dueIncGstCents,
  };
}

module.exports = {
  MAX_CENTS,
  BP_WHOLE,
  LIVE_XERO,
  DEAD_XERO,
  APPROVED_XERO,
  isCents,
  isBp,
  portionCents,
  contractCentsOf,
  MAX_ITEMS,
  MAX_QUANTITY_MILLI,
  MAX_UNIT_CENTS,
  lineAmountCents,
  itemsOf,
  itemsSummary,
  effectiveRetentionBp,
  computeStage,
  isLiveSent,
  exGstShare,
  jobTotals,
};
