// Hours read-cutover (#152, rung 3) — serve the hours DISPLAY read from
// Postgres with a Blob fallback, behind the supabase_read_hours flag.
//
// Only listUserEntries (display) is cut over. readEntry stays on Blob because
// it feeds the read-modify-write path — serving a reconstructed entry there
// could write reconstruction drift back into the authoritative Blob.
//
// Triple-gated like the mirror: no SUPABASE_DB_URL → Blob; flag off → Blob;
// getDb runs the env guard. Best-effort: ANY failure returns {pg:false} so the
// caller falls back to Blob (Blob remains source of truth).
//
// FAITHFULNESS GATE (see unfaithfulReason): a reconstructed entry that breaks the
// domain invariant every Blob entry satisfies at write time is NOT served — the
// whole call falls back to Blob. This is what makes the flag safe to leave on:
// a partial mirror degrades to Blob instead of feeding the client a shape it
// rejects. It does NOT make PG authoritative — see the completeness gap below.
//
// KNOWN GAP — this read has only a PARTIAL completeness gate. A worker with no
// user_profiles row falls back to Blob (the 2026-08-09 guard below — before it,
// every crew-link signup was served a confidently EMPTY week). But for a MAPPED
// worker, an entry MISSING from PG (mirror timeout, a write while the
// dual-write flag was off) is still indistinguishable from a day never logged.
// The faithfulness gate catches CORRUPT rows, not ABSENT ones. Closing that
// needs a real parity check against Blob (count/rev per window) — until then,
// treat this read as a perf overlay whose safety rests on the dual-write
// actually having run.
//
// FLIP PREREQUISITES (do NOT enable supabase_read_hours in an env until ALL hold):
//   1. parity IN SYNC for that env (scripts/importers/hours-parity.js) — note it
//      compares time_entries TOTALS, not allocations, so spot-check allocations.
//   2. Allocations are mirrored: the live dual-write (api/_lib/hours-mirror)
//      writes time_entry_allocations alongside the time_entry — but ONLY when
//      every allocation's job resolves to a jobs row in PG. A job that was never
//      mirrored (created before supabase_dual_write_jobs, or never re-saved
//      since) makes the mirror quarantine the allocations and upsert the entry
//      WITHOUT them. NOT closed by the mirror alone: verify every job a worker
//      logs against exists in public.jobs for that env.
//   3. updatedAt here reflects the last PG sync, not the Blob's last edit
//      (trigger-managed; best-effort metadata).
//
// Reconstructs the exact Blob entry shape, reversing the uuid→legacy mappings
// (user / approver / enterer via user_profiles; allocation jobId via jobs).
// NOT reconstructed: __rev/__updatedAt (Blob storage metadata — display reads
// don't use them; the write path reads __rev fresh from Blob via readEntry).

const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
// Same tolerance api/_lib/alloc-pg applies when BUILDING allocation rows, so the
// read can never reject a sum the writer would have accepted.
const { TOLERANCE } = require('./hours-pg');

function tsIso(v) {
  return v ? new Date(v).toISOString() : null;
}

/**
 * Why a reconstructed entry must NOT be served, or '' when it is faithful. Pure.
 *
 * Every Blob entry satisfies this invariant at write time (validateEntryShape in
 * api/_lib/time-entries.js: at least one allocation, each > 0, summing to
 * totalHours), so a PG entry that breaks it is not a faithful reconstruction —
 * it is a PARTIAL MIRROR. api/_lib/hours-mirror produces exactly that shape when
 * an allocation's job is absent from public.jobs: alloc-pg quarantines the
 * allocations and the mirror still upserts the parent time_entry, leaving a row
 * whose per-job split is gone. Serving it is worse than falling back — the Phil
 * client rejects an entry with no allocations (TimeEntrySchema: allocations
 * .min(1)) and discards the WHOLE list, so one unmirrored job blanks a worker's
 * entire week while Blob holds the hours all along.
 *
 * Deliberately NOT imported from time-entries.js: that module requires THIS one
 * (it is the read seam), so importing back would be a require cycle. Kept narrow
 * on purpose — it checks only what a partial mirror can actually corrupt.
 */
function unfaithfulReason(e) {
  const allocations = Array.isArray(e.allocations) ? e.allocations : [];
  if (allocations.length === 0) return 'no allocations';
  const sum = allocations.reduce((s, a) => s + (Number(a.hours) || 0), 0);
  const total = Number(e.totalHours);
  if (Math.abs(sum - total) >= TOLERANCE) {
    return `allocations sum ${Math.round(sum * 100) / 100} != totalHours ${total}`;
  }
  return '';
}

/**
 * Reconstruct a Blob-shaped time-entry from a joined Postgres row. Pure.
 */
function blobEntryFromPgRow(r) {
  const e = {
    id: r.legacy_id,
    userId: r.user_legacy_id,
    userName: r.user_name,
    userRole: r.user_role,
    date: r.work_date,
    startTime: r.start_time,
    endTime: r.end_time,
    breakMinutes: r.break_minutes,
    totalHours: Number(r.total_hours),
    ordinaryHours: Number(r.ordinary_hours),
    overtimeHours: Number(r.overtime_hours),
    otOverridden: r.ot_overridden,
    notes: r.notes,
    status: r.status,
    submittedAt: tsIso(r.submitted_at),
    approvedBy: r.approved_by_legacy,
    approvedAt: tsIso(r.approved_at),
    rejectedReason: r.rejected_reason,
    // allocations arrive as parsed JSON (json_agg); normalise hours to a number.
    allocations: (r.allocations || []).map((a) => ({
      jobId: a.jobId ?? null,
      hours: Number(a.hours),
      notes: a.notes ?? null,
      sortOrder: a.sortOrder,
    })),
    createdAt: tsIso(r.created_at),
    // PG updated_at is the last PG touch (import/mirror), not necessarily the
    // Blob's last edit — close, but treated as best-effort metadata.
    updatedAt: tsIso(r.updated_at),
    enteredByUserId: r.created_by_legacy,
    enteredByName: r.created_by_name,
    source: r.source,
  };
  // The Blob only carries rejectedAt/rejectedBy on a rejected entry (the reject
  // action sets them; revert deletes them). Match that conditional presence so a
  // never-rejected entry reconstructs WITHOUT those keys (exact-shape parity).
  if (r.rejected_at) {
    e.rejectedAt = tsIso(r.rejected_at);
    e.rejectedBy = r.rejected_by_legacy;
  }
  return e;
}

async function queryUserEntries(sql, tenantId, userId, { fromDate, toDate, status } = {}) {
  const f = fromDate || null;
  const t = toDate || null;
  const s = status || null;
  const rows = await sql`
    select
      te.legacy_id, to_char(te.work_date, 'YYYY-MM-DD') as work_date,
      to_char(te.start_time, 'HH24:MI') as start_time,
      to_char(te.end_time, 'HH24:MI') as end_time,
      te.break_minutes,
      te.total_hours, te.ordinary_hours, te.overtime_hours, te.ot_overridden,
      te.notes, te.status, te.submitted_at, te.approved_at,
      te.rejected_at, te.rejected_reason,
      te.source, te.created_at, te.updated_at,
      uu.legacy_user_id as user_legacy_id, uu.username as user_name, uu.role as user_role,
      ap.legacy_user_id as approved_by_legacy,
      rb.legacy_user_id as rejected_by_legacy,
      cb.legacy_user_id as created_by_legacy, cb.username as created_by_name,
      coalesce((
        select json_agg(json_build_object(
          'jobId', j.legacy_id, 'hours', a.hours, 'notes', a.notes, 'sortOrder', a.sort_order
        ) order by a.sort_order)
        from public.time_entry_allocations a
        left join public.jobs j on j.tenant_id = a.tenant_id and j.id = a.job_id
        where a.tenant_id = te.tenant_id and a.time_entry_id = te.id
      ), '[]'::json) as allocations
    from public.time_entries te
    join public.user_profiles uu on uu.tenant_id = te.tenant_id and uu.id = te.user_id
    left join public.user_profiles ap on ap.tenant_id = te.tenant_id and ap.id = te.approved_by
    left join public.user_profiles rb on rb.tenant_id = te.tenant_id and rb.id = te.rejected_by
    left join public.user_profiles cb on cb.tenant_id = te.tenant_id and cb.id = te.created_by
    where te.tenant_id = ${tenantId} and te.deleted_at is null
      and (${userId}::text is null or uu.legacy_user_id = ${userId})
      and (${f}::date is null or te.work_date >= ${f}::date)
      and (${t}::date is null or te.work_date <= ${t}::date)
      and (${s}::text is null or te.status = ${s}::text)
    order by te.work_date desc
  `;
  return rows.map(blobEntryFromPgRow);
}

/**
 * Serve a user's hours entries from Postgres IF the read-cutover is enabled and
 * possible. Never throws. `deps` lets tests inject isFlagOn/getDb.
 * @returns {Promise<{pg:true, entries:Array}|{pg:false, reason?:string}>}
 *   pg:true  → entries are faithful for this call (trust PG, incl. empty)
 *   pg:false → caller should read from Blob
 */
async function listUserEntriesFromPgIfEnabled(userId, opts = {}, deps = {}) {
  const flagOn = deps.isFlagOn || isFlagOn;
  const db = deps.getDb || getDb;
  try {
    if (!process.env.SUPABASE_DB_URL) return { pg: false, reason: 'no supabase env' };
    if (!(await flagOn('supabase_read_hours'))) return { pg: false, reason: 'flag off' };
    const sql = db({ mode: 'read' });
    const tn = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tn.length) return { pg: false, reason: 'no tenant' };
    // COMPLETENESS GUARD (2026-08-09, prod incident): PG can only vouch for a
    // worker it KNOWS. user_profiles holds the June import; crew-link signups
    // were never imported, so their entries are never mirrored — and this rung
    // trusted the resulting empty list as "no entries", serving every such
    // worker a blank week while Blob held the days (the third recurrence of
    // the vanishing-day bug; #971/#983 patched freshness, not this). A worker
    // with no live profile row falls back to Blob, the source of truth. An
    // empty result is trusted ONLY for a mapped worker.
    const mapped = await sql`
      select id from public.user_profiles
      where tenant_id = ${tn[0].id} and legacy_user_id = ${userId} and deleted_at is null
      limit 1
    `;
    if (!mapped.length) return { pg: false, reason: 'unmapped user' };
    const entries = await queryUserEntries(sql, tn[0].id, userId, opts);
    // ONE unfaithful entry fails the WHOLE call over to Blob rather than dropping
    // just that entry: Blob is the source of truth and holds every entry, so the
    // fallback always shows the worker more, never less. Filtering the bad entry
    // out instead would hide exactly the day they logged — the original bug.
    for (const e of entries) {
      const bad = unfaithfulReason(e);
      if (bad) {
        console.error(
          `[hours-read] unfaithful PG reconstruction for entry ${e.id} (${e.date}): ${bad} — serving Blob instead`
        );
        return { pg: false, reason: 'unfaithful reconstruction' };
      }
    }
    return { pg: true, entries };
  } catch (err) {
    console.error('[hours-read] PG read failed, falling back to Blob:', err && err.message);
    return { pg: false, reason: 'error' };
  }
}

// All non-deleted hours for the tenant, reconstructed to Blob shape via the
// SAME query/reconstruction the read-cutover serves — so the drift-check
// validates exactly what listUserEntries would return. Used by the sync-check.
async function loadAllHoursFromPg(sql, tenantId) {
  return queryUserEntries(sql, tenantId, null, {});
}

module.exports = { blobEntryFromPgRow, unfaithfulReason, listUserEntriesFromPgIfEnabled, loadAllHoursFromPg };
