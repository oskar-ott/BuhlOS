#!/usr/bin/env node
// Structure importer (FK-root slice): tenant → user_profiles → jobs.
//
//   node scripts/importers/structure-import.js            # dry-run (no writes)
//   node scripts/importers/structure-import.js --write    # apply to the target
//   node scripts/importers/structure-import.js --json
//
// The FIRST writer in the Supabase migration. It populates the dev project's
// FK roots so the hours importer (next) has user_profiles to reference and the
// hours parity check can converge. It is operator-run, NOT wired to any route/
// deploy/cron.
//
// Safety / honesty:
//   * Guarded: --write opens getDb({ mode: 'write' }); the env guard runs FIRST,
//     so a non-prod runtime can only reach the dev project, and a production
//     target additionally needs SUPABASE_ALLOW_PRODUCTION_WRITES="true". Dry-run
//     uses mode:'read'.
//   * Idempotent: upserts on the legacy unique keys (tenants.slug,
//     user_profiles(tenant_id,legacy_user_id), jobs(tenant_id,legacy_id)). The
//     DO UPDATE carries an IS DISTINCT FROM guard, so an unchanged re-run does
//     ZERO row writes (no revision/updated_at churn) — re-run = 0 inserted, 0
//     updated, all unchanged.
//   * Transactional: tenant + users + jobs commit in ONE transaction; any
//     failure rolls the whole import back.
//   * Quarantine, never guess: an unknown role/status or duplicate legacy id
//     quarantines the record and aborts before any write (exit 1).
//   * Deferred (own slices): areas/job_members; tasks (must bind to the
//     canonical task index); jobs.client_user_id/created_by/modules.
//
// Contract: docs/supabase-importer-plan.md · env: docs/supabase-environment.md

const {
  buildStructureRows,
  USER_MUTABLE_COLS,
  JOB_MUTABLE_COLS,
  USER_INSERT_COLS,
  JOB_INSERT_COLS,
} = require('./lib/structure-rows');
const { getDb, closeDb } = require('../../api/_lib/supabase-db');

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

async function loadSources() {
  const { readBlob } = require('../../api/_lib/blob');
  const users = await readBlob('users.json', null);
  const jobs = await readBlob('jobs.json', null);
  return { users, jobs };
}

// SET fragment "col = excluded.col, …" for an ON CONFLICT DO UPDATE.
function setExcluded(sql, cols) {
  return cols.map((c) => sql`${sql(c)} = excluded.${sql(c)}`).reduce((a, b) => sql`${a}, ${b}`);
}
// WHERE fragment "<table>.col IS DISTINCT FROM excluded.col OR …" — the update
// fires only when something changed. The target column MUST be table-qualified:
// unqualified it is ambiguous between the target row and EXCLUDED.
function distinctFromExcluded(sql, table, cols) {
  return cols
    .map((c) => sql`${sql(table)}.${sql(c)} is distinct from excluded.${sql(c)}`)
    .reduce((a, b) => sql`${a} or ${b}`);
}

function tally(returned, total) {
  const inserted = returned.filter((r) => r.inserted).length;
  const updated = returned.length - inserted;
  return { inserted, updated, unchanged: total - returned.length, total };
}

async function writeAll(sql, { tenantRow, userRows, jobRows }) {
  return sql.begin(async (sql) => {
    // Tenant: insert once, then read its id — fully idempotent (no re-touch).
    let rows = await sql`
      insert into public.tenants ${sql([tenantRow], 'slug', 'name')}
      on conflict (slug) do nothing
      returning id
    `;
    if (!rows.length) {
      rows = await sql`select id from public.tenants where slug = ${tenantRow.slug}`;
    }
    const tenantId = rows[0].id;

    const userRowsT = userRows.map((r) => ({ ...r, tenant_id: tenantId }));
    const jobRowsT = jobRows.map((r) => ({ ...r, tenant_id: tenantId }));

    const userRet = userRowsT.length
      ? await sql`
          insert into public.user_profiles ${sql(userRowsT, ...USER_INSERT_COLS)}
          on conflict (tenant_id, legacy_user_id) where legacy_user_id is not null
          do update set ${setExcluded(sql, USER_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'user_profiles', USER_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    const jobRet = jobRowsT.length
      ? await sql`
          insert into public.jobs ${sql(jobRowsT, ...JOB_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcluded(sql, JOB_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'jobs', JOB_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    // Count INSIDE the transaction — on a max:1 pool a separate post-commit
    // query would wait forever for the single connection the transaction just
    // released, so the report counts ride along here.
    const after = await currentCounts(sql);

    return {
      tenantId,
      users: tally(userRet, userRowsT.length),
      jobs: tally(jobRet, jobRowsT.length),
      after,
    };
  });
}

// One round-trip (a single connection — safe inside a transaction too).
async function currentCounts(sql) {
  const [c] = await sql`
    select (select count(*)::int from public.tenants)                                as tenants,
           (select count(*)::int from public.user_profiles where deleted_at is null) as user_profiles,
           (select count(*)::int from public.jobs where deleted_at is null)          as jobs
  `;
  return { tenants: c.tenants, user_profiles: c.user_profiles, jobs: c.jobs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/structure-import.js [--write] [--json]');
    return;
  }

  const sources = await loadSources();
  const nowIso = new Date().toISOString();
  const { tenantRow, userRows, jobRows, quarantine } = buildStructureRows(sources, { nowIso });

  // Quarantine aborts before any write — never import a partially-valid set.
  if (quarantine.length) {
    if (args.json) {
      console.log(JSON.stringify({ aborted: true, quarantine }, null, 2));
    } else {
      console.error(`\nABORTED — ${quarantine.length} quarantined record(s); fix before importing:`);
      for (const q of quarantine.slice(0, 50)) console.error(`  - ${q.table} ${q.id}: ${q.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  const proposed = { tenants: 1, user_profiles: userRows.length, jobs: jobRows.length };

  let report;
  try {
    if (args.write) {
      const sql = getDb({ mode: 'write' });
      const result = await writeAll(sql, { tenantRow, userRows, jobRows });
      report = { mode: 'write', proposed, result, after: result.after };
    } else {
      const sql = getDb({ mode: 'read' });
      const before = await currentCounts(sql);
      report = { mode: 'dry-run', proposed, current: before };
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.mode === 'write') {
    console.log('\nStructure import — APPLIED (one transaction)');
    console.log(`tenant: ${report.result.tenantId}`);
    for (const k of ['users', 'jobs']) {
      const t = report.result[k];
      console.log(`${k.padEnd(6)} ${t.inserted} inserted · ${t.updated} updated · ${t.unchanged} unchanged (of ${t.total})`);
    }
    console.log(`\nPostgres now holds: ${JSON.stringify(report.after)}`);
    console.log('re-run with --write to confirm idempotency (expect 0 inserted, 0 updated).');
  } else {
    console.log('\nStructure import — DRY RUN (nothing written)');
    console.log(`proposed: ${JSON.stringify(proposed)}`);
    console.log(`current in Postgres: ${JSON.stringify(report.current)}`);
    console.log('\nrun with --write to apply.');
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
