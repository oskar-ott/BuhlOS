// Hours read-cutover (#152, rung 3) — serve the hours DISPLAY read from
// Postgres with a Blob fallback, behind the supabase_read_hours flag.
//
// Only listUserEntries (display) is cut over. readEntry stays on Blob because
// it feeds the read-modify-write path — serving a reconstructed entry there
// could write reconstruction drift back into the authoritative Blob.
//
// Triple-gated like the mirror: no SUPABASE_DB_URL → Blob; flag off → Blob;
// getDb runs the env guard. Best-effort: ANY failure returns {pg:false} so the
// caller falls back to Blob (Blob remains source of truth). When on, an empty
// PG result is trusted (returned as "no entries").
//
// FLIP PREREQUISITES (do NOT enable supabase_read_hours in an env until ALL hold):
//   1. parity IN SYNC for that env (scripts/importers/hours-parity.js) — note it
//      compares time_entries TOTALS, not allocations.
//   2. ALLOCATIONS ARE MIRRORED. The live dual-write (api/_lib/hours-mirror) writes
//      time_entries but NOT time_entry_allocations — only the operator importer
//      does. Until the mirror writes allocations, an entry created/edited after
//      the dual-write flag went on has NO allocations in PG, so this read would
//      show an empty per-job split. (Own follow-up slice.)
//   3. updatedAt here reflects the last PG sync, not the Blob's last edit
//      (trigger-managed; best-effort metadata).
//
// Reconstructs the exact Blob entry shape, reversing the uuid→legacy mappings
// (user / approver / enterer via user_profiles; allocation jobId via jobs).
// NOT reconstructed: __rev/__updatedAt (Blob storage metadata — display reads
// don't use them; the write path reads __rev fresh from Blob via readEntry).

const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');

function tsIso(v) {
  return v ? new Date(v).toISOString() : null;
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
    where te.tenant_id = ${tenantId} and uu.legacy_user_id = ${userId} and te.deleted_at is null
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
 *   pg:true  → entries are authoritative for this call (trust PG, incl. empty)
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
    const entries = await queryUserEntries(sql, tn[0].id, userId, opts);
    return { pg: true, entries };
  } catch (err) {
    console.error('[hours-read] PG read failed, falling back to Blob:', err && err.message);
    return { pg: false, reason: 'error' };
  }
}

module.exports = { blobEntryFromPgRow, listUserEntriesFromPgIfEnabled };
