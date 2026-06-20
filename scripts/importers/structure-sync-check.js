#!/usr/bin/env node
// Structure sync-check — the recorded Blob↔Postgres drift check for the place
// structure (jobs + site_area_groups + site_areas). The J1 trust layer, modelled
// on scripts/importers/hours-sync-check.js (#152).
//
//   node scripts/importers/structure-sync-check.js            # dry-run (print only)
//   node scripts/importers/structure-sync-check.js --write     # record into sync_checks
//   node scripts/importers/structure-sync-check.js --json
//
// READ-ONLY against the data (Blob read + a PG read); --write only INSERTs ONE
// append-only row into public.sync_checks (domain 'structure'). NO auto-repair,
// no mutation of jobs/groups/areas. Operator-run, not wired to any route/cron
// (the scheduled cron is J6).
//
// The Blob side is projected via buildStructureRows — the SAME builder the
// importer writes from — so a clean import is IN SYNC by construction. The PG
// side is read with matching field shapes; only the archive STATE (deleted bool)
// is compared, never the proxy deleted_at timestamp.

const { buildStructureRows } = require('./lib/structure-rows');
const { buildStructureSyncReport } = require('../../api/_lib/structure-sync-report');
const { getDb, closeDb } = require('../../api/_lib/supabase-db');

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

const STRUCTURE_TABLES = new Set(['jobs', 'site_area_groups', 'site_areas']);

// Blob projection — derived from the importer's own row builder so the check can
// never drift from what the importer writes. Entities carry only stable fields
// (no uuid/revision/timestamps); the archive dimension is a `deleted` boolean.
function projectBlob(sources, nowIso) {
  const built = buildStructureRows(sources, { nowIso });
  const jobs = built.jobRows.map((r) => ({
    key: r.legacy_id, name: r.name, status: r.status, ref: r.ref,
    job_type_label: r.job_type_label, external_ref: r.external_ref,
    site_address: r.site_address, induction_required: r.induction_required,
    start_date: r.start_date, due_date: r.due_date,
    programmed_duration_days: r.programmed_duration_days, deleted: false,
  }));
  const groups = built.groupRows.map((r) => ({
    key: r.legacy_id, job_legacy_id: r.job_legacy_id, name: r.name,
    sort_order: r.sort_order, deleted: r.deleted_at !== null,
  }));
  const areas = built.areaRows.map((r) => ({
    key: r.legacy_id, job_legacy_id: r.job_legacy_id, group_legacy_id: r.group_legacy_id,
    name: r.name, space_type: r.space_type, sort_order: r.sort_order, deleted: r.deleted_at !== null,
  }));
  // Anything the importer would quarantine (and abort on) is, for the check, a
  // blob entity that cannot be mapped to a comparable PG key.
  const unmappable = built.quarantine
    .filter((q) => STRUCTURE_TABLES.has(q.table))
    .map((q) => `${q.table}:${q.id} (${q.reason})`);
  return { jobs, groups, areas, unmappable };
}

async function readPg(sql, tenantId) {
  const jobs = await sql`
    select legacy_id as key, name, status, ref, job_type_label, external_ref,
           site_address, induction_required,
           start_date::text as start_date, due_date::text as due_date,
           programmed_duration_days, (deleted_at is not null) as deleted
    from public.jobs
    where tenant_id = ${tenantId} and legacy_id is not null
  `;
  const groups = await sql`
    select g.legacy_id as key, jb.legacy_id as job_legacy_id, g.name, g.sort_order,
           (g.deleted_at is not null) as deleted
    from public.site_area_groups g
    left join public.jobs jb on jb.id = g.job_id
    where g.tenant_id = ${tenantId} and g.legacy_id is not null
  `;
  const areas = await sql`
    select a.legacy_id as key, jb.legacy_id as job_legacy_id, gp.legacy_id as group_legacy_id,
           a.name, a.space_type, a.sort_order, (a.deleted_at is not null) as deleted
    from public.site_areas a
    left join public.jobs jb on jb.id = a.job_id
    left join public.site_area_groups gp on gp.id = a.group_id
    where a.tenant_id = ${tenantId} and a.legacy_id is not null
  `;
  // postgres.js returns query results as array-likes; normalise to plain arrays.
  return { jobs: [...jobs], groups: [...groups], areas: [...areas] };
}

async function recordCheck(sql, tenantId, report, durationMs) {
  await sql`
    insert into public.sync_checks
      (tenant_id, domain, status, blob_count, pg_count, blob_total, pg_total,
       allocations_checked, matched, only_in_blob, only_in_pg, mismatched,
       blob_hash, pg_hash, details, duration_ms)
    values
      (${tenantId}, 'structure', ${report.status}, ${report.blobCount}, ${report.pgCount},
       ${report.blobDeleted}, ${report.pgDeleted}, true, ${report.matched},
       ${report.onlyInBlobCount}, ${report.onlyInPgCount}, ${report.mismatchedCount},
       ${report.blobHash}, ${report.pgHash}, ${sql.json(report.details)}, ${durationMs})
  `;
}

async function loadBlob() {
  const { readBlob } = require('../../api/_lib/blob');
  const jobs = await readBlob('jobs.json', null);
  return { jobs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/structure-sync-check.js [--write] [--json]');
    return;
  }

  const startedAt = Date.now();
  let report;
  try {
    const sql = getDb({ mode: args.write ? 'write' : 'read' });
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
    const tenantId = tenant[0].id;

    const sources = await loadBlob();
    const blob = projectBlob(sources, new Date().toISOString());
    const pg = await readPg(sql, tenantId);
    report = buildStructureSyncReport({ blob, pg });
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
    console.log(`\nStructure sync-check — ${report.status === 'pass' ? 'IN SYNC ✓' : 'DRIFT — FAIL'}`);
    console.log(`Blob:     ${report.blobCount} entities (${report.blobDeleted} archived)  hash ${String(report.blobHash).slice(0, 12)}…`);
    console.log(`Postgres: ${report.pgCount} entities (${report.pgDeleted} deleted)  hash ${String(report.pgHash).slice(0, 12)}…`);
    for (const [name, s] of Object.entries(report.details.sections)) {
      console.log(`  ${name.padEnd(7)} blob ${s.blobCount} · pg ${s.pgCount} · matched ${s.matched} · only-blob ${s.onlyInBlobCount} · only-pg ${s.onlyInPgCount} · mismatched ${s.mismatchedCount}`);
    }
    console.log(`unmappable ${report.unmappableCount} · hashMatch ${report.details.hashMatch}`);
    if (report.status !== 'pass') console.log(`details: ${JSON.stringify(report.details)}`);
    console.log(`checked in ${report.durationMs}ms${report.recorded ? ' · recorded to sync_checks' : ' (dry-run — use --write to record)'}`);
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
