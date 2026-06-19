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

// ROLLOUT CAVEAT (inert today, flag dark + prod unwired): mirrorTimeEntry is
// awaited inside writeEntry, so once the flag is flipped ON against a live
// project each save pays the mirror's tenant+user SELECTs + upsert (≈3 round
// trips; ≈3N for a sequential bulk-approve), and a slow/unreachable pooler can
// delay the response by up to getDb's connect_timeout. Before enabling the flag
// in any latency-sensitive env, add a short mirror timeout and/or move the
// mirror off the request path (e.g. Vercel waitUntil / the #160 outbox).

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
  } catch (err) {
    console.error('[hours-mirror] best-effort PG mirror failed (Blob is authoritative):', err && err.message);
    return { mirrored: false, reason: 'error', error: err && err.message };
  }
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

    const sql = db({ mode: 'write' });
    const resolved = await resolveTenantAndUser(sql, userId);
    if (!resolved) return { mirrored: false, reason: 'tenant/user not mirrored' };

    await sql`
      update public.time_entries set deleted_at = now()
      where tenant_id = ${resolved.tenantId} and user_id = ${resolved.userUuid}
        and work_date = ${date} and deleted_at is null
    `;
    return { mirrored: true };
  } catch (err) {
    console.error('[hours-mirror] best-effort PG delete-mirror failed (Blob is authoritative):', err && err.message);
    return { mirrored: false, reason: 'error', error: err && err.message };
  }
}

module.exports = { mirrorTimeEntry, mirrorTimeEntryDelete, malformedReason };
