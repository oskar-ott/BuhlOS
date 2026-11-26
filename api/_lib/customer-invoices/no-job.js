// Customer invoices that are NOT tied to a job (#1166, customer_invoices,
// dark). docs/customer-invoices.md → "An invoice with no job".
//
// Some money comes in monthly against a builder's payment schedule (Payapps
// and the like), not job by job. The office raises ONE invoice for it. That
// invoice is an ordinary itemised invoice, except that:
//
//   * it lives in a reserved ledger, `NO_JOB_ID`, instead of on a job. The id
//     starts with `~`, which a job id can never contain (job ids are slugs:
//     lower-case letters, digits and hyphens), so it cannot collide with one;
//   * its client is chosen ON THE INVOICE (a job's invoices use the job's
//     linked client);
//   * its number comes from its own series, `GEN-0001`, `GEN-0002` … — never
//     a job number, and a prefix Xero's own numbering does not use.
//
// Everything else — the send, the read-back, the look-up before a retry, the
// paid status — is the same code a job's invoice runs through.
'use strict';

/** The reserved ledger id. Stored in `customer_invoices.job_legacy_id`. */
const NO_JOB_ID = '~no-job';

/** What the no-job series is numbered with. */
const NUMBER_PREFIX = 'GEN-';
const NUMBER_DIGITS = 4;

function isNoJob(jobId) {
  return jobId === NO_JOB_ID;
}

/**
 * The stand-in every job-shaped function is handed for the ledger. It has no
 * name, no number, no address and no contract value: nothing is invented.
 */
function ledger() {
  return { id: NO_JOB_ID, noJob: true, name: null, code: null, clientName: null, siteAddress: null, contractValue: null };
}

/** `GEN-0001` for the 1st invoice sent from the ledger, and so on. */
function numberFor(seq) {
  if (!Number.isInteger(seq) || seq < 1) throw new Error('numberFor: seq must be a positive integer');
  return `${NUMBER_PREFIX}${String(seq).padStart(NUMBER_DIGITS, '0')}`;
}

/** The client chosen on a no-job invoice, in the shape a job's profile has. */
function profileOf(invoice) {
  return {
    xeroContactId: (invoice && invoice.clientContactId) || null,
    xeroContactName: (invoice && invoice.clientContactName) || null,
    externalTenantId: (invoice && invoice.clientExternalTenantId) || null,
    retentionBp: 0,
    paymentClaim: false,
  };
}

module.exports = { NO_JOB_ID, NUMBER_PREFIX, isNoJob, ledger, numberFor, profileOf };
