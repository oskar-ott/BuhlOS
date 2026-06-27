'use strict';

// Confidential worker cost-rate store (#304).
//
// Every dollar figure the system computes today multiplies hours by the single
// `users.json` `hourlyRate` — a field that is sparse, semantically ambiguous
// (base wage? loaded cost? charge-out?), and NOT confidential (a leading hand
// can read every worker's rate via listTradies). This module is the deliberate
// replacement: a per-worker LOADED COST rate (and optional charge-out rate) with
// EFFECTIVE-DATED history, stored OUTSIDE users.json and readable only by
// admin-tier callers + server-side analytics.
//
// Storage: blob `workforce/cost-rates.json`
//   { rates: { [userId]: [ { id, costRateCents, chargeOutRateCents|null,
//                            effectiveFrom: 'YYYY-MM-DD', setBy, setByName, setAt } ] } }
//
// MONEY IS INTEGER CENTS (P7 — no invented precision; same discipline as the
// expenses domain). A $52.50/h loaded cost is 5250. Display layers divide by 100.
//
// Append-only history: an edit never overwrites; it appends a new effective-dated
// entry so a past week is always costed at the rate that was effective THEN
// (`effectiveCostRate(history, date)`), and the editor + timestamp are preserved.
//
// This module changes NO existing consumer. `api/costs.js`, `cash-watch.js`,
// `crew-utilization.js`, `crew-export.js` and the quoting labour calc still read
// `users.json` `hourlyRate`; their migration order onto this store is documented
// in docs/cost-rates.md (#304 — no silent dual-source drift).

const { readBlob, writeBlob } = require('./blob');
const { nanoid } = require('./validation');
const { isHoursTrackedWorker } = require('./auth');

const KEY = 'workforce/cost-rates.json';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function readCostRates() {
  const data = await readBlob(KEY, { rates: {} });
  return data && typeof data === 'object' && data.rates && typeof data.rates === 'object'
    ? data
    : { rates: {} };
}

async function writeCostRates(data) {
  await writeBlob(KEY, { rates: (data && data.rates) || {} });
}

/** History for one worker, sorted oldest → newest by effectiveFrom (stable). Pure. */
function historyFor(data, userId) {
  const raw = (data && data.rates && data.rates[userId]) || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .slice()
    .sort((a, b) => String(a.effectiveFrom || '').localeCompare(String(b.effectiveFrom || '')));
}

/**
 * The rate entry effective on `date` (YYYY-MM-DD): the latest entry whose
 * effectiveFrom ≤ date. Returns null when the worker had no rate yet on that
 * date. Pure — the heart of "a past week is costed at the rate effective THEN".
 */
function effectiveCostRate(history, date) {
  const d = String(date || '');
  let best = null;
  for (const entry of history || []) {
    const ef = String(entry && entry.effectiveFrom || '');
    if (ef && ef <= d && (!best || ef >= String(best.effectiveFrom))) best = entry;
  }
  return best;
}

/**
 * Validate an incoming rate edit. Returns { ok, value } or { ok:false, error }.
 * costRateCents required positive integer; chargeOutRateCents optional positive
 * integer; effectiveFrom a YYYY-MM-DD date. Pure.
 */
function validateRateInput(body) {
  const b = body || {};
  const costRateCents = Number(b.costRateCents);
  if (!Number.isInteger(costRateCents) || costRateCents <= 0) {
    return { ok: false, error: 'costRateCents must be a positive integer (cents)' };
  }
  if (costRateCents > 100_000_00) {
    return { ok: false, error: 'costRateCents implausibly large' };
  }
  let chargeOutRateCents = null;
  if (b.chargeOutRateCents != null && b.chargeOutRateCents !== '') {
    chargeOutRateCents = Number(b.chargeOutRateCents);
    if (!Number.isInteger(chargeOutRateCents) || chargeOutRateCents <= 0) {
      return { ok: false, error: 'chargeOutRateCents must be a positive integer (cents)' };
    }
  }
  const effectiveFrom = String(b.effectiveFrom || '');
  if (!DATE_RE.test(effectiveFrom)) {
    return { ok: false, error: 'effectiveFrom must be a YYYY-MM-DD date' };
  }
  return { ok: true, value: { costRateCents, chargeOutRateCents, effectiveFrom } };
}

/**
 * Append a new effective-dated rate for a worker (never overwrites). Mutates a
 * copy of `data` and returns it; the caller persists with writeCostRates.
 */
function appendRate(data, userId, value, actor) {
  const next = { rates: { ...((data && data.rates) || {}) } };
  const list = Array.isArray(next.rates[userId]) ? next.rates[userId].slice() : [];
  list.push({
    id: nanoid('cr_'),
    costRateCents: value.costRateCents,
    chargeOutRateCents: value.chargeOutRateCents == null ? null : value.chargeOutRateCents,
    effectiveFrom: value.effectiveFrom,
    setBy: (actor && actor.id) || '',
    setByName: (actor && actor.username) || '',
    setAt: new Date().toISOString(),
  });
  next.rates[userId] = list;
  return next;
}

/**
 * Coverage report: which hours-tracked workers (per isHoursTrackedWorker) have
 * NO cost rate recorded. Supersedes/feeds the data-quality `staff-no-rate`
 * category, which keys off the legacy sparse hourlyRate. Pure given inputs.
 *
 * @returns {{ tracked: number, rated: number, unrated: Array<{id,username,role}> }}
 */
function costRateCoverage(users, data) {
  const tracked = (users || []).filter((u) => isHoursTrackedWorker(u));
  const unrated = [];
  for (const u of tracked) {
    if (historyFor(data, u.id).length === 0) {
      unrated.push({ id: u.id, username: u.username || u.id, role: u.role });
    }
  }
  return { tracked: tracked.length, rated: tracked.length - unrated.length, unrated };
}

module.exports = {
  KEY,
  readCostRates,
  writeCostRates,
  historyFor,
  effectiveCostRate,
  validateRateInput,
  appendRate,
  costRateCoverage,
};
