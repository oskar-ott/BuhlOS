#!/usr/bin/env node
// Hours Blob↔Postgres parity check (the read-only hours proving slice) —
// READ-ONLY by construction.
//
//   node scripts/importers/hours-parity.js [--json]
//
// Reads the live hours source of truth from Vercel Blob
// (users/<id>/time-entries/<date>.json) AND the Postgres mirror
// (public.time_entries joined to user_profiles for the legacy user id), then
// reports the drift between them via the pure engine in lib/hours-drift.js.
//
// This is the read-only proving slice the migration roadmap puts before the
// hours dual-write (#152): against today's empty dev Postgres it honestly
// reports "Postgres is behind by everything"; after the importer lands it
// should report inSync. The same engine becomes the dual-write's drift alarm.
//
// Safety:
//   * NEVER writes anywhere. Postgres is opened with getDb({ mode: 'read' }),
//     which runs the Supabase env guard FIRST — a misconfigured/production
//     runtime fails closed and can never write. Blob uses only the read-only
//     `list` (enumeration) and `fetch`/`readBlob` (reads).
//   * Not wired to any API route, deploy hook or cron. Operator-run only.
//   * Connects to whatever SUPABASE_* env names — point it at DEV
//     (SUPABASE_ENV=development) and provide BLOB_READ_WRITE_TOKEN for reads.
//
// Contract: docs/supabase-environment.md · drift engine: lib/hours-drift.js

const { buildHoursDriftReport } = require('./lib/hours-drift');
const { getDb, closeDb } = require('../../api/_lib/supabase-db');

const FETCH_CONCURRENCY = 8;

// Authoritative user+date come from the blob KEY, not the entry body.
const ENTRY_KEY_RE = /^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/;

function parseArgs(argv) {
  const args = { json: false, help: false };
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

// ── live Blob loader — READ-ONLY (list + fetch + readBlob) ──────────────────
// Mirrors scripts/importers/hours-dry-run.js loadFromBlob; kept inline so the
// proven dry-run script is left untouched.
async function loadBlobHours() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not set — export it (read access) to read the Blob hours');
  }
  const { list } = require('@vercel/blob'); // read-only enumeration; no put/del

  // The 'users/' prefix also returns users/<id>/time-entries-audit/<yyyy-mm>.json;
  // ENTRY_KEY_RE matches only the day-file shape, so audit logs are excluded.
  const dayBlobs = [];
  let cursor;
  do {
    const res = await list({ prefix: 'users/', token, limit: 1000, cursor });
    for (const b of res.blobs || []) {
      const m = ENTRY_KEY_RE.exec(b.pathname);
      if (m) dayBlobs.push({ userId: m[1], date: m[2], url: b.url });
    }
    cursor = res.cursor;
  } while (cursor);

  const entries = [];
  let unreadable = 0;
  for (let i = 0; i < dayBlobs.length; i += FETCH_CONCURRENCY) {
    const chunk = dayBlobs.slice(i, i + FETCH_CONCURRENCY);
    const fetched = await Promise.all(
      chunk.map(async (b) => {
        try {
          const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
          if (!r.ok) return null;
          return await r.json();
        } catch {
          return null;
        }
      })
    );
    chunk.forEach((b, idx) => {
      const e = fetched[idx];
      if (!e || typeof e !== 'object') {
        unreadable += 1;
        return;
      }
      entries.push({
        userKey: b.userId,
        date: b.date, // blob path date is authoritative
        totalHours: Number(e.totalHours) || 0,
        ordinaryHours: Number(e.ordinaryHours) || 0,
        overtimeHours: Number(e.overtimeHours) || 0,
        status: e.status || 'draft',
        entryLegacyId: e.id || null,
      });
    });
  }
  return { entries, unreadable };
}

// ── Postgres mirror loader — READ-ONLY (getDb mode:'read') ──────────────────
async function loadPgHours() {
  const sql = getDb({ mode: 'read' });
  // Single-tenant today (the structure importer mints exactly one tenant and
  // Blob is inherently single-tenant), so no tenant_id predicate is needed; add
  // one here if the project ever holds >1 tenant, else this would compare all
  // tenants' Postgres rows against one tenant's Blob. A row whose
  // legacy_user_id is NULL arrives with user_legacy_id=null and the drift
  // engine routes it to its "unresolved" bucket — never counted as drift.
  // Resolve the minted uuid user_id back to the legacy user id
  // (user_profiles.legacy_user_id = the users.json id) so the business key
  // (userKey,date) lines up with the Blob side. to_char keeps work_date a
  // 'YYYY-MM-DD' string; numeric(4,2) columns arrive as strings → Number().
  const rows = await sql`
    select up.legacy_user_id                    as user_legacy_id,
           te.legacy_id                         as entry_legacy_id,
           to_char(te.work_date, 'YYYY-MM-DD')  as work_date,
           te.total_hours                       as total_hours,
           te.ordinary_hours                    as ordinary_hours,
           te.overtime_hours                    as overtime_hours,
           te.status                            as status
    from public.time_entries te
    join public.user_profiles up
      on up.tenant_id = te.tenant_id and up.id = te.user_id
    where te.deleted_at is null
  `;
  return rows.map((r) => ({
    userKey: r.user_legacy_id,
    date: r.work_date,
    totalHours: Number(r.total_hours) || 0,
    ordinaryHours: Number(r.ordinary_hours) || 0,
    overtimeHours: Number(r.overtime_hours) || 0,
    status: r.status,
    entryLegacyId: r.entry_legacy_id,
  }));
}

function printSection(title, rows, cap = 25) {
  if (!rows || !rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows.slice(0, cap)) {
    console.log(`  - ${typeof row === 'string' ? row : JSON.stringify(row)}`);
  }
  if (rows.length > cap) console.log(`  … and ${rows.length - cap} more`);
}

function printReport(report, meta) {
  const s = report.summary;
  console.log('\nHours Blob↔Postgres parity (read-only — nothing was written)');
  console.log('(compares daily time_entries totals/status only — per-job allocations are not yet mirrored)');
  console.log(`Blob entries:     ${s.blobCount}  (total ${s.blobTotalHours}h)`);
  console.log(`Postgres entries: ${s.pgCount}  (total ${s.pgTotalHours}h)`);
  if (meta && meta.unreadable) console.log(`Unreadable Blob entries skipped: ${meta.unreadable}`);
  console.log(
    `matched ${s.matchedCount} · only-in-Blob ${s.onlyInBlobCount} · only-in-Postgres ${s.onlyInPgCount} · mismatched ${s.mismatchedCount}`
  );
  // inSync means no per-entry / missing / unresolved drift. A nonzero aggregate
  // alongside inSync can only be sub-tolerance rounding summed across matched
  // entries (it never happens with real 2dp data) — say so rather than print a
  // bare contradiction.
  const driftNote =
    s.inSync && s.driftHours !== 0 ? ' — sub-tolerance rounding only, no per-entry drift' : '';
  console.log(`drift: ${s.driftHours}h (positive = Postgres behind)${driftNote}`);
  if (s.duplicateBlobKeys || s.duplicatePgKeys) {
    console.log(`duplicate keys: Blob ${s.duplicateBlobKeys}, Postgres ${s.duplicatePgKeys}`);
  }
  if (s.unresolvedBlobCount || s.unresolvedPgCount) {
    console.log(
      `unresolved (no legacy user id — not drift): Blob ${s.unresolvedBlobCount}, Postgres ${s.unresolvedPgCount}`
    );
  }

  printSection('Only in Blob (Postgres missing these)', report.onlyInBlob);
  printSection('Only in Postgres (no Blob source)', report.onlyInPg);
  printSection('Mismatched (values disagree)', report.mismatched);
  printSection('Duplicate Blob keys', report.duplicateBlobKeys);
  printSection('Duplicate Postgres keys', report.duplicatePgKeys);
  printSection('Unresolved Postgres rows (NULL legacy_user_id — cannot match)', report.unresolvedPg);
  printSection('Unresolved Blob rows (missing user/date)', report.unresolvedBlob);

  console.log(`\nresult: ${s.inSync ? 'IN SYNC' : 'DRIFT DETECTED'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/hours-parity.js [--json]');
    return;
  }

  let pgEntries;
  let blob;
  try {
    // PG first: opening the client runs the env guard, so an unsafe target
    // fails loudly BEFORE we spend time enumerating Blob.
    pgEntries = await loadPgHours();
    blob = await loadBlobHours();
  } finally {
    await closeDb();
  }

  const report = buildHoursDriftReport({ blobEntries: blob.entries, pgEntries });

  if (args.json) {
    console.log(JSON.stringify({ ...report, meta: { unreadable: blob.unreadable } }, null, 2));
  } else {
    printReport(report, { unreadable: blob.unreadable });
  }
  // Read-only diagnostic: exit 0 always (drift is the expected finding today),
  // the report says IN SYNC / DRIFT DETECTED. Reserve non-zero for failures.
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
