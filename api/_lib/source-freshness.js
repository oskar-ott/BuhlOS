// Is the content I fetched the version the store says is current?
//
// Vercel Blob serves public blobs through its CDN, and the CDN can keep
// serving the PRE-overwrite document for up to ~60s after a write, even with a
// cache-busting query (Vercel documents ~60s; production matched it to the
// second on 2026-10-05). The store's own metadata — list() / head(): the
// blob's last-PUT time `uploadedAt` and its exact byte `size` — is API-fresh
// and never cached. Every read whose answer is acted on (a payroll sheet, a
// derived cache, a read-modify-write) holds the fetched content against that
// metadata. The incidents this rule answers:
//   · 2026-08-24 — a stale day-file still said "submitted"; the approved-only
//     print-out dropped real hours with no error;
//   · 2026-09-21 — a writer-controlled stamp trailed its own PUT; the guard
//     refused the pay week permanently (hence the settled-window rule below);
//   · 2026-10-02 — a stale jobs.json was stamped into the derived caches; a
//     new job vanished from the list for a day;
//   · 2026-10-05 — the week was approved and sent inside the CDN window; the
//     send was refused twice and the week never reached accounts.
//
// Two independent signals, both from the store's own metadata:
//   1. BYTE SIZE. `size` is the stored blob's exact byte count. A fetched body
//      of a different length is a different version — at ANY age, so this
//      never relaxes. (Status changes always change the size: "submitted" →
//      "approved" plus approvedBy/approvedAt.)
//   2. STORAGE STAMP. `__updatedAt` is written by blob-guards applyGuards
//      inside writeBlob immediately before the put, so for the current
//      version it sits just before `uploadedAt`: measured max 3.1s, p99 2.6s
//      across every production day-file (2026-09-22). Inside the CDN window a
//      larger gap means we were served an older version; the bar there is
//      tight (PUT_SKEW_MS) so two same-size writes seconds apart are still
//      told apart. Past the window the CDN has refreshed by definition, the
//      historic 15s skew applies, and past STALE_SUSPECT_WINDOW_MS a trailing
//      stamp is a fact about how the document was WRITTEN — refusing it would
//      be permanent (the 2026-09-21 failure) — so it is accepted.
// Content that carries no stamp (a legacy raw-put row) is judged on size
// alone; metadata that is missing entirely can't be judged and is accepted
// (never invent staleness — P7).

// Historic tolerance between the storage stamp and the PUT once the CDN has
// settled — 5x the measured worst case. Re-measure before tightening.
const FRESHNESS_SKEW_MS = 15_000;
// Tolerance inside the CDN window, where a stale read is actually possible.
// Above the measured 3.1s worst case; a genuinely slow put that lands above it
// is refused only until the window passes, never permanently.
const PUT_SKEW_MS = 5_000;
// How long after a PUT the CDN may still serve the previous version: the
// observed ~60s plus margin. Inside it, content must PROVE it is current.
const CDN_SETTLE_MS = 70_000;
// Past this, a blob is settled: whatever we read is the current document.
const STALE_SUSPECT_WINDOW_MS = 5 * 60_000;

/** Newest HANDLER-written stamp on a document, ms epoch — null when it
 *  carries none. Fallback only: a handler stamp is taken before the write and
 *  can trail the PUT by however long the write path took (up to 78s measured). */
function handlerStampMs(doc) {
  let max = 0;
  for (const k of ['updatedAt', 'approvedAt', 'rejectedAt', 'submittedAt', 'amendedAt', 'exportedAt', 'createdAt']) {
    const t = Date.parse((doc && doc[k]) || '');
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max || null;
}

/** The stamp to hold against the PUT: the storage layer's `__updatedAt` when
 *  present (no handler can trail it), else the handler stamps, else null. */
function writeStampMs(doc) {
  const storage = Date.parse((doc && doc.__updatedAt) || '');
  if (Number.isFinite(storage)) return storage;
  return handlerStampMs(doc);
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return Date.parse(v || '');
}

/**
 * The verdict for one fetched version against the store's metadata.
 *
 * @param {{ uploadedAt?: string|Date|number, size?: number }} meta  list()/head()
 * @param {{ doc: object, bytes?: number }} content  the parsed body + its byte length
 * @returns {{ current: boolean, reason?: 'size'|'stamp', gapMs?: number|null,
 *             contentMs?: number|null, uploadedMs?: number|null, settled?: boolean }}
 */
function contentVerdict(meta, content, nowMs = Date.now()) {
  const uploadedMs = toMs(meta && meta.uploadedAt);
  const size = meta && Number.isFinite(meta.size) ? meta.size : null;
  const bytes = content && Number.isFinite(content.bytes) ? content.bytes : null;
  const doc = content && content.doc;
  const contentMs = writeStampMs(doc);
  const gapMs = Number.isFinite(uploadedMs) && contentMs != null ? uploadedMs - contentMs : null;
  const base = { gapMs, contentMs, uploadedMs: Number.isFinite(uploadedMs) ? uploadedMs : null };

  const ageMs = Number.isFinite(uploadedMs) ? nowMs - uploadedMs : null;
  // 1. Size — a different byte count is a different version. Decisive while a
  //    stale copy is physically possible; past the suspect window (5x Vercel's
  //    documented bound) a mismatch cannot be a CDN-stale read, and refusing it
  //    would block forever on an unmeasured assumption (the 2026-09-21
  //    lesson), so it is accepted and FLAGGED for the caller to log.
  if (size != null && bytes != null && size !== bytes) {
    if (ageMs != null && ageMs > STALE_SUSPECT_WINDOW_MS) {
      return { current: true, settled: true, sizeMismatch: true, ...base };
    }
    return { current: false, reason: 'size', ...base };
  }
  // 2. Stamp — only judgeable with both a PUT time and a stamp.
  if (ageMs == null || contentMs == null) return { current: true, ...base };
  const hasStorageStamp = Number.isFinite(Date.parse((doc && doc.__updatedAt) || ''));
  if (ageMs < CDN_SETTLE_MS) {
    // Inside the window. Only the storage stamp is precise enough to clear a
    // read here; a document written in the last minute always carries one
    // (every write since #157 goes through applyGuards).
    const bar = hasStorageStamp ? PUT_SKEW_MS : FRESHNESS_SKEW_MS;
    return gapMs <= bar ? { current: true, ...base } : { current: false, reason: 'stamp', ...base };
  }
  if (gapMs <= FRESHNESS_SKEW_MS) return { current: true, ...base };
  if (ageMs > STALE_SUSPECT_WINDOW_MS) return { current: true, settled: true, ...base };
  return { current: false, reason: 'stamp', ...base };
}

/** True when `doc` is plausibly the document stored at `uploadedAt` — the
 *  jobs.json derived-cache check (#1085), kept EXACTLY as it shipped: storage
 *  stamp only, 15s skew, settled past the suspect window. Those callers hold
 *  the parsed document (no bytes) and refuse-to-stamp rather than refuse a
 *  read, so they keep their own, looser bar; the hours and payroll paths use
 *  contentVerdict. A doc without the storage stamp, or an unparseable
 *  uploadedAt, can't be judged and is accepted. */
function sourceContentIsCurrent(doc, uploadedAt, nowMs = Date.now()) {
  const putMs = toMs(uploadedAt);
  const stampMs = Date.parse((doc && doc.__updatedAt) || '');
  if (!Number.isFinite(putMs) || !Number.isFinite(stampMs)) return true;
  if (putMs - stampMs <= FRESHNESS_SKEW_MS) return true;
  return nowMs - putMs > STALE_SUSPECT_WINDOW_MS; // settled → current by definition
}

module.exports = {
  contentVerdict,
  sourceContentIsCurrent,
  writeStampMs,
  handlerStampMs,
  FRESHNESS_SKEW_MS,
  PUT_SKEW_MS,
  CDN_SETTLE_MS,
  STALE_SUSPECT_WINDOW_MS,
};
