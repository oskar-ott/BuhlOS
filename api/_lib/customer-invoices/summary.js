'use strict';

// Customer stage invoices — the "money in" summary other surfaces read
// (#1151): the job Money card (api/job-profitability.js) and the printable
// job report. One read of the job's stage invoices, rolled up by the same
// pure maths the Getting paid card uses (amounts.js jobTotals), so the two
// can never disagree.
//
// Everything about a SENT invoice here is Xero's own figure, as last mirrored
// by the status check — `asOf` says how fresh that is.

const store = require('./store');
const { contractCentsOf, jobTotals } = require('./amounts');
const { displayStatus } = require('./status');

function sydneyToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * @param {object} sql
 * @param {string} tenantId
 * @param {{ id: string, contractValue?: number|null }} job
 * @returns {Promise<{
 *   sentCount: number, plannedCount: number,
 *   draftedCents: number, invoicedCents: number,
 *   paidCents: number|null, paidIncGstCents: number, dueIncGstCents: number,
 *   stillToInvoiceCents: number|null, retentionHeldCents: number, overdueCount: number,
 *   asOf: string|null, unavailable: false,
 *   invoices: Array<object>,
 * }>}
 */
async function jobMoneyIn(sql, tenantId, job, deps = {}) {
  const s = deps.store || store;
  const [profile, rows, variations] = await Promise.all([
    s.getProfile(sql, tenantId, job.id),
    s.listJobInvoices(sql, tenantId, job.id),
    // approved variations are part of what the job is worth (#1163)
    s.listVariations ? s.listVariations(sql, tenantId, job.id) : [],
  ]);
  const t = jobTotals(rows, { contractCents: contractCentsOf(job.contractValue), retentionBp: profile ? profile.retentionBp : 0, variations });
  const today = sydneyToday();
  const sent = rows.filter((r) => r.state === 'sent' && r.xeroInvoiceId);
  const invoices = sent.map((r) => ({
    invoiceNumber: r.invoiceNumber,
    title: r.title,
    kind: r.kind,
    invoiceDate: r.invoiceDate,
    dueDate: r.xeroDueDate || r.dueDate,
    status: displayStatus(r, today),
    subtotalCents: r.xeroSubtotalCents,
    totalCents: r.xeroTotalCents,
    amountPaidCents: r.xeroAmountPaidCents,
    amountDueCents: r.xeroAmountDueCents,
    fullyPaidOn: r.xeroFullyPaidOn,
  }));
  return {
    sentCount: t.sentCount,
    plannedCount: t.plannedCount,
    draftedCents: t.draftedCents,
    invoicedCents: t.invoicedCents,
    paidCents: t.paidCents,
    paidIncGstCents: t.paidIncGstCents,
    dueIncGstCents: t.dueIncGstCents,
    stillToInvoiceCents: t.stillToInvoiceCents,
    variationsApprovedCents: t.variationsApprovedCents,
    revisedContractCents: t.revisedContractCents,
    retentionHeldCents: t.retentionHeldCents,
    overdueCount: invoices.filter((i) => i.status === 'overdue').length,
    // The OLDEST "last checked with Xero" among the sent invoices.
    asOf: sent.map((r) => r.lastCheckedAt).reduce((oldest, x) => (x && (!oldest || x < oldest) ? x : oldest), null),
    unavailable: false,
    invoices,
  };
}

module.exports = { jobMoneyIn };
