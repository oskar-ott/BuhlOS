// Is this jobs.json content the upload list() says is current?
//
// Derived caches (jobs-summary.json, jobs/<id>/detail.json, the admin PG
// extras) are stamped with jobs.json's uploadedAt — list() metadata, which is
// API-fresh. The CONTENT they are built from comes through Vercel Blob's CDN,
// which can serve the pre-overwrite document for up to ~60s after a write even
// with a cache-busting query. Stamping stale content with the new uploadedAt
// marks the cache "fresh" until the NEXT jobs.json write — 2026-10-02: a job
// created at 10:48:15 was missing from the admin list for a day, and creating
// it again said "already exists".
//
// The content's own storage stamp `__updatedAt` (blob-guards applyGuards,
// written immediately before the put) is held against the PUT time. Same
// constants and reasoning as api/_lib/payroll-inputs.js: a genuine write's gap
// measured max 3.1s, so 15s skew; past the settle window a blob is serving its
// current content by definition, so an old stamp then is a fact about how the
// document was written, not a stale read.

const FRESHNESS_SKEW_MS = 15_000;
const STALE_SUSPECT_WINDOW_MS = 5 * 60_000;

/** True when `doc` is plausibly the document stored at `uploadedAt`. A doc
 *  without the storage stamp (legacy / test fixture) or an unparseable
 *  uploadedAt can't be judged and is accepted — never invent staleness. */
function sourceContentIsCurrent(doc, uploadedAt, nowMs = Date.now()) {
  const putMs = Date.parse(uploadedAt || '');
  const stampMs = Date.parse((doc && doc.__updatedAt) || '');
  if (!Number.isFinite(putMs) || !Number.isFinite(stampMs)) return true;
  if (putMs - stampMs <= FRESHNESS_SKEW_MS) return true;
  return nowMs - putMs > STALE_SUSPECT_WINDOW_MS; // settled → current by definition
}

module.exports = { sourceContentIsCurrent, FRESHNESS_SKEW_MS, STALE_SUSPECT_WINDOW_MS };
