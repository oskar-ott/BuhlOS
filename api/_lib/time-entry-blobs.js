'use strict';

// Complete walk of the per-user time-entry blobs
// (users/<uid>/time-entries/<date>.json) — the read every per-job labour figure
// recomputes from, since there is no per-job hours index (#134).
//
// Every hours walk in api/ used `list({ prefix: 'users/', limit: 5000 })` and
// never followed the cursor — a silent cap (#935): past 5000 blobs under
// users/ (≈ 90 weeks of a 10-worker crew plus audit files) entries would simply
// vanish from per-job labour, the approver queue and the daily digest, with
// no error. This helper pages with `cursor` until `hasMore` is false, so the
// walk is complete regardless of store size. Adopted by the per-job money read
// (api/job-profitability.js) and the approver/day walks in _lib/time-entries.js;
// the remaining 5000-limit callers are tracked on #935.
//
// Audit blobs (users/<uid>/time-entries-audit/…) are excluded — they are the
// hours-audit journal, not entries.

const { list } = require('@vercel/blob');

function isTimeEntryBlob(b) {
  if (!b || typeof b.pathname !== 'string') return false;
  return (
    b.pathname.includes('/time-entries/') &&
    !b.pathname.includes('/time-entries-audit/') &&
    b.pathname.endsWith('.json')
  );
}

/** Every time-entry blob ({ pathname, url, … }) under users/, fully paginated. */
async function listTimeEntryBlobs() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const out = [];
  let cursor;
  do {
    const r = await list({ prefix: 'users/', token, limit: 1000, cursor });
    for (const b of (r && r.blobs) || []) if (isTimeEntryBlob(b)) out.push(b);
    cursor = r && r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

/** Fetch + parse each blob; unreadable ones are dropped (callers that must
 *  COUNT unreadable blobs — listEntriesForDate — keep their own fetch loop). */
async function fetchTimeEntries(blobs) {
  const entries = await Promise.all(
    (blobs || []).map(async (b) => {
      try {
        const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    }),
  );
  return entries.filter(Boolean);
}

module.exports = { listTimeEntryBlobs, fetchTimeEntries, isTimeEntryBlob };
