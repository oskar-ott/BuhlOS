// Hours dual-write mirror (#152, rung 1) — best-effort, Blob-authoritative.
//
// The first APP code that writes to Postgres. Called from the single hours DAL
// seam (api/_lib/time-entries.js writeEntry/deleteEntry) AFTER the Blob write,
// which stays the source of truth. The PG mirror is best-effort: any failure is
// logged and SWALLOWED — it can never fail a worker's hours save. Drift is
// caught later by scripts/importers/hours-parity.js (the P7 drift alarm).
//
// Triple-gated so production is inert:
//   1. no SUPABASE_DB_URL in the runtime → return immediately (prod is unwired;
//      this also keeps the hot write path free of the flag's blob read);
//   2. supabase_dual_write flag off (default/dark) → return;
//   3. getDb({mode:'write'}) runs the env guard → a non-prod env can only reach
//      the dev project; the prod project needs the explicit write opt-in.
//
// Mapping + upsert come from api/_lib/hours-pg (shared with the importer), so the
// mirror and the bulk import can never diverge.

// LATENCY (mirrorTimeEntry is awaited inside writeEntry): the PG work is bounded
// by MIRROR_TIMEOUT_MS via withTimeout, so a slow/unreachable pooler delays an
// hours save by at most that (a timeout is swallowed like any error — Blob is
// authoritative). The flag-on cost is still ~3 sequential round-trips per save
// (~3N for a sequential bulk-approve); to remove ALL added latency, move the
// mirror off the request path (Vercel waitUntil / the #160 outbox) — a later rung.

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

/**
 * Mirror one time-entry create/edit/status-change into Postgres. Best-effort —
 * NEVER throws. `deps` lets tests inject isFlagOn/getDb.
 * @returns {Promise<{mirrored:boolean, reason?:string}>}
 */
async function mirrorTimeEntry(userId, entry, deps = {}) {
  const flagOn = deps.isFlagOn || isFlagOn;
  const db = deps.getDb || getDb;
  try {
    if (!entry || !entry.date) return { mirrored: false, reason: 'no entry/date' };
    // Cheap prod short-circuit BEFORE the flag's blob read: prod has no SUPABASE_DB_URL.
    if (!process.env.SUPABASE_DB_URL) return { mirrored: false, reason: 'no supabase env' };
    if (!(await flagOn('supabase_dual_write'))) return { mirrored: false, reason: 'flag off' };
    return await withTimeout(mirrorEntryWrite(db, userId, entry), deps.timeoutMs || MIRROR_TIMEOUT_MS, 'mirrorTimeEntry');
  } catch (err) {
    console.error('[hours-mirror] best-effort PG mirror failed (Blob is authoritative):', err && err.message);
    return { mirrored: false, reason: 'error', error: err && err.message };
  }
}

async function mirrorEntryWrite(db, userId, entry) {
  const sql = db({ mode: 'write' }); // env guard runs here; fail-closed
  const resolved = await resolveTenantAndUser(sql, userId);
  if (!resolved) return { mirrored: false, reason: 'tenant/user not mirrored' };

  const row = timeEntryRowFromBlob(entry, {
    userUuid: resolved.userUuid,
    date: entry.date,
    nowIso: new Date().toISOString(),
  });
  const bad = malformedReason(row);
  if (bad) {
    // Log so the skip is visible — the only other drift signal is the parity script.
    console.warn(`[hours-mirror] skipping malformed entry (Blob authoritative, drift alarm will catch): ${bad}`);
    return { mirrored: false, reason: bad };
  }

  await upsertTimeEntries(sql, resolved.tenantId, [row]);
  return { mirrored: true };
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
    if (!(await flagOn('supabase_dual_write'))) return { mirrored: false, reason: 'flag off' };
    return await withTimeout(mirrorDeleteWrite(db, userId, date), deps.timeoutMs || MIRROR_TIMEOUT_MS, 'mirrorTimeEntryDelete');
  } catch (err) {
    console.error('[hours-mirror] best-effort PG delete-mirror failed (Blob is authoritative):', err && err.message);
    return { mirrored: false, reason: 'error', error: err && err.message };
  }
}

async function mirrorDeleteWrite(db, userId, date) {
  const sql = db({ mode: 'write' });
  const resolved = await resolveTenantAndUser(sql, userId);
  if (!resolved) return { mirrored: false, reason: 'tenant/user not mirrored' };

  await sql`
    update public.time_entries set deleted_at = now()
    where tenant_id = ${resolved.tenantId} and user_id = ${resolved.userUuid}
      and work_date = ${date} and deleted_at is null
  `;
  return { mirrored: true };
}

module.exports = { mirrorTimeEntry, mirrorTimeEntryDelete, malformedReason, withTimeout };
