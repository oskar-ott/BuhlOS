#!/usr/bin/env node
// Allocations importer: public.time_entry_allocations from the Blob day-files.
//
//   node scripts/importers/allocations-import.js            # dry-run (no writes)
//   node scripts/importers/allocations-import.js --write     # apply to the target
//   node scripts/importers/allocations-import.js --json
//
// Completes the hours read-side: the per-job hours breakdown for each
// time_entry. Run AFTER hours-import (allocations are children of time_entries
// and resolve their parent from (user, work_date)). Operator-run, dev-targeted,
// not wired to any route/cron.
//
// Safety / honesty:
//   * Guarded: --write opens getDb({mode:'write'}); env guard runs FIRST (prod
//     needs the explicit opt-in). Dry-run uses mode:'read'.
//   * Idempotent by RECONCILIATION (allocations have no per-row key): per parent
//     entry, replace its allocation set only when the proposed canonical differs
//     from what's stored — an unchanged re-run writes nothing.
//   * Transactional: the whole reconcile (delete changed + insert fresh) is ONE
//     transaction; any failure rolls back.
//   * Quarantine, never guess: a missing user/time_entry/job ref, hours <= 0,
//     allocation-sum != entry total, or over-length notes quarantines the entry
//     and aborts before any write (exit 1).
//
// Contract: docs/supabase-importer-plan.md · env: docs/supabase-environment.md

const { buildAllocationRows, reconcileAllocations } = require('./lib/allocation-rows');
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

// READ-ONLY Blob enumeration (list + fetch); ENTRY_KEY_RE excludes audit logs.
async function loadBlobEntries() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set — export it (read access)');
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

  const records = [];
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
    chunk.forEach((b, idx) => records.push({ userId: b.userId, date: b.date, entry: fetched[idx] }));
  }
  return records;
}

async function resolveMaps(sql) {
  const t = await sql`select id from public.tenants where slug = 'buhl'`;
  if (!t.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
  const tenantId = t[0].id;
  const [users, jobs, entries] = [
    await sql`select id, legacy_user_id from public.user_profiles where tenant_id = ${tenantId} and legacy_user_id is not null and deleted_at is null`,
    await sql`select id, legacy_id from public.jobs where tenant_id = ${tenantId} and legacy_id is not null and deleted_at is null`,
    await sql`select id, user_id, to_char(work_date, 'YYYY-MM-DD') as work_date from public.time_entries where tenant_id = ${tenantId} and deleted_at is null`,
  ];
  return {
    tenantId,
    userMap: new Map(users.map((r) => [r.legacy_user_id, r.id])),
    jobMap: new Map(jobs.map((r) => [r.legacy_id, r.id])),
    timeEntryMap: new Map(entries.map((r) => [`${r.user_id}|${r.work_date}`, r.id])),
  };
}

async function reconcile(sql, tenantId, byEntry) {
  return sql.begin(async (sql) => {
    const res = await reconcileAllocations(sql, tenantId, byEntry);
    const [c] = await sql`select count(*)::int as n from public.time_entry_allocations where tenant_id = ${tenantId}`;
    return { ...res, after: c.n };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/allocations-import.js [--write] [--json]');
    return;
  }

  const records = await loadBlobEntries();

  let report;
  try {
    const sql = getDb({ mode: args.write ? 'write' : 'read' });
    const { tenantId, userMap, jobMap, timeEntryMap } = await resolveMaps(sql);
    const { byEntry, quarantine } = buildAllocationRows({ records, userMap, jobMap, timeEntryMap });

    if (quarantine.length) {
      if (args.json) console.log(JSON.stringify({ aborted: true, quarantine }, null, 2));
      else {
        console.error(`\nABORTED — ${quarantine.length} quarantined entr(y/ies); fix before importing:`);
        for (const q of quarantine.slice(0, 50)) console.error(`  - ${q.ref}: ${q.reason}`);
      }
      process.exitCode = 1;
      return;
    }

    const proposedAllocations = byEntry.reduce((n, b) => n + b.rows.length, 0);
    if (args.write) {
      const result = await reconcile(sql, tenantId, byEntry);
      report = { mode: 'write', entries: byEntry.length, proposedAllocations, result };
    } else {
      const [c] = await sql`select count(*)::int as n from public.time_entry_allocations where tenant_id = ${tenantId}`;
      report = { mode: 'dry-run', entries: byEntry.length, proposedAllocations, current: c.n };
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.mode === 'write') {
    const r = report.result;
    console.log('\nAllocations import — APPLIED (one transaction)');
    console.log(`entries: ${r.entriesReplaced} replaced · ${r.entriesUnchanged} unchanged (of ${report.entries})`);
    console.log(`allocations inserted: ${r.allocationsInserted}`);
    console.log(`\nPostgres now holds ${r.after} time_entry_allocations.`);
    console.log('re-run --write to confirm idempotency (expect 0 replaced).');
  } else {
    console.log('\nAllocations import — DRY RUN (nothing written)');
    console.log(`proposed: ${report.proposedAllocations} allocations across ${report.entries} entries`);
    console.log(`current in Postgres: ${report.current}`);
    console.log('\nrun with --write to apply.');
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
