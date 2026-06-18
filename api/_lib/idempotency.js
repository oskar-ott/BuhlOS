'use strict';

// Shared replay-safety helper for Phil field writes (#497).
//
// A client may send an idempotency key (HTTP header `Idempotency-Key`, or a
// body field `idempotencyKey`). The server records processed keys ON THE SAME
// grow-collection document the write already reads + writes, so a RETRY carrying
// the same key returns the original result instead of creating a second record.
// No new store, no extra round-trip.
//
// This is the foundation the offline capture queue (#143) builds on: a write
// queued on a dead connection and replayed on reconnect (or retried after a
// timeout where the response was lost) must not double-create. Without a key the
// behaviour is unchanged — every write applies, exactly as today.
//
// Keys live in a BOUNDED ring on the document: `doc.__idempotency` =
// [{ key, result, at }, …], oldest-first, capped at DEFAULT_MAX_KEYS so the
// document can never grow without limit. `result` is the exact response payload
// the first call returned, so a replay is byte-identical to the original.

const DEFAULT_MAX_KEYS = 50;

/** Read a client-supplied idempotency key from the request (header preferred,
 *  then body). Returns null when none is supplied (→ no dedupe, today's
 *  behaviour). Node lower-cases header names. */
function idempotencyKeyFrom(req) {
  const headers = (req && req.headers) || {};
  const headerKey = headers['idempotency-key'] || headers['Idempotency-Key'];
  const bodyKey = req && req.body && req.body.idempotencyKey;
  const key = (headerKey || bodyKey || '').toString().trim();
  return key || null;
}

/** The result recorded for a previously-seen key on this document, or null. */
function findIdempotent(doc, key) {
  if (!key || !doc || !Array.isArray(doc.__idempotency)) return null;
  const hit = doc.__idempotency.find((e) => e && e.key === key);
  return hit ? hit.result : null;
}

/** Record a result under a key (idempotent: a re-record of an existing key keeps
 *  the original result). Bounded ring — trims the oldest beyond `max`. Mutates
 *  and returns `doc` so the caller persists the key in the same write. */
function recordIdempotent(doc, key, result, max = DEFAULT_MAX_KEYS) {
  if (!key || !doc) return doc;
  if (!Array.isArray(doc.__idempotency)) doc.__idempotency = [];
  if (!doc.__idempotency.some((e) => e && e.key === key)) {
    doc.__idempotency.push({ key, result, at: new Date().toISOString() });
  }
  if (doc.__idempotency.length > max) {
    doc.__idempotency = doc.__idempotency.slice(doc.__idempotency.length - max);
  }
  return doc;
}

module.exports = { idempotencyKeyFrom, findIdempotent, recordIdempotent, DEFAULT_MAX_KEYS };
