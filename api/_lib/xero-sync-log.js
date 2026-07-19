// Xero sync-outcome recorder (#251, M5 #890) — the ONE chokepoint every Xero
// sync child writes its exchange outcomes through, so the sync-health
// dashboard inherits every current and future sync with no per-feature wiring.
//
// Two stores (issue #251 audit ruling — open items must be untrimmable):
//   xero/sync-open.json            { items: [...], lastSuccessAt: {type: iso} }
//     - the working set of UNRESOLVED failures/skips, upserted by operation id
//       (idempotent: a re-recorded failure bumps seenCount, never duplicates)
//     - NEVER FIFO-trimmed. If open failures outgrow a small blob, the
//       dashboard has bigger news than blob size.
//   xero/sync-log/<yyyy-mm>.json   { entries: [...] }
//     - append-only history of TERMINAL outcomes only (ok / resolved /
//       resolved_meanwhile / acknowledged), capped + trimmed like
//       api/_lib/audit-log.js. Open items are not here, so trimming can never
//       lose an unresolved finance failure.
//
// Contract with callers (#355 blocking classification): recording a FAILURE
// outcome is part of the sync's own success — record() THROWS on store
// failure and on invalid input (unknown syncType, bad status), and the
// CALLING sync surfaces that in its own response. An unrecorded outcome is
// this system's one blind spot; we refuse to create one silently.
//
// Retry goes through the REGISTRY only: operation handlers self-register
// ({ syncType → retry(item) }) at module load, so a retry always traverses
// the original code path and its idempotency guards — the dashboard can never
// re-implement a push. A handler resolving an item that was fixed elsewhere
// reports 'resolved_meanwhile'.
//
// Everything stored passes the credential scrubber — enforced HERE, not per
// caller (tokens/secrets must never live in a support-readable log).
//
// MIRROR LAW: the closed lists (SYNC_TYPES, statuses) are hand-mirrored in
// src/domains/xero/sync-log.ts — change together; the domain test pins 1:1.

const { readBlob, writeBlob } = require('./blob');

const OPEN_KEY = 'xero/sync-open.json';
const HISTORY_PREFIX = 'xero/sync-log/';
const MAX_ENTRIES_PER_MONTH = 5000;
const TRIM_TO_PER_MONTH = 4000;

const SYNC_TYPES = new Set(['reference_sync', 'timesheet_export', 'reconciliation']);
const OPEN_STATUSES = new Set(['failed', 'skipped']);
const TERMINAL_OUTCOMES = new Set(['ok', 'resolved', 'resolved_meanwhile', 'acknowledged']);

function nanoid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function monthKey(ts) {
  return HISTORY_PREFIX + String(ts).slice(0, 7) + '.json';
}

// ── Credential scrubber ─────────────────────────────────────────────────
// Anything token/secret-shaped is replaced before storage. Deliberately
// aggressive: a scrubbed support log beats a leaked refresh token.
const SCRUB_PATTERNS = [
  /bearer\s+[a-z0-9\-._~+/]+=*/gi,
  /(refresh|access)_token"?\s*[:=]\s*"?[a-z0-9\-._~+/]+=*"?/gi,
  /client_(secret|id)"?\s*[:=]\s*"?[a-z0-9\-._~+/]+=*"?/gi,
  /authorization"?\s*[:=]\s*"?[^",}\s]+"?/gi,
  // Long unbroken base64/hex runs (JWT segments, raw keys).
  /\b[a-z0-9+/_\-]{80,}\b/gi,
];

function scrubString(s) {
  let out = String(s);
  for (const re of SCRUB_PATTERNS) out = out.replace(re, '[scrubbed]');
  return out;
}

/** Deep-scrub strings inside any JSON-ish value. Non-serialisable → null. */
function scrub(value) {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.parse(scrubString(JSON.stringify(value)));
  } catch {
    return null;
  }
}

// ── Retry registry ──────────────────────────────────────────────────────
// syncType → async handler(openItem) → { outcome: 'resolved'|'resolved_meanwhile'|'failed', reason? }
const retryHandlers = new Map();

/** Called at module load by each sync child. One handler per type. */
function registerRetryHandler(syncType, handler) {
  if (!SYNC_TYPES.has(syncType)) {
    throw new Error(`xero-sync-log: unknown syncType "${syncType}" — extend the closed list (both mirrors) first`);
  }
  if (typeof handler !== 'function') throw new Error('xero-sync-log: retry handler must be a function');
  retryHandlers.set(syncType, handler);
}

function _resetForTests() {
  retryHandlers.clear();
}

// ── Store primitives ────────────────────────────────────────────────────

async function readOpen() {
  const doc = await readBlob(OPEN_KEY, { items: [], lastSuccessAt: {} });
  return {
    items: Array.isArray(doc.items) ? doc.items : [],
    lastSuccessAt: doc.lastSuccessAt && typeof doc.lastSuccessAt === 'object' ? doc.lastSuccessAt : {},
  };
}

async function appendHistory(entry) {
  const key = monthKey(entry.ts);
  const doc = await readBlob(key, { entries: [] });
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  entries.push(entry);
  // Cap/trim mirrors audit-log.js — safe here because ONLY terminal outcomes
  // live in history; open failures are in the untrimmed working set.
  const trimmed = entries.length > MAX_ENTRIES_PER_MONTH ? entries.slice(-TRIM_TO_PER_MONTH) : entries;
  await writeBlob(key, { entries: trimmed });
}

function historyEntry(base, outcome, extra) {
  return {
    id: nanoid('xs_'),
    ts: new Date().toISOString(),
    syncType: base.syncType,
    operation: base.operation,
    recordRef: base.recordRef,
    outcome,
    reason: scrubString(base.reason || ''),
    ...(base.category ? { category: base.category } : {}),
    ...(extra || {}),
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Record one exchange outcome. THROWS on invalid input or store failure —
 * the calling sync must surface an unrecordable outcome in its own response.
 *
 * @param {{
 *   syncType: string, operation: string, recordRef: string,
 *   status: 'ok'|'failed'|'skipped',
 *   reason?: string, category?: string, xeroError?: unknown,
 * }} outcome
 */
async function record(outcome) {
  const o = outcome || {};
  if (!SYNC_TYPES.has(o.syncType)) {
    throw new Error(`xero-sync-log: unknown syncType "${o.syncType}" — a typo must not create an invisible category`);
  }
  const operation = String(o.operation || '');
  const recordRef = String(o.recordRef || '');
  if (!operation || !recordRef) throw new Error('xero-sync-log: operation and recordRef are required');

  const now = new Date().toISOString();

  if (o.status === 'ok') {
    const open = await readOpen();
    open.lastSuccessAt[o.syncType] = now;
    // A success for an operation with an OPEN failure closes it (proving-run
    // find #7: the batch's earlier rejection stayed open forever after the
    // retry landed — a phantom failure on the health panel).
    const idx = open.items.findIndex((i) => i.operation === operation);
    let resolvedPrior = false;
    if (idx !== -1) {
      const [item] = open.items.splice(idx, 1);
      await appendHistory(historyEntry({ ...item, reason: 'landed on a later attempt' }, 'resolved'));
      resolvedPrior = true;
    }
    await writeBlob(OPEN_KEY, open);
    await appendHistory(historyEntry({ ...o, reason: o.reason || '' }, 'ok'));
    return { recorded: 'ok', resolvedPrior };
  }

  if (!OPEN_STATUSES.has(o.status)) {
    throw new Error(`xero-sync-log: unknown status "${o.status}"`);
  }

  const open = await readOpen();
  const existing = open.items.find((i) => i.operation === operation);
  if (existing) {
    existing.status = o.status;
    existing.recordRef = recordRef;
    existing.reason = scrubString(o.reason || '');
    if (o.category) existing.category = o.category;
    if (o.xeroError !== undefined) existing.xeroError = scrub(o.xeroError);
    existing.lastSeenAt = now;
    existing.seenCount = (existing.seenCount || 1) + 1;
  } else {
    open.items.push({
      operation,
      syncType: o.syncType,
      status: o.status,
      recordRef,
      reason: scrubString(o.reason || ''),
      ...(o.category ? { category: o.category } : {}),
      ...(o.xeroError !== undefined ? { xeroError: scrub(o.xeroError) } : {}),
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    });
  }
  await writeBlob(OPEN_KEY, open);
  return { recorded: o.status, open: open.items.length };
}

/** Close an open item as resolved (or resolved_meanwhile) into history. */
async function resolve(operationId, options = {}) {
  const outcome = options.outcome || 'resolved';
  if (!TERMINAL_OUTCOMES.has(outcome) || outcome === 'ok' || outcome === 'acknowledged') {
    throw new Error(`xero-sync-log: resolve() outcome must be resolved|resolved_meanwhile, got "${outcome}"`);
  }
  const open = await readOpen();
  const idx = open.items.findIndex((i) => i.operation === operationId);
  if (idx === -1) return { resolved: false, reason: 'not open' };
  const [item] = open.items.splice(idx, 1);
  await writeBlob(OPEN_KEY, open);
  await appendHistory(historyEntry({ ...item, reason: options.reason || item.reason }, outcome));
  return { resolved: true, outcome };
}

/** Human close-out. The note is REQUIRED — an unexplained dismissal of a
 *  finance failure is exactly the silence this system exists to prevent. */
async function acknowledge(operationId, { by, note } = {}) {
  const cleanNote = String(note || '').trim();
  if (!cleanNote) throw new Error('xero-sync-log: acknowledge requires a note');
  const open = await readOpen();
  const idx = open.items.findIndex((i) => i.operation === operationId);
  if (idx === -1) return { acknowledged: false, reason: 'not open' };
  const [item] = open.items.splice(idx, 1);
  await writeBlob(OPEN_KEY, open);
  await appendHistory(
    historyEntry(item, 'acknowledged', {
      acknowledgedBy: String(by || ''),
      acknowledgedNote: scrubString(cleanNote),
    }),
  );
  return { acknowledged: true };
}

/**
 * Retry an open item through its registered handler — the ONLY retry path,
 * so every retry traverses the original operation's idempotency guards.
 */
async function retry(operationId) {
  const open = await readOpen();
  const item = open.items.find((i) => i.operation === operationId);
  if (!item) return { retried: false, reason: 'not open' };
  const handler = retryHandlers.get(item.syncType);
  if (!handler) {
    throw new Error(`xero-sync-log: no retry handler registered for "${item.syncType}"`);
  }
  const result = (await handler(item)) || {};
  if (result.outcome === 'resolved' || result.outcome === 'resolved_meanwhile') {
    await resolve(operationId, { outcome: result.outcome, reason: result.reason });
    return { retried: true, outcome: result.outcome };
  }
  // Still failing: re-record so seenCount/lastSeen reflect the attempt.
  await record({
    syncType: item.syncType,
    operation: item.operation,
    recordRef: item.recordRef,
    status: 'failed',
    reason: result.reason || item.reason,
    category: result.category || item.category,
    xeroError: result.xeroError !== undefined ? result.xeroError : item.xeroError,
  });
  return { retried: true, outcome: 'failed', reason: result.reason || item.reason };
}

/** The dashboard/badge read: open items + counts + freshness in one blob. */
async function openState() {
  const open = await readOpen();
  const byType = {};
  for (const t of SYNC_TYPES) byType[t] = 0;
  for (const i of open.items) byType[i.syncType] = (byType[i.syncType] || 0) + 1;
  return {
    items: open.items,
    lastSuccessAt: open.lastSuccessAt,
    counts: { total: open.items.length, byType },
  };
}

module.exports = {
  SYNC_TYPES: [...SYNC_TYPES],
  OPEN_STATUSES: [...OPEN_STATUSES],
  TERMINAL_OUTCOMES: [...TERMINAL_OUTCOMES],
  OPEN_KEY,
  HISTORY_PREFIX,
  MAX_ENTRIES_PER_MONTH,
  TRIM_TO_PER_MONTH,
  record,
  resolve,
  acknowledge,
  retry,
  openState,
  registerRetryHandler,
  scrub,
  monthKey,
  _resetForTests,
};
