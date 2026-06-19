// Hours sync-check core (#152 trust layer) — the ONE implementation of the
// recorded Blob↔Postgres drift check, shared by the manual operator runner
// (scripts/importers/hours-sync-check.js) and the scheduled cron route
// (api/internal/sync-checks/hours.js).
//
// READ-ONLY against domain data: it lists + fetches the hours blobs and reads
// the mirrored rows, then (only when asked) INSERTs ONE append-only row into
// public.sync_checks. It never writes, repairs or deletes domain data — drift is
// reported, never silently "fixed".
//
// The PG side is reconstructed by the SAME code the read-cutover serves
// (api/_lib/hours-read.loadAllHoursFromPg), so the check validates exactly what
// listUserEntries would return. Connection lifecycle is the CALLER's: the CLI
// opens + closeDb()s; the serverless route reuses the warm singleton.

const { buildHoursSyncReport, normaliseEntry } = require('./hours-sync-report');
const { loadAllHoursFromPg } = require('./hours-read');

const FETCH_CONCURRENCY = 8;
const ENTRY_KEY_RE = /^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/;

// List + fetch every users/<id>/time-entries/<date>.json blob, normalised to the
// comparison shape (so the blob side matches how alloc-pg wrote the PG rows).
async function loadBlobHoursEntries() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  const { list } = require('@vercel/blob');
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
      if (e && typeof e === 'object') entries.push(normaliseEntry(b.userId, b.date, e));
    });
  }
  return entries;
}

// Append-only INSERT into public.sync_checks. The ONLY write this module makes.
async function recordSyncCheck(sql, tenantId, report, durationMs) {
  await sql`
    insert into public.sync_checks
      (tenant_id, domain, status, blob_count, pg_count, blob_total, pg_total,
       allocations_checked, matched, only_in_blob, only_in_pg, mismatched,
       blob_hash, pg_hash, details, duration_ms)
    values
      (${tenantId}, 'hours', ${report.status}, ${report.blobCount}, ${report.pgCount},
       ${report.blobTotal}, ${report.pgTotal}, ${report.allocationsChecked}, ${report.matched},
       ${report.onlyInBlobCount}, ${report.onlyInPgCount}, ${report.mismatchedCount},
       ${report.blobHash}, ${report.pgHash}, ${sql.json(report.details)}, ${durationMs})
  `;
}

/**
 * Resolve tenant, load both sides, build the report, optionally record it.
 * Pure orchestration over injectable I/O (`deps`) — connection lifecycle and the
 * env/flag gating are the CALLER's job. Returns the report (durationMs always
 * set; `recorded: true` when persisted).
 *
 * @param {any} sql  Postgres.js tagged-template client (already guarded/opened)
 * @param {{ record?: boolean, deps?: object }} [options]
 */
async function runHoursSyncCheck(sql, { record = false, deps = {} } = {}) {
  const {
    loadBlob = loadBlobHoursEntries,
    loadPg = loadAllHoursFromPg,
    buildReport = buildHoursSyncReport,
    normalise = normaliseEntry,
    recordCheck = recordSyncCheck,
    now = Date.now,
  } = deps;

  const startedAt = now();
  const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
  if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
  const tenantId = tenant[0].id;

  const [blobEntries, pgRaw] = await Promise.all([loadBlob(), loadPg(sql, tenantId)]);
  const pgEntries = pgRaw.map((e) => normalise(e.userId, e.date, e));
  const report = buildReport({ blobEntries, pgEntries });
  report.durationMs = now() - startedAt;
  if (record) {
    await recordCheck(sql, tenantId, report, report.durationMs);
    report.recorded = true;
  }
  return report;
}

module.exports = { loadBlobHoursEntries, recordSyncCheck, runHoursSyncCheck };
