// Leave store helpers (#333).
//
// Layout (#127 lost-write fix, round 2): ONE BLOB PER REQUEST —
//   leave-requests/<id>.json → { id, userId, userName, type, fromDate, toDate,
//     note, status: 'pending'|'approved'|'declined'|'cancelled', requestedAt,
//     requestedBy, decidedAt?, decidedBy?, decidedByName?, decisionNote? }
//
// WHY: the original single-document store (leave-requests.json) was a shared
// read-modify-write. A CAS (expectedRev) pass was tried first and STILL lost
// writes live on 2026-07-25 — Vercel Blob's CDN can serve a consistently
// stale body for 10+ seconds after an overwrite, so both the handler read and
// the fresh conflict-check read see the same old revision and the "conflict"
// never trips. Same failure class the hours store solved with per-day files:
// a CREATE on a brand-new path can never be erased by a concurrent writer,
// and status changes only ever overwrite that one request's own document.
//
// The old aggregate doc remains as a READ-ONLY legacy fallback: rows are
// merged by id (a per-request file always wins), and any mutation of a legacy
// row is written as a per-request file (migrate-on-write). Nothing writes the
// aggregate any more.

const { list } = require('@vercel/blob');
const { readBlob, writeBlob } = require('./blob');

const KEY = 'leave-requests.json'; // legacy aggregate — read-only fallback
const PREFIX = 'leave-requests/';
const LEAVE_TYPES = ['annual', 'sick', 'rdo', 'unpaid', 'other'];

function fileKey(id) {
  return PREFIX + id + '.json';
}

/** All per-request documents. Fail-soft to [] — a transient list failure must
 *  degrade to the legacy view, never crash reads (missing-day computation). */
async function readRequestFiles() {
  let blobs;
  try {
    ({ blobs } = await list({
      prefix: PREFIX,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      limit: 1000,
    }));
  } catch {
    return [];
  }
  const keys = (blobs || [])
    .map((b) => b.pathname)
    .filter((p) => p.startsWith(PREFIX) && p.endsWith('.json'));
  const docs = await Promise.all(keys.map((k) => readBlob(k, null).catch(() => null)));
  return docs.filter((d) => d && d.id);
}

async function readLeave() {
  const [files, legacy] = await Promise.all([
    readRequestFiles(),
    readBlob(KEY, { requests: [] }),
  ]);
  const byId = new Map();
  for (const r of Array.isArray(legacy.requests) ? legacy.requests : []) {
    if (r && r.id) byId.set(r.id, r);
  }
  for (const r of files) byId.set(r.id, r); // per-file version wins
  const requests = [...byId.values()].sort((a, b) =>
    String(a.requestedAt || '').localeCompare(String(b.requestedAt || '')) ||
    String(a.id).localeCompare(String(b.id)));
  return { requests };
}

/** Persist one request as its own document. A row that came from a per-request
 *  file carries that file's __rev — threading it as expectedRev turns an edit
 *  of the SAME request into a guarded write (concurrent decides of one request
 *  conflict loudly instead of silently overwriting). Legacy rows and fresh
 *  creates carry no __rev → plain create of a new path. */
async function saveRequest(request) {
  await writeBlob(fileKey(request.id), request, { expectedRev: request.__rev });
  return request;
}

/** date (YYYY-MM-DD) inside [fromDate, toDate] inclusive. */
function covers(request, date) {
  return request.fromDate <= date && date <= request.toDate;
}

/** Map 'userId|date' → leave type for APPROVED leave in [fromDate, toDate]. */
function approvedLeaveByUserDate(requests, fromDate, toDate) {
  const map = {};
  for (const r of requests) {
    if (r.status !== 'approved') continue;
    if (r.toDate < fromDate || r.fromDate > toDate) continue;
    const cursor = new Date((r.fromDate < fromDate ? fromDate : r.fromDate) + 'T00:00:00');
    const end = new Date((r.toDate > toDate ? toDate : r.toDate) + 'T00:00:00');
    while (cursor <= end) {
      const iso =
        cursor.getFullYear() + '-' +
        String(cursor.getMonth() + 1).padStart(2, '0') + '-' +
        String(cursor.getDate()).padStart(2, '0');
      map[r.userId + '|' + iso] = r.type;
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return map;
}

/** Two date ranges overlap (inclusive). */
function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom <= bTo && bFrom <= aTo;
}

module.exports = { KEY, PREFIX, LEAVE_TYPES, readLeave, saveRequest, covers, approvedLeaveByUserDate, rangesOverlap };
