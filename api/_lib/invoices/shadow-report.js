'use strict';
// Automatic-booking SHADOW COMPARISON (remediation Task F, 2026-09-27).
//
// Every matched invoice gets an automatic-booking verdict even while the
// knob is off (pipeline.scheduleAutoBooking → event auto_confirm_eligible /
// auto_confirm_ineligible / auto_confirm_scheduled). This module compares
// that verdict with what a person eventually did, from the invoice's own
// history — allocations and events — so the owner can decide, on evidence,
// whether automatic booking is safe. It is PURE: the store gathers rows, this
// file judges them, the handler serialises the result.
//
// Honesty rules baked in:
//   * an invoice with no human outcome yet is UNRESOLVED — never "correct",
//     never "wrong";
//   * a verdict recorded before the detail carried a job/figures snapshot is
//     LEGACY — the job is taken from the `matched` event just before it, the
//     amount from the `under_cap` check when present, and anything still
//     unknown is counted as unknown, not as agreement;
//   * an invoice that was never evaluated (went straight to review) is not a
//     shadow decision and is counted apart.
const VERDICT_EVENTS = new Set(['auto_confirm_eligible', 'auto_confirm_ineligible', 'auto_confirm_scheduled']);
const REJECTED_STATUSES = new Set(['excluded', 'duplicate', 'archived']);
const UNRESOLVED_STATUSES = new Set(['received', 'processing', 'needs_review', 'matched', 'failed']);
const { AUTO_ACTOR } = require('./auto-confirm');

/** The automatic booker is identified by its actor identity (id / name), never by a role string. */
function isSystem(ev) {
  const a = ev && ev.actor;
  if (a && typeof a === 'object') return a.id === AUTO_ACTOR.id || a.name === AUTO_ACTOR.name;
  return ev.actorId === AUTO_ACTOR.id || a === AUTO_ACTOR.name;
}
function ts(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}
function byTime(a, b) {
  return ts(a.at || a.createdAt) - ts(b.at || b.createdAt);
}
function legacyAmountFromChecks(checks) {
  const c = Array.isArray(checks) ? checks.find((x) => x && x.code === 'under_cap' && typeof x.detail === 'string') : null;
  if (!c) return null;
  const m = /^(-?\d+) </.exec(c.detail);
  return m ? Number(m[1]) : null;
}
function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/**
 * Judge ONE invoice. Exported for tests.
 * @param {object} inv invoice row (store.invoiceRow shape + autoConfirmChecks)
 * @param {Array} events this invoice's events, any order
 * @param {Array} allocations this invoice's allocations (allocationRow shape)
 */
function judgeInvoice(inv, events, allocations) {
  const evs = (events || []).slice().sort(byTime);
  const verdicts = evs.filter((e) => VERDICT_EVENTS.has(e.event));
  if (!verdicts.length) return { invoiceId: inv.id, kind: 'never_evaluated' };
  const verdict = verdicts[verdicts.length - 1];
  const vAt = ts(verdict.at || verdict.createdAt);
  const d = verdict.detail || {};
  const eligible = verdict.event !== 'auto_confirm_ineligible';

  // What the evaluator judged: job + figures at the time of the verdict.
  const matchedBefore = evs.filter((e) => e.event === 'matched' && ts(e.at || e.createdAt) <= vAt).pop();
  const verdictJob = d.jobId || (matchedBefore && matchedBefore.detail && matchedBefore.detail.jobId) || null;
  const legacy = !('jobId' in d) || !('amountCents' in d);
  const verdictAmount = Number.isInteger(d.amountCents) ? d.amountCents : legacyAmountFromChecks(inv.autoConfirmChecks);
  const verdictSupplier = d.supplierKey === undefined ? null : d.supplierKey;

  // What people did afterwards.
  const confirmedEvents = evs.filter((e) => e.event === 'confirmed');
  const lastConfirm = confirmedEvents[confirmedEvents.length - 1] || null;
  const active = (allocations || []).find((a) => a.status === 'active') || null;
  const anyAllocation = (allocations || []).length > 0;
  const editsAfter = evs.filter((e) => ts(e.at || e.createdAt) > vAt && (e.event === 'corrected' || e.event === 'job_selected' || e.event === 'reassigned'));
  const humanRejected = REJECTED_STATUSES.has(inv.status) && !(inv.status === 'excluded' && String(inv.excludedReason || '').startsWith('not_an_invoice:'));
  const setAside = inv.status === 'excluded' && String(inv.excludedReason || '').startsWith('not_an_invoice:');

  const base = {
    invoiceId: inv.id,
    supplierKey: inv.supplierKey || null,
    supplierName: inv.supplierName || null,
    supplierInvoiceNumber: inv.supplierInvoiceNumber || null,
    eligible,
    legacy,
    failedChecks: Array.isArray(d.failed) ? d.failed.slice() : [],
  };

  // Paperwork the reader set aside (docket, order confirmation, …) is not a
  // person's verdict on the evaluator: counted apart, never as agreement.
  if (setAside && !lastConfirm) return { ...base, kind: 'set_aside' };

  if (!lastConfirm && !humanRejected) {
    return { ...base, kind: 'unresolved', status: inv.status };
  }

  if (lastConfirm) {
    const bookedBySystem = isSystem(lastConfirm);
    const finalJob = active ? active.jobId : (lastConfirm.detail && lastConfirm.detail.jobId) || null;
    const finalAmount = active ? active.amountCents : (lastConfirm.detail && Number.isInteger(lastConfirm.detail.amountCents) ? lastConfirm.detail.amountCents : null);
    const jobAgreement = verdictJob && finalJob ? (verdictJob === finalJob ? 'agree' : 'differ') : 'unknown';
    const figuresAgreement = Number.isInteger(verdictAmount) && Number.isInteger(finalAmount) ? (verdictAmount === finalAmount ? 'agree' : 'differ') : 'unknown';
    const supplierAgreement = verdictSupplier === null ? 'unknown' : (verdictSupplier || null) === (inv.supplierKey || null) ? 'agree' : 'differ';
    const reversed = !active && anyAllocation;
    const reasons = [];
    if (jobAgreement === 'differ') reasons.push('job_changed');
    if (figuresAgreement === 'differ') reasons.push('figures_changed');
    if (supplierAgreement === 'differ') reasons.push('supplier_changed');
    if (bookedBySystem) {
      return { ...base, kind: reversed ? 'auto_booked_then_reversed' : 'auto_booked_stands', jobAgreement, figuresAgreement, supplierAgreement, reasons: reversed ? ['reversed_by_person', ...reasons] : reasons, finalJob, verdictJob };
    }
    if (eligible) {
      const agreed = jobAgreement !== 'differ' && figuresAgreement !== 'differ' && supplierAgreement !== 'differ' && !reversed;
      return { ...base, kind: agreed ? 'agreed' : 'false_positive', jobAgreement, figuresAgreement, supplierAgreement, reasons: reversed ? ['reversed_by_person', ...reasons] : reasons, finalJob, verdictJob };
    }
    // Ineligible verdict, yet a person booked it.
    const untouched = editsAfter.length === 0 && jobAgreement !== 'differ' && figuresAgreement !== 'differ';
    return { ...base, kind: untouched ? 'false_negative' : 'waited_correctly', jobAgreement, figuresAgreement, supplierAgreement, reasons: untouched ? base.failedChecks : editsAfter.map((e) => e.event), finalJob, verdictJob };
  }

  // Rejected by a person (or set aside) without ever being confirmed.
  const rejection = inv.status === 'duplicate' ? 'marked_duplicate' : inv.status;
  if (eligible) return { ...base, kind: 'false_positive', jobAgreement: 'unknown', figuresAgreement: 'unknown', supplierAgreement: 'unknown', reasons: [`${rejection}_by_person`], finalJob: null, verdictJob };
  return { ...base, kind: 'waited_correctly', jobAgreement: 'unknown', figuresAgreement: 'unknown', supplierAgreement: 'unknown', reasons: [`${rejection}_by_person`], finalJob: null, verdictJob };
}

function emptySupplier(key, name) {
  return { supplierKey: key, supplierName: name, sample: 0, wouldHaveBooked: 0, agreed: 0, falsePositives: 0, falseNegatives: 0, unresolved: 0, autoBooked: 0, autoBookedThenReversed: 0 };
}

/**
 * The report. Pure.
 * @param {{ invoices: Array, events: Array, allocations: Array, from: string, to: string, generatedAt?: string }} input
 */
function buildShadowReport({ invoices, events, allocations, from, to, generatedAt }) {
  const eventsByInvoice = new Map();
  for (const e of events || []) {
    const list = eventsByInvoice.get(e.invoiceId) || [];
    list.push(e);
    eventsByInvoice.set(e.invoiceId, list);
  }
  const allocsByInvoice = new Map();
  for (const a of allocations || []) {
    const list = allocsByInvoice.get(a.invoiceId) || [];
    list.push(a);
    allocsByInvoice.set(a.invoiceId, list);
  }

  const out = {
    period: { from, to },
    generatedAt: generatedAt || new Date().toISOString(),
    invoicesInPeriod: (invoices || []).length,
    sampleSize: 0,
    neverEvaluated: 0,
    setAside: 0,
    legacyVerdicts: 0,
    wouldHaveBooked: { count: 0, agreed: 0, falsePositives: 0, unresolved: 0, autoBookedStands: 0, autoBookedThenReversed: 0, falsePositiveReasons: {} },
    wouldHaveWaited: { count: 0, correct: 0, falseNegatives: 0, unresolved: 0, falseNegativeReasons: {} },
    agreement: {
      job: { agree: 0, differ: 0, unknown: 0 },
      supplier: { agree: 0, differ: 0, unknown: 0 },
      figures: { agree: 0, differ: 0, unknown: 0 },
    },
    humanExclusions: 0,
    humanJobChanges: 0,
    unresolved: 0,
    disagreements: [],
    bySupplier: [],
  };
  const suppliers = new Map();

  for (const inv of invoices || []) {
    const j = judgeInvoice(inv, eventsByInvoice.get(inv.id) || [], allocsByInvoice.get(inv.id) || []);
    if (j.kind === 'never_evaluated') {
      out.neverEvaluated += 1;
      continue;
    }
    if (j.kind === 'set_aside') {
      out.setAside += 1;
      continue;
    }
    out.sampleSize += 1;
    if (j.legacy) out.legacyVerdicts += 1;
    const key = j.supplierKey || '(unknown supplier)';
    if (!suppliers.has(key)) suppliers.set(key, emptySupplier(j.supplierKey, j.supplierName));
    const s = suppliers.get(key);
    s.sample += 1;
    if (j.eligible) s.wouldHaveBooked += 1;

    if (j.kind === 'unresolved') {
      out.unresolved += 1;
      s.unresolved += 1;
      if (j.eligible) out.wouldHaveBooked.unresolved += 1;
      else out.wouldHaveWaited.unresolved += 1;
      if (j.eligible) out.wouldHaveBooked.count += 1;
      else out.wouldHaveWaited.count += 1;
      continue;
    }

    for (const dim of ['job', 'supplier', 'figures']) {
      const v = j[`${dim}Agreement`] || 'unknown';
      out.agreement[dim][v] += 1;
    }
    if (j.jobAgreement === 'differ') out.humanJobChanges += 1;
    if ((j.reasons || []).some((r) => r === 'excluded_by_person' || r === 'reversed_by_person' || r === 'marked_duplicate_by_person' || r === 'archived_by_person')) out.humanExclusions += 1;

    if (j.eligible) {
      out.wouldHaveBooked.count += 1;
      if (j.kind === 'agreed') { out.wouldHaveBooked.agreed += 1; s.agreed += 1; }
      else if (j.kind === 'false_positive') {
        out.wouldHaveBooked.falsePositives += 1; s.falsePositives += 1;
        for (const r of j.reasons.length ? j.reasons : ['unspecified']) bump(out.wouldHaveBooked.falsePositiveReasons, r);
        out.disagreements.push({ invoiceId: j.invoiceId, supplierName: j.supplierName, supplierInvoiceNumber: j.supplierInvoiceNumber, kind: 'false_positive', reasons: j.reasons, verdictJob: j.verdictJob, finalJob: j.finalJob });
      } else if (j.kind === 'auto_booked_stands') { out.wouldHaveBooked.autoBookedStands += 1; s.autoBooked += 1; }
      else if (j.kind === 'auto_booked_then_reversed') {
        out.wouldHaveBooked.autoBookedThenReversed += 1; s.autoBooked += 1; s.autoBookedThenReversed += 1;
        for (const r of j.reasons) bump(out.wouldHaveBooked.falsePositiveReasons, r);
        out.disagreements.push({ invoiceId: j.invoiceId, supplierName: j.supplierName, supplierInvoiceNumber: j.supplierInvoiceNumber, kind: 'auto_booked_then_reversed', reasons: j.reasons, verdictJob: j.verdictJob, finalJob: j.finalJob });
      }
    } else {
      out.wouldHaveWaited.count += 1;
      if (j.kind === 'false_negative') {
        out.wouldHaveWaited.falseNegatives += 1; s.falseNegatives += 1;
        for (const r of j.reasons.length ? j.reasons : ['unspecified']) bump(out.wouldHaveWaited.falseNegativeReasons, r);
        out.disagreements.push({ invoiceId: j.invoiceId, supplierName: j.supplierName, supplierInvoiceNumber: j.supplierInvoiceNumber, kind: 'false_negative', reasons: j.reasons, verdictJob: j.verdictJob, finalJob: j.finalJob });
      } else {
        out.wouldHaveWaited.correct += 1;
      }
    }
  }

  out.bySupplier = [...suppliers.values()].sort((a, b) => b.sample - a.sample || String(a.supplierName).localeCompare(String(b.supplierName)));
  return out;
}

/**
 * The release gate the owner must clear before turning automatic booking on —
 * evaluated against a report so the answer is a checklist, not an opinion.
 * Thresholds are deliberately conservative and named; change them here, with
 * the doc (docs/invoice-capture.md "Automatic booking — shadow report").
 */
const RELEASE_GATE = Object.freeze({
  minSample: 30,
  minSamplePerSupplier: 5,
  minResolvedShare: 0.8,
  maxWrongJob: 0,
  maxWrongTotal: 0,
});

function releaseGate(report) {
  const resolved = report.sampleSize - report.unresolved;
  const checks = [
    { code: 'sample_size', ok: report.sampleSize >= RELEASE_GATE.minSample, detail: `${report.sampleSize} evaluated (need ${RELEASE_GATE.minSample})` },
    { code: 'resolved_share', ok: report.sampleSize > 0 && resolved / report.sampleSize >= RELEASE_GATE.minResolvedShare, detail: `${resolved} of ${report.sampleSize} have a human outcome` },
    { code: 'zero_wrong_job', ok: report.agreement.job.differ <= RELEASE_GATE.maxWrongJob, detail: `${report.agreement.job.differ} would-have-booked with a different final job` },
    { code: 'zero_wrong_total', ok: report.agreement.figures.differ <= RELEASE_GATE.maxWrongTotal, detail: `${report.agreement.figures.differ} with different figures` },
    { code: 'zero_false_positives', ok: report.wouldHaveBooked.falsePositives === 0 && report.wouldHaveBooked.autoBookedThenReversed === 0, detail: `${report.wouldHaveBooked.falsePositives} false positives, ${report.wouldHaveBooked.autoBookedThenReversed} automatic bookings reversed` },
    { code: 'no_legacy_only', ok: report.legacyVerdicts < report.sampleSize, detail: `${report.legacyVerdicts} verdicts without a snapshot` },
  ];
  const suppliersReady = report.bySupplier.filter((s) => s.sample - s.unresolved >= RELEASE_GATE.minSamplePerSupplier && s.falsePositives === 0 && s.autoBookedThenReversed === 0).map((s) => s.supplierKey);
  return { pass: checks.every((c) => c.ok), checks, suppliersReady, thresholds: RELEASE_GATE };
}

module.exports = { judgeInvoice, buildShadowReport, releaseGate, RELEASE_GATE, VERDICT_EVENTS };
