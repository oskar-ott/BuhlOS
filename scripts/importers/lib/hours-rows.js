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

// Matches the schema CHECK abs((ordinary+overtime)-total) < 0.011.
const TOLERANCE = 0.011;
const MAX_NOTES = 500; // schema: notes char_length <= 500

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function timeOrNull(v) {
  return typeof v === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(v) ? v : null;
}
function nonNegIntOrNull(v) {
  return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
}
function tsOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}
function tsOrDefault(v, fallbackIso) {
  return tsOrNull(v) || fallbackIso;
}

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

    const total = Number(e.totalHours);
    const ordinary = Number(e.ordinaryHours);
    const overtime = Number(e.overtimeHours);
    if (!(total > 0) || total > MAX_HOURS_PER_DAY) { q(`total hours ${e.totalHours} out of (0, ${MAX_HOURS_PER_DAY}]`); continue; }
    if (!(ordinary >= 0) || !(overtime >= 0)) { q('ordinary/overtime must be >= 0'); continue; }
    if (Math.abs(ordinary + overtime - total) >= TOLERANCE) { q('ordinary + overtime != total'); continue; }

    const status = e.status || 'draft';
    if (!VALID_STATUSES.includes(status)) { q(`invalid status "${status}"`); continue; }

    const notes = strOrNull(e.notes);
    if (notes && notes.length > MAX_NOTES) { q(`notes exceeds ${MAX_NOTES} chars`); continue; }

    seenKey.add(dupKey);
    rows.push({
      user_id,
      legacy_id: strOrNull(e.id),
      work_date: date,
      start_time: timeOrNull(e.startTime),
      end_time: timeOrNull(e.endTime),
      break_minutes: nonNegIntOrNull(e.breakMinutes),
      total_hours: round2(total),
      ordinary_hours: round2(ordinary),
      overtime_hours: round2(overtime),
      ot_overridden: e.otOverridden === true,
      notes,
      status,
      submitted_at: tsOrNull(e.submittedAt),
      approved_at: tsOrNull(e.approvedAt),
      rejected_at: tsOrNull(e.rejectedAt),
      rejected_reason: strOrNull(e.rejectedReason),
      source: strOrNull(e.source),
      created_at: tsOrDefault(e.createdAt, nowIso),
    });
  }

  return { rows, quarantine };
}

// Mutable columns the upsert overwrites on conflict — everything except the
// conflict key (tenant_id, user_id, work_date) and the insert-only columns
// (legacy_id, created_at). Kept beside the builder so the SET and the
// IS DISTINCT FROM idempotency guard stay in lock-step.
const TIME_ENTRY_MUTABLE_COLS = [
  'start_time', 'end_time', 'break_minutes', 'total_hours', 'ordinary_hours',
  'overtime_hours', 'ot_overridden', 'notes', 'status', 'submitted_at',
  'approved_at', 'rejected_at', 'rejected_reason', 'source',
];
const TIME_ENTRY_INSERT_COLS = [
  'tenant_id', 'user_id', 'legacy_id', 'work_date', ...TIME_ENTRY_MUTABLE_COLS, 'created_at',
];

module.exports = {
  buildTimeEntryRows,
  TIME_ENTRY_MUTABLE_COLS,
  TIME_ENTRY_INSERT_COLS,
};
