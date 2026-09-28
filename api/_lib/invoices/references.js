'use strict';
// Several job references on one document (remediation Task E, 2026-09-27).
//
// A supplier invoice that prints SEVERAL different IV job references is, by
// its own words, a cost that belongs to more than one job. BuhlOS cannot
// split one invoice across jobs (one active allocation per invoice —
// migration 20260915100000, docs/invoice-capture.md "Deliberately deferred"),
// so such a document must never be booked as one job's whole cost by
// accident: not by the sweep, not by a one-click confirm after someone picked
// a job. This module is the ONE place that decides "does this document carry
// several references", from the extraction evidence that survives every later
// edit (`iv_candidates` — `match_reason.distinct` is replaced the moment a
// person chooses a job, so it is not a safe source).
const { selectIvReference } = require('./iv-match');

/**
 * The distinct normalised IV codes the document is judged to reference, by
 * the same selection rule the matcher uses (labelled references outrank
 * unlabelled text). Empty when there is no evidence. Pure.
 * @param {{ ivCandidates?: unknown }} inv
 * @returns {string[]}
 */
function documentReferences(inv) {
  const candidates = inv && Array.isArray(inv.ivCandidates) ? inv.ivCandidates : [];
  if (!candidates.length) return [];
  const sel = selectIvReference(candidates);
  if (!sel) return [];
  if (sel.outcome === 'multi_reference') return Array.isArray(sel.distinct) ? sel.distinct.slice() : [];
  if (sel.outcome === 'selected' && sel.normalised) return [sel.normalised];
  return [];
}

/** True when the document references more than one job. Pure. */
function hasMultipleReferences(inv) {
  return documentReferences(inv).length > 1;
}

const OVERRIDE_REASON_MIN = 3;
const OVERRIDE_REASON_MAX = 200;

/**
 * The explicit, reasoned "allocate the WHOLE invoice to one job anyway"
 * decision on a confirm body → { reason } | null (not attempted) | { error }.
 * Pure.
 */
function parseWholeInvoiceOverride(body) {
  const b = body || {};
  if (b.wholeInvoice !== true) return null;
  const reason = String(b.reason == null ? '' : b.reason).trim();
  if (reason.length < OVERRIDE_REASON_MIN) return { error: 'reason_required' };
  return { reason: reason.slice(0, OVERRIDE_REASON_MAX) };
}

module.exports = { documentReferences, hasMultipleReferences, parseWholeInvoiceOverride };
