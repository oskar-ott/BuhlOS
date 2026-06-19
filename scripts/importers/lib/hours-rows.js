// Hours import row builder — PURE. No I/O, no Supabase, no Blob.
//
// Turns the legacy Blob hours (users/<id>/time-entries/<date>.json, one per
// user per day) into public.time_entries rows. This is the slice that flips
// the hours parity check (scripts/importers/hours-parity.js) from "Postgres
// behind" to IN SYNC, and the data the #152 dual-write will mirror.
//
// Depends on the structure import having already run: each row's user_id is
// resolved from a caller-supplied map of (legacy user id → minted
// user_profiles uuid). A blob entry whose user is not in that map is
// QUARANTINED (missing FK target), never written with a guessed user.
//
// Deliberately NOT in this slice (each its own follow-up):
//   * time_entry_allocations — the per-job hours breakdown. No natural legacy
//     key per allocation, so it needs a replace-children-or-diff idempotency
//     story of its own; and the parity check compares time_entries totals, not
//     allocations, so this slice flips parity without it.
//   * payroll_runs — sourced from payroll-runs.json, independent.
//   * the user-FK attribution columns approved_by / rejected_by / created_by /
//     updated_by — left NULL (nullable); they'd need the same legacy→uuid
//     resolution and are not part of the parity comparison.
//
// Validation mirrors production (api/_lib/time-entries.js + the schema CHECKs),
// reusing the dry-run planner's validators — unknown status, non-positive or
// >16h totals, ordinary+overtime≠total, invalid dates QUARANTINE the record
// (never coerced). created_at is preserved when a real ISO timestamp, else the
// import-time stamp (passed in, so the builder stays pure).

const { isValidISODate, VALID_STATUSES, MAX_HOURS_PER_DAY } = require('./hours-plan');
// Field mapping + column lists live in the shared app-code module so the live
// dual-write mirror (api/_lib/hours-mirror) maps identically — no drift.
const {
  TOLERANCE,
  MAX_NOTES,
  timeEntryRowFromBlob,
  TIME_ENTRY_MUTABLE_COLS,
  TIME_ENTRY_INSERT_COLS,
} = require('../../../api/_lib/hours-pg');

/**
 * @param {object} input
 * @param {Array<{userId:string,date:string,entry:object}>} input.records one per day blob
 * @param {Map<string,string>} input.userMap legacy user id → user_profiles uuid
 * @param {string} input.nowIso import-time stamp for created_at fallback
 * @returns {{ rows: Array<object>, quarantine: Array<{ref:string,reason:string}> }}
 */
function buildTimeEntryRows({ records = [], userMap = new Map(), nowIso = '1970-01-01T00:00:00.000Z' } = {}) {
  const rows = [];
  const quarantine = [];
  // (user_id, work_date) is the upsert key; guard against two blobs colliding.
  const seenKey = new Set();
  // legacy_id has its OWN partial unique index (time_entries_legacy_uq) that the
  // (user,date) ON CONFLICT does not arbitrate, so dedup it too — a repeated id
  // quarantines cleanly instead of aborting the whole INSERT with a raw error.
  const seenLegacyId = new Set();

  for (const rec of records) {
    const userId = rec && rec.userId;
    const date = rec && rec.date;
    const e = (rec && rec.entry) || null;
    const ref = `${userId || '?'}|${date || '?'}`;
    const q = (reason) => quarantine.push({ ref, reason });

    if (!e || typeof e !== 'object') { q('unreadable/empty entry'); continue; }
    if (!isValidISODate(date)) { q('invalid date key'); continue; }

    const user_id = userMap.get(userId);
    if (!user_id) { q('user not imported (run structure-import first)'); continue; }

    const dupKey = `${user_id}|${date}`;
    if (seenKey.has(dupKey)) { q('duplicate user+date'); continue; }

    // Build the row via the shared mapper, then validate the ROW's stored
    // (2dp-rounded) values, so a passing validation is byte-identical to what
    // is written and therefore guarantees the schema CHECKs pass.
    const row = timeEntryRowFromBlob(e, { userUuid: user_id, date, nowIso });
    if (!(row.total_hours > 0) || row.total_hours > MAX_HOURS_PER_DAY) { q(`total hours ${e.totalHours} out of (0, ${MAX_HOURS_PER_DAY}]`); continue; }
    if (!(row.ordinary_hours >= 0) || !(row.overtime_hours >= 0)) { q('ordinary/overtime must be >= 0'); continue; }
    if (Math.abs(row.ordinary_hours + row.overtime_hours - row.total_hours) >= TOLERANCE) { q('ordinary + overtime != total (at 2dp)'); continue; }
    if (!VALID_STATUSES.includes(row.status)) { q(`invalid status "${row.status}"`); continue; }
    if (row.notes && row.notes.length > MAX_NOTES) { q(`notes exceeds ${MAX_NOTES} chars`); continue; }
    if (row.legacy_id && seenLegacyId.has(row.legacy_id)) { q(`duplicate legacy_id "${row.legacy_id}"`); continue; }

    seenKey.add(dupKey);
    if (row.legacy_id) seenLegacyId.add(row.legacy_id);
    rows.push(row);
  }

  return { rows, quarantine };
}

module.exports = {
  buildTimeEntryRows,
  TIME_ENTRY_MUTABLE_COLS,
  TIME_ENTRY_INSERT_COLS,
};
