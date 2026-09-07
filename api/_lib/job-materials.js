'use strict';

// Per-job materials SPEND ledger (owner pull 2026-08-23: "see all the
// materials being used on a job and the value of all of that").
//
// What it is: the office's record of what was BOUGHT for a job — one line per
// docket/invoice (date, supplier, what for, amount ex GST). It is the one real
// source the job hub's Materials figure has: the legacy materials-list tool
// that wrote jobs/<id>/materials-list.json was deleted in the 2026-07-27 gut,
// so that file exists for no job and the Money card read "—" forever.
//
// What it is NOT (deliberately): not the task-led "materials facet"
// (docs/architecture/task-led-job-architecture.md — what a task NEEDS, keyed
// by canonical task identity), not procurement (no orders, no receiving, no
// invoice match), not field capture (Phil's cognitive budget, P10 — a field
// path is a separate governance decision). Job-level commercial money, like
// contractValue; it carries no area/task linkage by design.
//
// Storage: blob `jobs/<jobId>/materials-ledger.json`
//   { lines: [ { id, date: 'YYYY-MM-DD', supplier, description|null, amountCents,
//                createdBy, createdByName, createdAt,
//                deletedAt?, deletedBy?, deletedByName? } ] }
//
// MONEY IS INTEGER CENTS (P7 — no invented precision; same discipline as the
// cost-rate store #304). $123.45 is 12345. Display layers divide by 100.
//
// Removal is a SOFT delete (tombstone on the line) so a removed docket is
// still attributable; totals and listings exclude tombstoned lines. No
// transactional storage: a blob read-modify-write like every other store.

const { readBlob, writeBlob } = require('./blob');
const { nanoid } = require('./validation');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AMOUNT_CENTS = 100_000_000_00; // $100,000,000 — an obvious typo guard, not a policy
const MAX_LINES = 2000;

/** True only for a real calendar date — JS Date silently rolls 2026-02-31 to
 *  3 March, so the round-trip must reproduce the input exactly. */
function isRealDate(date) {
  const d = new Date(date + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function keyFor(jobId) {
  return `jobs/${jobId}/materials-ledger.json`;
}

async function readLedger(jobId) {
  const data = await readBlob(keyFor(jobId), { lines: [] });
  return data && typeof data === 'object' && Array.isArray(data.lines) ? data : { lines: [] };
}

async function writeLedger(jobId, data) {
  await writeBlob(`jobs/${jobId}/materials-ledger.json`, { lines: (data && data.lines) || [] });
}

/** Non-deleted lines, newest date first (ties: newest created first). Pure. */
function activeLines(data) {
  const lines = (data && Array.isArray(data.lines) ? data.lines : []).filter(
    (l) => l && !l.deletedAt,
  );
  return lines.slice().sort((a, b) => {
    const d = String(b.date || '').localeCompare(String(a.date || ''));
    return d !== 0 ? d : String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

/** Sum of active line amounts, integer cents. Pure. */
function ledgerTotalCents(data) {
  let sum = 0;
  for (const l of activeLines(data)) {
    const c = Number(l.amountCents);
    if (Number.isInteger(c) && c > 0) sum += c;
  }
  return sum;
}

/** { lines, totalCents, count } — the read shape the API and the money read share. Pure. */
function summariseLedger(data) {
  const lines = activeLines(data);
  return { lines, totalCents: ledgerTotalCents({ lines }), count: lines.length };
}

/**
 * Validate an incoming line. Returns { ok, value } or { ok:false, error }.
 * date YYYY-MM-DD (a real calendar date); supplier 1–120 chars; description
 * optional ≤300 chars; amountCents a positive integer. Pure.
 */
function validateLineInput(body) {
  const b = body || {};
  const date = String(b.date || '').trim();
  if (!DATE_RE.test(date) || !isRealDate(date)) {
    return { ok: false, error: 'date must be a real YYYY-MM-DD date' };
  }
  const supplier = String(b.supplier || '').trim().slice(0, 120);
  if (!supplier) return { ok: false, error: 'supplier required' };
  const descriptionRaw = b.description == null ? '' : String(b.description).trim();
  if (descriptionRaw.length > 300) return { ok: false, error: 'description too long (300 max)' };
  const amountCents = Number(b.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'amountCents must be a positive integer (cents)' };
  }
  if (amountCents > MAX_AMOUNT_CENTS) return { ok: false, error: 'amountCents implausibly large' };
  return {
    ok: true,
    value: { date, supplier, description: descriptionRaw || null, amountCents },
  };
}

/** Append a validated line; returns { data, line } (data is a copy). Pure. */
function appendLine(data, value, actor) {
  const lines = (data && Array.isArray(data.lines) ? data.lines : []).slice();
  if (lines.length >= MAX_LINES) {
    return { error: `ledger full (${MAX_LINES} lines) — archive this job's spend before adding more` };
  }
  const line = {
    id: nanoid('ml_'),
    date: value.date,
    supplier: value.supplier,
    description: value.description == null ? null : value.description,
    amountCents: value.amountCents,
    createdBy: (actor && actor.id) || '',
    createdByName: (actor && (actor.name || actor.username)) || '',
    createdAt: new Date().toISOString(),
  };
  lines.push(line);
  return { data: { lines }, line };
}

/** Soft-delete one line; returns { data, line } or null when absent/already removed. Pure. */
function removeLine(data, lineId, actor) {
  const lines = (data && Array.isArray(data.lines) ? data.lines : []).slice();
  const idx = lines.findIndex((l) => l && l.id === lineId && !l.deletedAt);
  if (idx < 0) return null;
  const line = {
    ...lines[idx],
    deletedAt: new Date().toISOString(),
    deletedBy: (actor && actor.id) || '',
    deletedByName: (actor && (actor.name || actor.username)) || '',
  };
  lines[idx] = line;
  return { data: { lines }, line };
}

module.exports = {
  keyFor,
  readLedger,
  writeLedger,
  activeLines,
  ledgerTotalCents,
  summariseLedger,
  validateLineInput,
  appendLine,
  removeLine,
  MAX_LINES,
};
