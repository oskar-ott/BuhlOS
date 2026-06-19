#!/usr/bin/env node
// Hours importer: public.time_entries from the Blob day-files.
//
//   node scripts/importers/hours-import.js            # dry-run (no writes)
//   node scripts/importers/hours-import.js --write     # apply to the target
//   node scripts/importers/hours-import.js --json
//
// The slice that flips the hours parity check (hours-parity.js) to IN SYNC.
// Reads users/<id>/time-entries/<date>.json from Blob and upserts time_entries,
// resolving each blob user id to its minted user_profiles uuid. Run AFTER
// structure-import.js (it needs user_profiles to reference). Operator-run, NOT
// wired to any route/deploy/cron.
//
// Safety / honesty (identical posture to structure-import.js):
//   * Guarded: --write opens getDb({mode:'write'}); the env guard runs FIRST,
//     so a non-prod runtime can only reach dev, and prod additionally needs
//     SUPABASE_ALLOW_PRODUCTION_WRITES="true". Dry-run uses mode:'read'.
//   * Idempotent: upsert on (tenant_id, user_id, work_date) WHERE deleted_at is
//     null, DO UPDATE guarded by IS DISTINCT FROM → unchanged re-run writes
//     nothing (no revision/updated_at churn). Caveat: time_entries_legacy_uq has
//     no deleted_at filter, so a re-import is NOT idempotent across a soft-delete
//     of the same row — that case fails closed with a clear error (see below).
//   * Transactional: all rows in ONE transaction; any failure rolls back.
//   * Quarantine, never guess: missing user ref / bad date / bad totals /
//     unknown status quarantine the record and abort before any write (exit 1).
//   * Deferred: allocations, payroll_runs, the approved_by/created_by attribution
//     columns (see lib/hours-rows.js header).
//
// Contract: docs/supabase-importer-plan.md · env: docs/supabase-environment.md

const {
  buildTimeEntryRows,
  TIME_ENTRY_MUTABLE_COLS,
  TIME_ENTRY_INSERT_COLS,
} = require('./lib/hours-rows');
const { getDb, closeDb } = require('../../api/_lib/supabase-db');

const FETCH_CONCURRENCY = 8;
const ENTRY_KEY_RE = /^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/;

function parseArgs(argv) {
  const args = { write: false, json: false, help: false };
  for (const a of argv) {
    if (a === '--write') args.write = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

// READ-ONLY Blob enumeration (list + fetch). The 'users/' prefix also returns
// time-entries-audit blobs; ENTRY_KEY_RE matches only the day-file shape.
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
        } catch {
          return null;
        }
      })
    );
    chunk.forEach((b, idx) => records.push({ userId: b.userId, date: b.date, entry: fetched[idx] }));
  }
  return records;
}

function setExcluded(sql, cols) {
  if (!cols.length) throw new Error('setExcluded: no mutable columns');
  return cols.map((c) => sql`${sql(c)} = excluded.${sql(c)}`).reduce((a, b) => sql`${a}, ${b}`);
}
// Target column MUST be table-qualified (unqualified is ambiguous vs EXCLUDED),
// and `table` MUST equal the table named in the enclosing INSERT.
function distinctFromExcluded(sql, table, cols) {
  if (!cols.length) throw new Error('distinctFromExcluded: no mutable columns');
  return cols
    .map((c) => sql`${sql(table)}.${sql(c)} is distinct from excluded.${sql(c)}`)
    .reduce((a, b) => sql`${a} or ${b}`);
}

// (xmax = 0) marks an insert; a DO UPDATE whose IS DISTINCT FROM is false
// returns no row → unchanged. Reliable for this single-tx single-writer import;
// do not lift into a concurrent route/cron path without revisiting.
function tally(returned, total) {
  const inserted = returned.filter((r) => r.inserted).length;
  return { inserted, updated: returned.length - inserted, unchanged: total - returned.length, total };
}

async function resolveTenantAndUsers(sql) {
  const t = await sql`select id from public.tenants where slug = 'buhl'`;
  if (!t.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
  const tenantId = t[0].id;
  const profs = await sql`
    select id, legacy_user_id from public.user_profiles
    where tenant_id = ${tenantId} and legacy_user_id is not null and deleted_at is null
  `;
  return { tenantId, userMap: new Map(profs.map((r) => [r.legacy_user_id, r.id])) };
}

async function writeEntries(sql, tenantId, rows) {
  try {
    return await sql.begin(async (sql) => {
      const rowsT = rows.map((r) => ({ ...r, tenant_id: tenantId }));
      const ret = rowsT.length
        ? await sql`
            insert into public.time_entries ${sql(rowsT, ...TIME_ENTRY_INSERT_COLS)}
            on conflict (tenant_id, user_id, work_date) where deleted_at is null
            do update set ${setExcluded(sql, TIME_ENTRY_MUTABLE_COLS)}
            where ${distinctFromExcluded(sql, 'time_entries', TIME_ENTRY_MUTABLE_COLS)}
            returning (xmax = 0) as inserted
          `
        : [];
      const [c] = await sql`select count(*)::int as n from public.time_entries where deleted_at is null`;
      return { time_entries: tally(ret, rowsT.length), after: c.n };
    });
  } catch (err) {
    // The (user,date) ON CONFLICT does not arbitrate the separate
    // time_entries_legacy_uq (which has no deleted_at filter). A legacy_id
    // collision the builder couldn't pre-dedup — most reachably a soft-deleted
    // row still holding its legacy_id on re-import — surfaces here. Re-throw
    // with context instead of a bare driver message; the whole tx rolled back,
    // so no rows were written.
    if (err && err.code === '23505') {
      const where = err.constraint_name ? ` (constraint ${err.constraint_name})` : '';
      throw new Error(
        `[hours-import] unique violation${where}${err.detail ? ': ' + err.detail : ''} — ` +
          'no rows written (transaction rolled back). A soft-deleted time_entries row may still hold ' +
          'this legacy_id (time_entries_legacy_uq has no deleted_at filter); hard-purge it before re-import.'
      );
    }
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/hours-import.js [--write] [--json]');
    return;
  }

  const records = await loadBlobEntries();
  const nowIso = new Date().toISOString();

  let report;
  try {
    const sql = getDb({ mode: args.write ? 'write' : 'read' });
    const { tenantId, userMap } = await resolveTenantAndUsers(sql);
    const { rows, quarantine } = buildTimeEntryRows({ records, userMap, nowIso });

    if (quarantine.length) {
      if (args.json) {
        console.log(JSON.stringify({ aborted: true, quarantine }, null, 2));
      } else {
        console.error(`\nABORTED — ${quarantine.length} quarantined entr(y/ies); fix before importing:`);
        for (const q of quarantine.slice(0, 50)) console.error(`  - ${q.ref}: ${q.reason}`);
      }
      process.exitCode = 1;
      return;
    }

    const proposed = rows.length;
    if (args.write) {
      const result = await writeEntries(sql, tenantId, rows);
      report = { mode: 'write', proposed, result };
    } else {
      const [c] = await sql`select count(*)::int as n from public.time_entries where deleted_at is null`;
      report = { mode: 'dry-run', proposed, current: c.n };
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.mode === 'write') {
    const t = report.result.time_entries;
    console.log('\nHours import — APPLIED (one transaction)');
    console.log(`time_entries  ${t.inserted} inserted · ${t.updated} updated · ${t.unchanged} unchanged (of ${t.total})`);
    console.log(`\nPostgres now holds ${report.result.after} live time_entries.`);
    console.log('re-run hours-parity.js to confirm IN SYNC; re-run --write to confirm idempotency.');
  } else {
    console.log('\nHours import — DRY RUN (nothing written)');
    console.log(`proposed time_entries: ${report.proposed}`);
    console.log(`current in Postgres:   ${report.current}`);
    console.log('\nrun with --write to apply.');
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
