#!/usr/bin/env node
// Structure importer: tenant → user_profiles → jobs → site_area_groups →
//                      site_areas → job_task_templates.
//
//   node scripts/importers/structure-import.js            # dry-run (no writes)
//   node scripts/importers/structure-import.js --write    # apply to the target
//   node scripts/importers/structure-import.js --json
//
// FK-root slice (PR #585) populated tenant/users/jobs; J1 added the place facets
// site_area_groups + site_areas; J2 adds job_task_templates (the task PLAN — the
// job-level default + per-area override lists as raw DEFINITIONS). Operator-run,
// NOT wired to any route/deploy/cron. Does NOT import concrete `tasks` or
// task_status_events (J3 — task-INSTANCE identity must bind to the canonical task
// index, never minted blind here).
//
// Safety / honesty:
//   * Guarded: --write opens getDb({ mode: 'write' }); the env guard runs FIRST,
//     so a non-prod runtime can only reach the dev project, and a production
//     target additionally needs SUPABASE_ALLOW_PRODUCTION_WRITES="true". Dry-run
//     uses mode:'read'.
//   * Idempotent: upserts on the legacy unique keys (tenants.slug,
//     user_profiles(tenant_id,legacy_user_id), jobs(tenant_id,legacy_id),
//     site_area_groups/site_areas(tenant_id,legacy_id), and the two PARTIAL
//     job_task_templates indexes — job-level (tenant,job,stage,legacy_id) and
//     area-override (tenant,site_area_id,stage,legacy_id)). The DO UPDATE carries
//     an IS DISTINCT FROM guard, so an unchanged re-run does ZERO row writes. For
//     groups/areas/templates the archive dimension is compared on deleted_at
//     NULL-ness (not the proxy timestamp) and the CASE preserves an existing
//     deleted_at, so an already-archived row never churns — re-run = 0/0.
//   * Template legacy_id is the BARE blob taskId (the partial indexes scope it by
//     job/area+stage); required_photo_count/requires_note/is_active/description are
//     PG-owned (no blob source) — never written, so admin-authored evidence
//     requirements survive a re-import.
//   * Reuses the existing 'buhl' tenant + the 9 imported jobs (matched on
//     legacy_id) — never duplicates them. Group/area/template FKs resolve
//     job_id / group_id / site_area_id by legacy_id INSIDE the transaction.
//   * Transactional: tenant + users + jobs + groups + areas + templates commit in
//     ONE transaction; any failure rolls the whole import back.
//   * Quarantine, never guess: an unknown role/status, duplicate legacy id, a
//     group/area composite-legacy-id collision, or a duplicate template within a
//     (job|area, stage) quarantines and aborts before any write (exit 1).
//   * Deferred (own slices): job_members; concrete tasks/task_status_events (J3);
//     jobs.client_user_id/created_by/modules.
//
// Contract: docs/supabase-importer-plan.md · audit: docs/audits/jobs-tasks-supabase-j0-audit.md

const {
  buildStructureRows,
  USER_MUTABLE_COLS,
  JOB_MUTABLE_COLS,
  USER_INSERT_COLS,
  JOB_INSERT_COLS,
  GROUP_MUTABLE_COLS,
  AREA_MUTABLE_COLS,
  GROUP_INSERT_COLS,
  AREA_INSERT_COLS,
  TEMPLATE_MUTABLE_COLS,
  TEMPLATE_INSERT_COLS,
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
  if (!cols.length) throw new Error('setExcluded: no mutable columns');
  return cols.map((c) => sql`${sql(c)} = excluded.${sql(c)}`).reduce((a, b) => sql`${a}, ${b}`);
}
// WHERE fragment "<table>.col IS DISTINCT FROM excluded.col OR …" — the update
// fires only when something changed. The target column MUST be table-qualified
// (unqualified it is ambiguous between the target row and EXCLUDED), and
// `table` MUST equal the table named in the enclosing `insert into public.<table>`.
function distinctFromExcluded(sql, table, cols) {
  if (!cols.length) throw new Error('distinctFromExcluded: no mutable columns');
  return cols
    .map((c) => sql`${sql(table)}.${sql(c)} is distinct from excluded.${sql(c)}`)
    .reduce((a, b) => sql`${a} or ${b}`);
}

// Archive-aware variants for site_area_groups / site_areas. The plain columns
// behave like setExcluded/distinctFromExcluded, but deleted_at is handled so a
// re-run NEVER churns an already-archived row:
//   * SET deleted_at: unarchive → NULL; newly-archived (was NULL) → stamp the
//     proxy timestamp; still-archived → KEEP the existing timestamp.
//   * WHERE: compare the archive STATE (deleted_at NULL-ness), not the volatile
//     proxy timestamp, so a stable archived row is "unchanged".
function setExcludedArchiveAware(sql, table, plainCols) {
  const plain = setExcluded(sql, plainCols);
  const del = sql`deleted_at = case
      when excluded.deleted_at is null then null
      when ${sql(table)}.deleted_at is null then excluded.deleted_at
      else ${sql(table)}.deleted_at end`;
  return sql`${plain}, ${del}`;
}
function distinctArchiveAware(sql, table, plainCols) {
  const plain = distinctFromExcluded(sql, table, plainCols);
  return sql`${plain} or (${sql(table)}.deleted_at is null) is distinct from (excluded.deleted_at is null)`;
}

// inserted/updated/unchanged from the RETURNING rows. (xmax = 0) marks an
// insert; a DO UPDATE whose IS DISTINCT FROM is false returns no row → it falls
// into `unchanged`. The xmax heuristic is reliable for THIS single-transaction,
// single-writer operator import — do not lift it into a concurrent route/cron
// path without revisiting.
function tally(returned, total) {
  const inserted = returned.filter((r) => r.inserted).length;
  const updated = returned.length - inserted;
  return { inserted, updated, unchanged: total - returned.length, total };
}

// Build a legacy_id → uuid map from a table, INSIDE the transaction. Needed
// because the IS-DISTINCT-FROM upserts only RETURN changed rows, so we cannot
// rely on RETURNING to learn the uuids of unchanged (idempotent) parents.
async function legacyIdMap(sql, table, tenantId) {
  const rows = await sql`select id, legacy_id from ${sql(table)} where tenant_id = ${tenantId} and legacy_id is not null`;
  return new Map(rows.map((r) => [r.legacy_id, r.id]));
}

async function writeAll(sql, { tenantRow, userRows, jobRows, groupRows, areaRows, templateRows }) {
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

    // Resolve job uuids (reuses the existing 'buhl' jobs, matched on legacy_id).
    const jobMap = await legacyIdMap(sql, 'jobs', tenantId);
    const groupRowsT = (groupRows || []).map((r) => {
      const job_id = jobMap.get(r.job_legacy_id);
      if (!job_id) throw new Error(`group ${r.legacy_id}: job legacy_id ${r.job_legacy_id} not found in Postgres`);
      return {
        tenant_id: tenantId, job_id, legacy_id: r.legacy_id, name: r.name,
        sort_order: r.sort_order, deleted_at: r.deleted_at, deleted_by: r.deleted_by, created_at: r.created_at,
      };
    });

    const groupRet = groupRowsT.length
      ? await sql`
          insert into public.site_area_groups ${sql(groupRowsT, ...GROUP_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcludedArchiveAware(sql, 'site_area_groups', GROUP_MUTABLE_COLS)}
          where ${distinctArchiveAware(sql, 'site_area_groups', GROUP_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    // Resolve group uuids (after the group upsert) for the area FK.
    const groupMap = await legacyIdMap(sql, 'site_area_groups', tenantId);
    const areaRowsT = (areaRows || []).map((r) => {
      const job_id = jobMap.get(r.job_legacy_id);
      if (!job_id) throw new Error(`area ${r.legacy_id}: job legacy_id ${r.job_legacy_id} not found in Postgres`);
      let group_id = null;
      if (r.group_legacy_id) {
        group_id = groupMap.get(r.group_legacy_id);
        if (!group_id) throw new Error(`area ${r.legacy_id}: group legacy_id ${r.group_legacy_id} not found in Postgres`);
      }
      return {
        tenant_id: tenantId, job_id, group_id, legacy_id: r.legacy_id, name: r.name,
        space_type: r.space_type, sort_order: r.sort_order, deleted_at: r.deleted_at,
        deleted_by: r.deleted_by, created_at: r.created_at,
      };
    });

    const areaRet = areaRowsT.length
      ? await sql`
          insert into public.site_areas ${sql(areaRowsT, ...AREA_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcludedArchiveAware(sql, 'site_areas', AREA_MUTABLE_COLS)}
          where ${distinctArchiveAware(sql, 'site_areas', AREA_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    // ── J2: job_task_templates ──────────────────────────────────────────────
    // Resolve area uuids (after the area upsert) for per-area override templates.
    // Split by level: job-level (site_area_id NULL) and area-level rows target
    // DIFFERENT partial unique indexes, so they need separate ON CONFLICT upserts.
    const areaMap = await legacyIdMap(sql, 'site_areas', tenantId);
    const tplJobLevel = [];
    const tplAreaLevel = [];
    for (const r of templateRows || []) {
      const job_id = jobMap.get(r.job_legacy_id);
      if (!job_id) throw new Error(`template ${r.legacy_id}: job legacy_id ${r.job_legacy_id} not found in Postgres`);
      let site_area_id = null;
      if (r.site_area_legacy_id) {
        site_area_id = areaMap.get(r.site_area_legacy_id);
        if (!site_area_id) throw new Error(`template ${r.legacy_id}: site_area legacy_id ${r.site_area_legacy_id} not found in Postgres`);
      }
      const row = {
        tenant_id: tenantId, job_id, site_area_id, stage: r.stage, legacy_id: r.legacy_id,
        name: r.name, sort_order: r.sort_order, deleted_at: r.deleted_at, deleted_by: r.deleted_by, created_at: r.created_at,
      };
      (site_area_id === null ? tplJobLevel : tplAreaLevel).push(row);
    }

    const tplJobRet = tplJobLevel.length
      ? await sql`
          insert into public.job_task_templates ${sql(tplJobLevel, ...TEMPLATE_INSERT_COLS)}
          on conflict (tenant_id, job_id, stage, legacy_id) where site_area_id is null and legacy_id is not null
          do update set ${setExcludedArchiveAware(sql, 'job_task_templates', TEMPLATE_MUTABLE_COLS)}
          where ${distinctArchiveAware(sql, 'job_task_templates', TEMPLATE_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    const tplAreaRet = tplAreaLevel.length
      ? await sql`
          insert into public.job_task_templates ${sql(tplAreaLevel, ...TEMPLATE_INSERT_COLS)}
          on conflict (tenant_id, site_area_id, stage, legacy_id) where site_area_id is not null and legacy_id is not null
          do update set ${setExcludedArchiveAware(sql, 'job_task_templates', TEMPLATE_MUTABLE_COLS)}
          where ${distinctArchiveAware(sql, 'job_task_templates', TEMPLATE_MUTABLE_COLS)}
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
      site_area_groups: tally(groupRet, groupRowsT.length),
      site_areas: tally(areaRet, areaRowsT.length),
      job_task_templates: tally([...tplJobRet, ...tplAreaRet], tplJobLevel.length + tplAreaLevel.length),
      after,
    };
  });
}

// One round-trip (a single connection — safe inside a transaction too).
async function currentCounts(sql) {
  const [c] = await sql`
    select (select count(*)::int from public.tenants)                                    as tenants,
           (select count(*)::int from public.user_profiles where deleted_at is null)     as user_profiles,
           (select count(*)::int from public.jobs where deleted_at is null)              as jobs,
           (select count(*)::int from public.site_area_groups where deleted_at is null)  as site_area_groups,
           (select count(*)::int from public.site_areas where deleted_at is null)        as site_areas,
           (select count(*)::int from public.job_task_templates where deleted_at is null) as job_task_templates,
           (select count(*)::int from public.tasks)                                      as tasks
  `;
  return {
    tenants: c.tenants, user_profiles: c.user_profiles, jobs: c.jobs,
    site_area_groups: c.site_area_groups, site_areas: c.site_areas,
    job_task_templates: c.job_task_templates, tasks: c.tasks,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/structure-import.js [--write] [--json]');
    return;
  }

  const sources = await loadSources();
  const nowIso = new Date().toISOString();
  const { tenantRow, userRows, jobRows, groupRows, areaRows, templateRows, quarantine } = buildStructureRows(sources, { nowIso });

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

  const proposed = {
    tenants: 1, user_profiles: userRows.length, jobs: jobRows.length,
    site_area_groups: groupRows.length, site_areas: areaRows.length,
    job_task_templates: templateRows.length,
  };

  let report;
  try {
    if (args.write) {
      const sql = getDb({ mode: 'write' });
      const result = await writeAll(sql, { tenantRow, userRows, jobRows, groupRows, areaRows, templateRows });
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
    for (const k of ['users', 'jobs', 'site_area_groups', 'site_areas', 'job_task_templates']) {
      const t = report.result[k];
      console.log(`${k.padEnd(17)} ${t.inserted} inserted · ${t.updated} updated · ${t.unchanged} unchanged (of ${t.total})`);
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
