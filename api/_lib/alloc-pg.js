// Time-entry allocation primitives — the SINGLE source of truth for the per-job
// hours breakdown (public.time_entry_allocations), shared by the operator
// importer (scripts/importers/allocations-import) AND the live dual-write mirror
// (api/_lib/hours-mirror) so the two can never drift. Pure builder +
// canonicaliser; reconcileAllocations takes a Postgres.js `sql` (which may be a
// transaction handle) and opens no connection itself.
//
// Allocations are children of time_entries (FK ON DELETE CASCADE), keyed in the
// blob as entry.allocations = [{ jobId, hours, notes, sortOrder }] (jobId null =
// "Internal — no job"). They have NO per-row unique key, so idempotency is by
// RECONCILIATION per PARENT ENTRY: canonicaliseAllocations renders an entry's
// set to a stable string, and reconcileAllocations replaces an entry's
// allocations only when the proposed canonical differs from what's stored — an
// unchanged re-run writes nothing.
//
// Validation mirrors production (validateEntryShape + the schema CHECKs): each
// allocation hours > 0, an entry's allocations sum to its total (±0.011), a
// non-null jobId must resolve to an imported job, notes <= 500. A bad entry
// QUARANTINES (its allocations are skipped) — never guessed/coerced.

const TOLERANCE = 0.011;
const MAX_NOTES = 500;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Stable, order-independent, delimiter-safe string for an allocation set. Each
 * row is a JSON tuple [job_id|null, hours-2dp-string, notes|null, sort_order];
 * JSON.stringify escapes embedded quotes/delimiters and keeps null distinct from
 * "null"; hours via Number(...).toFixed(2) so a JS number (proposed) and a
 * numeric(4,2) string (Postgres) canonicalise identically; total-order sort
 * (sort_order, job_id, hours, notes) so equal sets always serialise identically.
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

/**
 * Reconcile each parent entry's allocations: replace its set only when the
 * stored canonical differs from the proposed (so an unchanged run writes
 * nothing). `sql` may be a transaction handle — the caller owns the transaction.
 * @param {import('postgres').Sql} sql
 * @param {string} tenantId
 * @param {Array<{timeEntryId:string, rows:Array<object>, canonical:string}>} byEntry
 */
async function reconcileAllocations(sql, tenantId, byEntry) {
  const ids = byEntry.map((b) => b.timeEntryId);
  if (!ids.length) return { entriesReplaced: 0, entriesUnchanged: 0, allocationsInserted: 0 };

  const existing = await sql`
    select time_entry_id, job_id, hours::text as hours, notes, sort_order
    from public.time_entry_allocations
    where tenant_id = ${tenantId} and time_entry_id in ${sql(ids)}
  `;
  const exByEntry = new Map();
  for (const r of existing) {
    const arr = exByEntry.get(r.time_entry_id) || [];
    arr.push(r);
    exByEntry.set(r.time_entry_id, arr);
  }
  const changed = byEntry.filter(
    (b) => canonicaliseAllocations(exByEntry.get(b.timeEntryId) || []) !== b.canonical
  );

  let allocationsInserted = 0;
  if (changed.length) {
    const cids = changed.map((b) => b.timeEntryId);
    await sql`delete from public.time_entry_allocations where tenant_id = ${tenantId} and time_entry_id in ${sql(cids)}`;
    const insertRows = changed.flatMap((b) =>
      b.rows.map((r) => ({ tenant_id: tenantId, time_entry_id: b.timeEntryId, ...r }))
    );
    if (insertRows.length) {
      await sql`insert into public.time_entry_allocations ${sql(insertRows, ...ALLOCATION_INSERT_COLS)}`;
      allocationsInserted = insertRows.length;
    }
  }
  return { entriesReplaced: changed.length, entriesUnchanged: byEntry.length - changed.length, allocationsInserted };
}

module.exports = {
  buildAllocationRows,
  canonicaliseAllocations,
  reconcileAllocations,
  ALLOCATION_INSERT_COLS,
};
