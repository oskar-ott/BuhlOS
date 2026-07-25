// Leave store helpers (#333). One small global blob — leave volume is tiny
// and the consumers (missing-day computation, weekly board) want cross-user
// reads in one go.
//
//   leave-requests.json → { requests: [{ id, userId, userName, type,
//     fromDate, toDate, note, status: 'pending'|'approved'|'declined'|'cancelled',
//     requestedAt, requestedBy, decidedAt?, decidedBy?, decidedByName?,
//     decisionNote? }] }

const { readBlob, readBlobFresh, writeBlob } = require('./blob');
const { StaleWriteError } = require('./blob-guards');

const KEY = 'leave-requests.json';
const LEAVE_TYPES = ['annual', 'sick', 'rdo', 'unpaid', 'other'];

async function readLeave() {
  const data = await readBlob(KEY, { requests: [] });
  if (Array.isArray(data.requests)) return data;
  // Corrupted/missing shape: keep __rev (when present) so a repairing write
  // below still passes the stale-write check instead of retrying forever.
  return { requests: [], ...(Number.isFinite(data && data.__rev) ? { __rev: data.__rev } : {}) };
}

// Read-modify-write on the single leave blob with optimistic concurrency.
// Without expectedRev, two writes a few seconds apart could interleave
// (cached/propagation-lagged reads) and the later write silently dropped the
// earlier row even though its POST had already returned success — observed
// live on the weekly closeout board marking several days in a row (#127).
// expectedRev turns the overlap into StaleWriteError; we re-read fresh,
// re-apply the mutation and try again. After the retries run out the error
// propagates — an honest failure beats a silent loss.
//
// `mutate(data)` edits data.requests in place and returns the outcome; if it
// returns { abort: {...} } nothing is written (not-found / conflict paths).
// It runs once per attempt against that attempt's snapshot, so it must not
// close over state derived from a previous attempt's data.
async function mutateLeave(mutate) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    const data = attempt === 1
      ? await readLeave()
      : await readBlobFresh(KEY, { requests: [] }).then(d =>
          Array.isArray(d.requests) ? d : { requests: [], ...(Number.isFinite(d && d.__rev) ? { __rev: d.__rev } : {}) });
    const outcome = mutate(data);
    if (outcome && outcome.abort) return outcome;
    try {
      await writeBlob(KEY, data, {
        expectedRev: Number.isFinite(data.__rev) ? data.__rev : 0,
      });
      return outcome;
    } catch (err) {
      if (err instanceof StaleWriteError && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
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

module.exports = { KEY, LEAVE_TYPES, readLeave, mutateLeave, covers, approvedLeaveByUserDate, rangesOverlap };
