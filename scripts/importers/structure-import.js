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

const { buildStructureRows } = require('./lib/structure-rows');
// The upsert writer is shared with the J8 dual-write mirror (api/_lib/jobs-mirror)
// so a live mirror and this bulk import can never diverge.
const { writeAll, currentCounts } = require('./lib/structure-writer');
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
