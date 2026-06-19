// Hours → Postgres write primitives — the SINGLE source of truth for how a
// time-entry blob maps to a public.time_entries row and how that row is
// upserted. Used by BOTH the operator importer (scripts/importers) and the live
// dual-write mirror (api/_lib/hours-mirror), so the two can never drift.
//
// Pure where it can be (timeEntryRowFromBlob + the column lists); the upsert
// takes a Postgres.js `sql` handle the caller already opened through the env
// guard (api/_lib/supabase-db getDb). Nothing here opens a connection.

// abs((ordinary+overtime)-total) tolerance — matches the schema CHECK.
const TOLERANCE = 0.011;
const MAX_NOTES = 500; // schema: notes char_length <= 500
const MAX_TOTAL_HOURS = 16; // schema: total_hours CHECK (> 0 and <= 16)
// schema: status CHECK in (...). Shared so the importer and the live mirror
// validate against the same set.
const VALID_TIME_ENTRY_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function timeOrNull(v) {
  return typeof v === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(v) ? v : null;
}
// break_minutes is an integer column; a fractional break is truncated (breaks
// are integer minutes in practice and break isn't part of the parity totals).
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
 * Map a Blob time-entry to a public.time_entries row (WITHOUT tenant_id — the
 * upsert adds it). Hours are rounded to 2dp here so the value validated by the
 * importer is byte-identical to the value stored. Does NOT validate — the
 * caller (importer or mirror) is responsible for rejecting bad rows.
 * @param {object} entry the parsed users/<id>/time-entries/<date>.json object
 * @param {{ userUuid: string, date: string, nowIso: string }} ctx
 */
function timeEntryRowFromBlob(entry, ctx) {
  const e = entry || {};
  return {
    user_id: ctx.userUuid,
    legacy_id: strOrNull(e.id),
    work_date: ctx.date,
    start_time: timeOrNull(e.startTime),
    end_time: timeOrNull(e.endTime),
    break_minutes: nonNegIntOrNull(e.breakMinutes),
    total_hours: round2(e.totalHours),
    ordinary_hours: round2(e.ordinaryHours),
    overtime_hours: round2(e.overtimeHours),
    ot_overridden: e.otOverridden === true,
    notes: strOrNull(e.notes),
    status: e.status || 'draft',
    submitted_at: tsOrNull(e.submittedAt),
    approved_at: tsOrNull(e.approvedAt),
    rejected_at: tsOrNull(e.rejectedAt),
    rejected_reason: strOrNull(e.rejectedReason),
    source: strOrNull(e.source),
    created_at: tsOrDefault(e.createdAt, ctx.nowIso),
  };
}

// Mutable columns the upsert overwrites on conflict — everything except the
// conflict key (tenant_id, user_id, work_date) and the insert-only columns
// (legacy_id, created_at). The SET and the IS DISTINCT FROM idempotency guard
// stay in lock-step by both deriving from this list.
const TIME_ENTRY_MUTABLE_COLS = [
  'start_time', 'end_time', 'break_minutes', 'total_hours', 'ordinary_hours',
  'overtime_hours', 'ot_overridden', 'notes', 'status', 'submitted_at',
  'approved_at', 'rejected_at', 'rejected_reason', 'source',
];
const TIME_ENTRY_INSERT_COLS = [
  'tenant_id', 'user_id', 'legacy_id', 'work_date', ...TIME_ENTRY_MUTABLE_COLS, 'created_at',
];

// SET fragment "col = excluded.col, …" for ON CONFLICT DO UPDATE.
function setExcluded(sql, cols) {
  if (!cols.length) throw new Error('setExcluded: no mutable columns');
  return cols.map((c) => sql`${sql(c)} = excluded.${sql(c)}`).reduce((a, b) => sql`${a}, ${b}`);
}
// WHERE fragment "<table>.col IS DISTINCT FROM excluded.col OR …" — the update
// fires only when something changed. The target column MUST be table-qualified
// (unqualified it is ambiguous vs EXCLUDED).
function distinctFromExcluded(sql, table, cols) {
  if (!cols.length) throw new Error('distinctFromExcluded: no mutable columns');
  return cols
    .map((c) => sql`${sql(table)}.${sql(c)} is distinct from excluded.${sql(c)}`)
    .reduce((a, b) => sql`${a} or ${b}`);
}

/**
 * Idempotent upsert of time_entries rows on the business key
 * (tenant_id, user_id, work_date) WHERE deleted_at is null, guarded by
 * IS DISTINCT FROM so an unchanged row is a no-op (no revision/updated_at
 * churn). Adds tenant_id to each row. Returns insert/update/unchanged counts.
 * `sql` may be a transaction handle. (xmax = 0) marks an insert; reliable for a
 * single-writer caller — not for concurrent writers to the same row.
 * @param {import('postgres').Sql} sql
 * @param {string} tenantId
 * @param {Array<object>} rows rows from timeEntryRowFromBlob (no tenant_id)
 */
async function upsertTimeEntries(sql, tenantId, rows) {
  if (!rows.length) return { inserted: 0, updated: 0, unchanged: 0, total: 0 };
  const rowsT = rows.map((r) => ({ ...r, tenant_id: tenantId }));
  const ret = await sql`
    insert into public.time_entries ${sql(rowsT, ...TIME_ENTRY_INSERT_COLS)}
    on conflict (tenant_id, user_id, work_date) where deleted_at is null
    do update set ${setExcluded(sql, TIME_ENTRY_MUTABLE_COLS)}
    where ${distinctFromExcluded(sql, 'time_entries', TIME_ENTRY_MUTABLE_COLS)}
    returning (xmax = 0) as inserted
  `;
  const inserted = ret.filter((r) => r.inserted).length;
  return { inserted, updated: ret.length - inserted, unchanged: rowsT.length - ret.length, total: rowsT.length };
}

module.exports = {
  TOLERANCE,
  MAX_NOTES,
  MAX_TOTAL_HOURS,
  VALID_TIME_ENTRY_STATUSES,
  round2,
  strOrNull,
  timeEntryRowFromBlob,
  TIME_ENTRY_MUTABLE_COLS,
  TIME_ENTRY_INSERT_COLS,
  setExcluded,
  distinctFromExcluded,
  upsertTimeEntries,
};
