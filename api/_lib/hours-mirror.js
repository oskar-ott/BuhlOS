// Hours dual-write mirror (#152, rung 1) — best-effort, Blob-authoritative.
//
// The first APP code that writes to Postgres. Called from the single hours DAL
// seam (api/_lib/time-entries.js writeEntry/deleteEntry) AFTER the Blob write,
// which stays the source of truth. The PG mirror is best-effort: any failure is
// logged and SWALLOWED — it can never fail a worker's hours save. Drift is
// caught later by scripts/importers/hours-parity.js (the P7 drift alarm).
//
// PG-AS-SOURCE Stage A (supabase_source_hours): because this mirror is ALREADY a
// synchronous, in-request, per-row upsert into a fully-constrained schema, it IS
// the hours Stage-A write — no separate write file is needed (contrast tasks,
// whose mirror was an async cron, so #738 added a new synchronous write). The
// source flag simply designates this write as source-authoritative; the PG work
// runs when EITHER supabase_source_hours OR the generic supabase_dual_write is on,
// and the return reports `source` so the diagnostics readout can show hours'
// write-source mode. The read stays parity-gated in Stage A (a PG lag falls back
// to current Blob — never stale); the PG-authoritative payroll read is Stage B.
//
// Triple-gated so production is inert:
//   1. no SUPABASE_DB_URL in the runtime → return immediately (prod is unwired;
//      this also keeps the hot write path free of the flag's blob read);
//   2. both supabase_source_hours AND supabase_dual_write off (default/dark) → return;
//   3. getDb({mode:'write'}) runs the env guard → a non-prod env can only reach
//      the dev project; the prod project needs the explicit write opt-in.
//
// Mirrors the time_entry AND its time_entry_allocations (per-job split), so a
// read-cutover that serves PG sees a faithful entry. Mapping + upsert + the
// allocation reconcile come from api/_lib/{hours-pg,alloc-pg} (shared with the
// importer), so the mirror and the bulk import can never diverge.

// LATENCY (mirrorTimeEntry is awaited inside writeEntry): the PG work is bounded
// by MIRROR_TIMEOUT_MS via withTimeout, so a slow/unreachable pooler delays an
// hours save by at most that (a timeout is swallowed like any error — Blob is
// authoritative). The flag-on cost is a handful of sequential round-trips per
// save (resolve + a txn upserting the entry and reconciling allocations); to
// remove ALL added latency, move the mirror off the request path (Vercel
// waitUntil / the #160 outbox) — a later rung.

// Max wall-clock the mirror may add to an hours save. getDb's connect_timeout is
// 10s; this bounds the user-facing delay well under that. A healthy warm pooler
// returns in well under a second.
const MIRROR_TIMEOUT_MS = 5000;

const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
const {
  timeEntryRowFromBlob,
  upsertTimeEntries,
  MAX_NOTES,
  MAX_TOTAL_HOURS,
  TOLERANCE,
  VALID_TIME_ENTRY_STATUSES,
} = require('./hours-pg');
const { buildAllocationRows, reconcileAllocations } = require('./alloc-pg');

// Race a promise against a timeout. On timeout the underlying query is left to
// settle on its own (best-effort), but the caller is unblocked. The timer is
// unref'd + cleared so it never keeps the process alive.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Belt-and-braces: the API already validated via validateEntryShape, but never
// hand the upsert a row that would trip a schema CHECK (it would throw and be
// swallowed → a scary log + silent perpetual drift). Mirror the importer's
// guards exactly. Returns a reason string when the row must be skipped, else ''.
function malformedReason(row) {
  if (!(row.total_hours > 0) || row.total_hours > MAX_TOTAL_HOURS) return 'invalid total';
  if (Math.abs(row.ordinary_hours + row.overtime_hours - row.total_hours) >= TOLERANCE) return 'ordinary+overtime != total';
  if (row.notes && row.notes.length > MAX_NOTES) return 'notes too long';
  if (!VALID_TIME_ENTRY_STATUSES.includes(row.status)) return 'invalid status';
  return '';
}

async function resolveTenantAndUser(sql, userId) {
  const t = await sql`select id from public.tenants where slug = 'buhl'`;
  if (!t.length) return null;
  const u = await sql`
    select id from public.user_profiles
    where tenant_id = ${t[0].id} and legacy_user_id = ${userId} and deleted_at is null
  `;
  if (!u.length) return null;
  return { tenantId: t[0].id, userUuid: u[0].id };
}

// Resolve a set of legacy user ids → uuids (for attribution: approvedBy /
// enteredByUserId). One query; missing ids simply don't appear in the map.
async function resolveUsers(sql, tenantId, legacyIds) {
  if (!legacyIds.length) return new Map();
  const rows = await sql`
    select id, legacy_user_id from public.user_profiles
    where tenant_id = ${tenantId} and legacy_user_id in ${sql(legacyIds)} and deleted_at is null
  `;
  return new Map(rows.map((r) => [r.legacy_user_id, r.id]));
}

// Resolve a set of legacy job ids → uuids (for allocation job_id). One query.
async function resolveJobs(sql, tenantId, legacyIds) {
  if (!legacyIds.length) return new Map();
  const rows = await sql`
    select id, legacy_id from public.jobs
    where tenant_id = ${tenantId} and legacy_id in ${sql(legacyIds)} and deleted_at is null
  `;
  return new Map(rows.map((r) => [r.legacy_id, r.id]));
}

// Resolve the hours write gate once. The PG write runs when EITHER the Stage-A
// source flag OR the generic dual-write flag is on. Read the source flag FIRST and
// short-circuit, so once hours is promoted (source on) the hot path costs a single
// flag read, not two. Returns { write, source } — `source` is reported back so the
// diagnostics readout can show hours' write-source mode.
async function resolveHoursWriteGate(flagOn) {
  const source = await flagOn('supabase_source_hours');
  const write = source || (await flagOn('supabase_dual_write'));
  return { write, source };
}

/**
 * Mirror one time-entry create/edit/status-change into Postgres. Best-effort —
 * NEVER throws. `deps` lets tests inject isFlagOn/getDb.
 * @returns {Promise<{mirrored:boolean, reason?:string, source?:boolean}>}
 */
async function mirrorTimeEntry(userId, entry, deps = {}) {
  const flagOn = deps.isFlagOn || isFlagOn;
  const db = deps.getDb || getDb;
  try {
    if (!entry || !entry.date) return { mirrored: false, reason: 'no entry/date' };
    // Cheap prod short-circuit BEFORE the flag's blob read: prod has no SUPABASE_DB_URL.
    if (!process.env.SUPABASE_DB_URL) return { mirrored: false, reason: 'no supabase env' };
    const { write, source } = await resolveHoursWriteGate(flagOn);
    if (!write) return { mirrored: false, reason: 'flag off' };
    return await withTimeout(mirrorEntryWrite(db, userId, entry, source), deps.timeoutMs || MIRROR_TIMEOUT_MS, 'mirrorTimeEntry');
  } catch (err) {
    console.error('[hours-mirror] best-effort PG mirror failed (Blob is authoritative):', err && err.message);
    return { mirrored: false, reason: 'error', error: err && err.message };
  }
}

async function mirrorEntryWrite(db, userId, entry, source = false) {
  const sql = db({ mode: 'write' }); // env guard runs here; fail-closed
  const resolved = await resolveTenantAndUser(sql, userId);
  if (!resolved) return { mirrored: false, reason: 'tenant/user not mirrored', source };

  // Resolve the attribution legacy ids (approvedBy/enteredByUserId) too, except
  // the entry's own user which we already have. Best-effort: unresolved → NULL.
  const attrIds = [entry.approvedBy, entry.enteredByUserId].filter((x) => x && x !== userId);
  const attrMap = await resolveUsers(sql, resolved.tenantId, [...new Set(attrIds)]);

  const row = timeEntryRowFromBlob(entry, {
    userUuid: resolved.userUuid,
    date: entry.date,
    nowIso: new Date().toISOString(),
    resolveUser: (legacyId) => (legacyId === userId ? resolved.userUuid : attrMap.get(legacyId) || null),
  });
  const bad = malformedReason(row);
  if (bad) {
    // Log so the skip is visible — the only other drift signal is the parity script.
    console.warn(`[hours-mirror] skipping malformed entry (Blob authoritative, drift alarm will catch): ${bad}`);
    return { mirrored: false, reason: bad, source };
  }

  // Resolve the entry's allocation job ids (best-effort) for the allocation mirror.
  const jobIds = [...new Set((Array.isArray(entry.allocations) ? entry.allocations : []).map((a) => a && a.jobId).filter(Boolean))];
  const jobMap = await resolveJobs(sql, resolved.tenantId, jobIds);

  // Mirror the time_entry AND its allocations atomically: a read-cutover that
  // serves PG must see both, or a live-created entry shows an empty per-job split.
  await sql.begin(async (tx) => {
    await upsertTimeEntries(tx, resolved.tenantId, [row]);
    // Fetch the entry id (even when the upsert was a no-op) to reconcile allocations.
    const [te] = await tx`
      select id from public.time_entries
      where tenant_id = ${resolved.tenantId} and user_id = ${resolved.userUuid}
        and work_date = ${entry.date} and deleted_at is null
    `;
    if (!te) return;
    const { byEntry, quarantine } = buildAllocationRows({
      records: [{ userId, date: entry.date, entry }],
      userMap: new Map([[userId, resolved.userUuid]]),
      jobMap,
      timeEntryMap: new Map([[`${resolved.userUuid}|${entry.date}`, te.id]]),
    });
    if (quarantine.length) {
      // The time_entry is mirrored; its allocation breakdown is malformed (bad
      // sum / unresolved job) → skip just the allocations (best-effort; the drift
      // alarm catches it) rather than failing the whole mirror.
      console.warn(`[hours-mirror] allocations not mirrored (entry still mirrored): ${quarantine[0].reason}`);
      return;
    }
    await reconcileAllocations(tx, resolved.tenantId, byEntry);
  });
  return { mirrored: true, source };
}

/**
 * Mirror a hours delete into Postgres as a soft-delete. Best-effort — never throws.
 */
async function mirrorTimeEntryDelete(userId, date, deps = {}) {
  const flagOn = deps.isFlagOn || isFlagOn;
  const db = deps.getDb || getDb;
  try {
    if (!date) return { mirrored: false, reason: 'no date' };
    if (!process.env.SUPABASE_DB_URL) return { mirrored: false, reason: 'no supabase env' };
    const { write, source } = await resolveHoursWriteGate(flagOn);
    if (!write) return { mirrored: false, reason: 'flag off' };
    return await withTimeout(mirrorDeleteWrite(db, userId, date, source), deps.timeoutMs || MIRROR_TIMEOUT_MS, 'mirrorTimeEntryDelete');
  } catch (err) {
    console.error('[hours-mirror] best-effort PG delete-mirror failed (Blob is authoritative):', err && err.message);
    return { mirrored: false, reason: 'error', error: err && err.message };
  }
}

async function mirrorDeleteWrite(db, userId, date, source = false) {
  const sql = db({ mode: 'write' });
  const resolved = await resolveTenantAndUser(sql, userId);
  if (!resolved) return { mirrored: false, reason: 'tenant/user not mirrored', source };

  await sql`
    update public.time_entries set deleted_at = now()
    where tenant_id = ${resolved.tenantId} and user_id = ${resolved.userUuid}
      and work_date = ${date} and deleted_at is null
  `;
  return { mirrored: true, source };
}

module.exports = { mirrorTimeEntry, mirrorTimeEntryDelete, malformedReason, withTimeout };
