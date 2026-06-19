#!/usr/bin/env node
// Hours sync-check — the recorded Blob↔Postgres drift check (#152 trust layer).
//
//   node scripts/importers/hours-sync-check.js            # dry-run (print only)
//   node scripts/importers/hours-sync-check.js --write     # record into sync_checks
//   node scripts/importers/hours-sync-check.js --json
//
// Compares EVERY hours entry AND its per-job allocations across Blob and
// Postgres, producing PASS/FAIL with counts, totals, content hashes and the
// specific drifts. Manual runner now; a Vercel cron can call this path later.
// READ-ONLY against the data (Blob list/fetch + a PG read); --write only INSERTs
// an append-only audit row into public.sync_checks. Operator-run, no route/cron.
//
// The PG side is reconstructed by the SAME code the read-cutover serves
// (api/_lib/hours-read), so this validates exactly what listUserEntries returns.

const { buildHoursSyncReport, normaliseEntry } = require('./lib/hours-sync-report');
const { loadAllHoursFromPg } = require('../../api/_lib/hours-read');
const { getDb, closeDb } = require('../../api/_lib/supabase-db');

const FETCH_CONCURRENCY = 8;
const ENTRY_KEY_RE = /^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/;

function parseArgs(argv) {
  const args = { write: false, json: false, help: false };
  for (const a of argv) {
    if (a === '--write') args.write = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else { console.error(`unknown argument: ${a}`); args.help = true; }
  }
  return args;
}

async function loadBlob() {
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
        } catch { return null; }
      })
    );
    chunk.forEach((b, idx) => {
      const e = fetched[idx];
      if (e && typeof e === 'object') entries.push(normaliseEntry(b.userId, b.date, e));
    });
  }
  return entries;
}

async function recordCheck(sql, tenantId, report, durationMs) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/hours-sync-check.js [--write] [--json]');
    return;
  }

  const startedAt = Date.now();
  let report;
  try {
    const sql = getDb({ mode: args.write ? 'write' : 'read' });
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
    const tenantId = tenant[0].id;
    const [blobEntries, pgRaw] = [await loadBlob(), await loadAllHoursFromPg(sql, tenantId)];
    const pgEntries = pgRaw.map((e) => normaliseEntry(e.userId, e.date, e));
    report = buildHoursSyncReport({ blobEntries, pgEntries });
    const durationMs = Date.now() - startedAt;
    report.durationMs = durationMs;
    if (args.write) {
      await recordCheck(sql, tenantId, report, durationMs);
      report.recorded = true;
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nHours sync-check — ${report.status === 'pass' ? 'IN SYNC ✓' : 'DRIFT — FAIL'}`);
    console.log(`Blob:     ${report.blobCount} entries (${report.blobTotal}h)  hash ${String(report.blobHash).slice(0, 12)}…`);
    console.log(`Postgres: ${report.pgCount} entries (${report.pgTotal}h)  hash ${String(report.pgHash).slice(0, 12)}…`);
    console.log(`matched ${report.matched} · only-in-Blob ${report.onlyInBlobCount} · only-in-Postgres ${report.onlyInPgCount} · mismatched ${report.mismatchedCount} (allocations checked: ${report.allocationsChecked})`);
    if (report.status !== 'pass') console.log(`details: ${JSON.stringify(report.details)}`);
    console.log(`checked in ${report.durationMs}ms${report.recorded ? ' · recorded to sync_checks' : ' (dry-run — use --write to record)'}`);
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
