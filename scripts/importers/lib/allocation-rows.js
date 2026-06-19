// Time-entry allocation row builder — PURE. No I/O, no Supabase, no Blob.
//
// Allocations are the per-job breakdown of a time entry's hours
// (entry.allocations = [{ jobId, hours, notes, sortOrder }], jobId null =
// "Internal (no job)"). They live in public.time_entry_allocations, children of
// time_entries (FK ON DELETE CASCADE). Run AFTER hours-import: each allocation
// resolves its parent time_entry_id from (user uuid, work_date) and its job_id
// from the legacy job id.
//
// IDEMPOTENCY — allocations have NO per-row legacy/business key (no unique
// index to upsert on), so they can't be upserted row-by-row. Instead they are
// reconciled per PARENT ENTRY: canonicaliseAllocations() renders an entry's
// allocation set to a stable string; the importer replaces an entry's
// allocations only when the proposed canonical differs from what's stored, so
// an unchanged re-run writes nothing. canonicaliseAllocations is exported and
// used for BOTH the proposed (blob) and existing (Postgres) sides so the
// comparison is apples-to-apples.
//
// Validation mirrors production (api/_lib/time-entries.js validateEntryShape +
// the dry-run planner): each allocation hours > 0, an entry's allocation hours
// sum to its total (±0.011), a non-null jobId must resolve to an imported job,
// notes <= 500. A bad entry QUARANTINES (its allocations are skipped) — never
// guessed/coerced.

// abs(sum - total) tolerance, matching the schema/validateEntryShape rule.
const TOLERANCE = 0.011;
const MAX_NOTES = 500;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Stable string for an allocation set — order-independent so two sets compare
 * equal regardless of input ordering. Each row is a JSON tuple
 * [job_id|null, hours-2dp-string, notes|null, sort_order]; JSON.stringify
 * escapes embedded quotes/delimiters (so a notes value containing | or ; can't
 * forge a row boundary) and keeps null distinct from the literal "null". hours
 * via Number(...).toFixed(2) so a JS number (proposed) and a numeric(4,2)
 * string (Postgres) canonicalise identically. The sort is a TOTAL order
 * (sort_order, job_id, hours, notes) so equal sets always serialise identically.
 * @param {Array<{job_id:string|null,hours:number|string,notes:string|null,sort_order:number}>} rows
 */
function canonicaliseAllocations(rows) {
  const tuples = (rows || []).map((r) => [r.job_id ?? null, Number(r.hours).toFixed(2), r.notes ?? null, r.sort_order]);
  tuples.sort(
    (a, b) =>
      a[3] - b[3] ||
      String(a[0]).localeCompare(String(b[0])) ||
      a[1].localeCompare(b[1]) ||
      String(a[2]).localeCompare(String(b[2]))
  );
  return JSON.stringify(tuples);
}

/**
 * @param {object} input
 * @param {Array<{userId:string,date:string,entry:object}>} input.records
 * @param {Map<string,string>} input.userMap legacy user id → user_profiles uuid
 * @param {Map<string,string>} input.jobMap  legacy job id → jobs uuid
 * @param {Map<string,string>} input.timeEntryMap `${user_uuid}|${date}` → time_entry uuid
 * @returns {{ byEntry: Array<{timeEntryId:string, rows:Array<object>, canonical:string}>, quarantine: Array<{ref:string,reason:string}> }}
 */
function buildAllocationRows({ records = [], userMap = new Map(), jobMap = new Map(), timeEntryMap = new Map() } = {}) {
  const byEntry = [];
  const quarantine = [];

  for (const rec of records) {
    const userId = rec && rec.userId;
    const date = rec && rec.date;
    const e = (rec && rec.entry) || null;
    const ref = `${userId || '?'}|${date || '?'}`;
    let quarantined = false;
    const q = (reason) => {
      if (!quarantined) { quarantine.push({ ref, reason }); quarantined = true; }
    };

    if (!e || typeof e !== 'object') { q('unreadable/empty entry'); continue; }

    const user_id = userMap.get(userId);
    if (!user_id) { q('user not imported (run structure-import first)'); continue; }
    const timeEntryId = timeEntryMap.get(`${user_id}|${date}`);
    if (!timeEntryId) { q('no time_entry for (user, date) — run hours-import first'); continue; }

    const allocations = Array.isArray(e.allocations) ? e.allocations : [];
    const rows = [];
    let sum = 0;
    allocations.forEach((a, i) => {
      const hours = round2(a && a.hours);
      if (!(hours > 0)) { q(`allocation[${i}] hours must be > 0`); return; }
      let job_id = null;
      if (a && a.jobId != null) {
        job_id = jobMap.get(a.jobId) || null;
        if (!job_id) { q(`allocation[${i}] job "${a.jobId}" not imported`); return; }
      }
      const notes = strOrNull(a && a.notes);
      if (notes && notes.length > MAX_NOTES) { q(`allocation[${i}] notes exceeds ${MAX_NOTES} chars`); return; }
      const sort_order = Number.isFinite(a && a.sortOrder) ? Math.trunc(a.sortOrder) : i;
      rows.push({ job_id, hours, notes, sort_order });
      sum += hours;
    });
    if (quarantined) continue;

    // Every time_entry has total_hours > 0 (schema CHECK), so an entry with no
    // valid allocations is invalid (prod requires >=1 summing to total).
    // Quarantine it — accepting canonical '' would otherwise make the reconcile
    // DELETE any existing allocations for this entry down to zero.
    if (rows.length === 0) { q('no valid allocations for an entry with positive total'); continue; }

    // allocation hours must reconcile with the (already-imported) entry total.
    const total = round2(e.totalHours);
    if (Math.abs(round2(sum) - total) >= TOLERANCE) {
      q(`allocation hours ${round2(sum)} != total ${total}`);
      continue;
    }

    byEntry.push({ timeEntryId, rows, canonical: canonicaliseAllocations(rows) });
  }

  return { byEntry, quarantine };
}

// Columns inserted per allocation row (tenant_id + time_entry_id added at write).
const ALLOCATION_INSERT_COLS = ['tenant_id', 'time_entry_id', 'job_id', 'hours', 'notes', 'sort_order'];

module.exports = {
  buildAllocationRows,
  canonicaliseAllocations,
  ALLOCATION_INSERT_COLS,
};
