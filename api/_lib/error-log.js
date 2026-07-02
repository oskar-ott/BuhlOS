// Platform error-event store (#154).
//
// Single append-only blob at  platform/errors.json
//   { entries: [{ id, ts, source, handler, message, severity, statusCode,
//                  stack?, userId?, jobId?, fingerprint, metadata? }] }
//
// Mirrors the api/_lib/audit-log.js discipline: append-only (no update /
// delete API), hard entry caps, FIFO trim at 5000 → 4000 as defence-in-depth
// against runaway writes. One blob (not monthly) — error volume is expected
// to sit far below the audit journal's; the trim is the rollover.
//
// appendError NEVER throws: error reporting must never take down the request
// that tripped it (the same best-effort contract as the audit journal, but
// enforced here rather than at every call site — callers can't all be
// trusted to .catch() on an already-failing code path).

const { readBlob, writeBlob } = require('./blob');
const { nanoid } = require('./validation');
const crypto = require('node:crypto');

const ERRORS_KEY = 'platform/errors.json';
const MAX_ENTRIES = 5000;
const TRIM_TO = 4000;
const MESSAGE_CAP = 500;
const STACK_CAP = 800;
const METADATA_CAP = 1024;

const VALID_SOURCES = new Set(['api', 'client']);
const VALID_SEVERITIES = new Set(['fatal', 'error', 'warning']);

// Stable grouping key: same handler + message + statusCode → same group.
// 12 hex chars of sha256 — collision-tolerant (grouping only, not identity).
function fingerprintOf(handler, message, statusCode) {
  return crypto
    .createHash('sha256')
    .update(`${handler}|${message}|${statusCode}`)
    .digest('hex')
    .slice(0, 12);
}

function _shrinkMetadata(meta) {
  // Cap metadata JSON at ~1 KB and truncate HONESTLY (the _truncated flag
  // says so) — same shrink pattern as audit-log.js, tighter cap.
  try {
    const s = JSON.stringify(meta);
    if (s.length <= METADATA_CAP) return meta;
    return { _truncated: true, preview: s.slice(0, METADATA_CAP) };
  } catch {
    return { _truncated: true };
  }
}

async function readErrors() {
  const data = await readBlob(ERRORS_KEY, { entries: [] });
  return Array.isArray(data && data.entries) ? data.entries : [];
}

/**
 * Append one error event. Never throws — a reporting failure is swallowed
 * (console.error only) and null is returned; the caller's request proceeds.
 *
 * @param {{ source?: 'api'|'client', handler?: string, message?: string,
 *           severity?: 'fatal'|'error'|'warning', statusCode?: number|null,
 *           stack?: string|null, userId?: string|null, jobId?: string|null,
 *           metadata?: object }} payload
 * @returns {Promise<object|null>} the stored entry, or null on any failure
 */
async function appendError(payload) {
  try {
    if (!payload || typeof payload !== 'object') return null;
    const source = VALID_SOURCES.has(payload.source) ? payload.source : 'api';
    const handler = String(payload.handler || 'unknown').slice(0, 120);
    const message = String(payload.message || 'unknown error').slice(0, MESSAGE_CAP);
    const severity = VALID_SEVERITIES.has(payload.severity) ? payload.severity : 'error';
    const statusCode = Number.isFinite(payload.statusCode) ? payload.statusCode : null;

    const entry = {
      id: nanoid('err_'),
      ts: new Date().toISOString(),
      source,
      handler,
      message,
      severity,
      statusCode,
      stack: payload.stack ? String(payload.stack).slice(0, STACK_CAP) : null,
      userId: payload.userId ? String(payload.userId) : null,
      jobId: payload.jobId ? String(payload.jobId) : null,
      fingerprint: fingerprintOf(handler, message, statusCode),
      ...(payload.metadata && typeof payload.metadata === 'object'
        ? { metadata: _shrinkMetadata(payload.metadata) }
        : {}),
    };

    const entries = await readErrors();
    entries.push(entry);
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(-TRIM_TO) : entries;
    await writeBlob(ERRORS_KEY, { entries: trimmed });
    return entry;
  } catch (e) {
    // Reporting must never throw into the failing request.
    console.error('appendError failed (swallowed)', e && e.message);
    return null;
  }
}

module.exports = {
  appendError,
  readErrors,
  fingerprintOf,
  ERRORS_KEY,
  MAX_ENTRIES,
  TRIM_TO,
  MESSAGE_CAP,
  STACK_CAP,
  METADATA_CAP,
};
