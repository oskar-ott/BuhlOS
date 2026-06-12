// Leave store helpers (#333). One small global blob — leave volume is tiny
// and the consumers (missing-day computation, weekly board) want cross-user
// reads in one go.
//
//   leave-requests.json → { requests: [{ id, userId, userName, type,
//     fromDate, toDate, note, status: 'pending'|'approved'|'declined'|'cancelled',
//     requestedAt, requestedBy, decidedAt?, decidedBy?, decidedByName?,
//     decisionNote? }] }

const { readBlob } = require('./blob');

const KEY = 'leave-requests.json';
const LEAVE_TYPES = ['annual', 'sick', 'rdo', 'unpaid', 'other'];

async function readLeave() {
  const data = await readBlob(KEY, { requests: [] });
  return Array.isArray(data.requests) ? data : { requests: [] };
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

module.exports = { KEY, LEAVE_TYPES, readLeave, covers, approvedLeaveByUserDate, rangesOverlap };
