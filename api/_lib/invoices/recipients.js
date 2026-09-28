'use strict';

// Who the supplier-invoice emails go to — the Monday digest, the mid-week
// alert and the stray-email forward (owner pull 2026-09-28: Tia gets the
// timesheets, not the invoices).
//
// The owner-set `invoice_capture.emailRecipients` setting (comma-separated)
// wins when it holds at least one valid address; blank → the timesheet
// accounts list, exactly as before this setting existed. Malformed entries
// are skipped rather than voiding the list, so a typo never silently sends
// invoices back to the timesheet inbox.

const { getSetting } = require('../feature-settings');
const { normalizeRecipients, readTimesheetRecipients } = require('../timesheet-email-settings');

/** Parse the setting text into valid, deduped, lowercased addresses. PURE. */
function parseInvoiceRecipients(text) {
  const parts = String(text == null ? '' : text).split(/[\s,;]+/).filter(Boolean);
  const valid = [];
  for (const p of parts) {
    const n = normalizeRecipients([p]);
    if (n.ok && n.recipients.length && !valid.includes(n.recipients[0])) valid.push(n.recipients[0]);
  }
  return valid;
}

async function readInvoiceRecipients() {
  let own = [];
  try { own = parseInvoiceRecipients(await getSetting('invoice_capture', 'emailRecipients')); } catch { /* fall back */ }
  return own.length ? own : readTimesheetRecipients();
}

module.exports = { parseInvoiceRecipients, readInvoiceRecipients };
