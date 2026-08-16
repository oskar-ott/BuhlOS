'use strict';

// Timesheets → accounts recipient list (owner pull 2026-08-16) — the runtime
// store behind "Send to Tia".
//
// The list IS the switch for the interim email-export process (while the Xero
// push is out of action): at least one recipient → the send surfaces render
// (/hours/period card + the phone closeout finale) and api/time-entries-email
// sends; empty → the surfaces disappear and the Xero finale gets its slot
// back. Managed on /settings (admin tier) over GET/PUT api/time-entries-email
// — no env var, no redeploy.
//
// Reads ride readBlob's cache-busted fetch + 5s in-process TTL, so a
// just-saved list is live on every lambda within seconds.

const { readBlob, writeBlob } = require('./blob');

const KEY = 'timesheet-email-settings.json';
const MAX_RECIPIENTS = 10;

// Deliberately simple shape check — the real validation is a person reading
// the list on /settings. Full RFC-5322 is a trap; this catches the typos that
// actually happen (missing @, spaces, no domain dot).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trim, lowercase, dedupe and shape-check a proposed recipient list. PURE.
 * Empty strings drop silently (a blank add-box submit is not an error); a
 * malformed address is a NAMED refusal, never a silent drop — payroll data
 * must not quietly miss an inbox someone thinks they added.
 * @param {unknown} input
 * @returns {{ ok: true, recipients: string[] } | { ok: false, error: string }}
 */
function normalizeRecipients(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'recipients must be an array of email addresses' };
  }
  const seen = new Set();
  const recipients = [];
  for (const raw of input) {
    const email = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL_RE.test(email)) {
      return { ok: false, error: `"${email}" doesn't look like an email address` };
    }
    if (seen.has(email)) continue;
    seen.add(email);
    recipients.push(email);
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return { ok: false, error: `Keep it to ${MAX_RECIPIENTS} recipients or fewer.` };
  }
  return { ok: true, recipients };
}

/**
 * The stored document, re-validated on read (defence in depth — a hand-edited
 * or corrupt store resolves to an empty, switch-off list, never a crash).
 * @returns {Promise<{ recipients: string[], updatedAt: string|null, updatedBy: string|null }>}
 */
async function readTimesheetEmailSettings() {
  const doc = await readBlob(KEY, { recipients: [] });
  const n = normalizeRecipients(doc && doc.recipients);
  return {
    recipients: n.ok ? n.recipients : [],
    updatedAt: (doc && typeof doc.updatedAt === 'string' && doc.updatedAt) || null,
    updatedBy: (doc && typeof doc.updatedBy === 'string' && doc.updatedBy) || null,
  };
}

/** Just the addresses — the switch check the pages and the send path use. */
async function readTimesheetRecipients() {
  return (await readTimesheetEmailSettings()).recipients;
}

/**
 * Replace the list (the UI's add/remove both PUT the full array — a 1–10
 * entry list doesn't need per-row CAS). Caller passes an ALREADY-normalized
 * list; provenance is stamped here.
 */
async function writeTimesheetRecipients(recipients, actor) {
  const doc = {
    recipients,
    updatedAt: new Date().toISOString(),
    updatedBy: (actor && actor.username) || null,
  };
  await writeBlob(KEY, doc);
  return doc;
}

module.exports = {
  KEY,
  MAX_RECIPIENTS,
  normalizeRecipients,
  readTimesheetEmailSettings,
  readTimesheetRecipients,
  writeTimesheetRecipients,
};
