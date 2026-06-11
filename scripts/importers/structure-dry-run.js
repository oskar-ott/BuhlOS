#!/usr/bin/env node
// Structure dry-run importer (scaffold) — READ-ONLY by construction.
//
//   node scripts/importers/structure-dry-run.js [--from-dir <dir>] [--json] [--write]
//
// Reads users.json + jobs.json + per-job data.json (live Vercel Blob via the
// read-only readBlob helper, or a local key-for-key snapshot directory) and
// prints the proposed Phase-1 structure import plan: per-table insert
// counts, missing references, duplicate legacy ids, invalid records and
// warnings. Exit 0 on a clean run, 1 on hard validation errors.
//
// Safety:
//   * NEVER writes to Supabase — no client exists; the planner is pure.
//   * NEVER writes to Vercel Blob — only readBlob is imported.
//   * --write must pass the Supabase environment guard in write mode and
//     even then throws WRITE_NOT_IMPLEMENTED (this scaffold is dry-run only).
//   * Not wired to any API route, deploy hook or cron. Operator-run only.
//
// Contract: docs/supabase-importer-plan.md · usage: scripts/importers/README.md

const fs = require('node:fs');
const path = require('node:path');

const { buildStructureImportPlan } = require('./lib/structure-plan');
const { resolveRunMode, describeTarget } = require('./lib/run-mode');
const supabaseEnvGuard = require('../../api/_lib/supabase-env');

const DATA_CONCURRENCY = 8;

function parseArgs(argv) {
  const args = { fromDir: null, json: false, write: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-dir') args.fromDir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--write') args.write = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`malformed JSON at ${filePath}: ${err.message}`);
  }
}

// Local snapshot directory mirrors blob keys exactly:
//   <dir>/users.json, <dir>/jobs.json, <dir>/jobs/<jobId>/data.json
function loadFromDir(dir) {
  const users = readJsonFile(path.join(dir, 'users.json'));
  const jobs = readJsonFile(path.join(dir, 'jobs.json'));
  const jobData = {};
  for (const job of (jobs && Array.isArray(jobs.jobs) ? jobs.jobs : [])) {
    if (!job || !job.id) continue;
    jobData[job.id] = readJsonFile(path.join(dir, 'jobs', String(job.id), 'data.json'));
  }
  return { users, jobs, jobData };
}

// Live Blob — read-only. Deliberately imports ONLY readBlob.
async function loadFromBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set — export it (read access) or use --from-dir <snapshot>'
    );
  }
  const { readBlob } = require('../../api/_lib/blob');
  const users = await readBlob('users.json', null);
  const jobs = await readBlob('jobs.json', null);
  const jobData = {};
  const ids = (jobs && Array.isArray(jobs.jobs) ? jobs.jobs : [])
    .filter((j) => j && j.id)
    .map((j) => j.id);
  for (let i = 0; i < ids.length; i += DATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + DATA_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((id) => readBlob(`jobs/${id}/data.json`, null))
    );
    chunk.forEach((id, idx) => {
      jobData[id] = results[idx];
    });
  }
  return { users, jobs, jobData };
}

function printSection(title, rows, cap = 20) {
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows.slice(0, cap)) {
    console.log(`  - ${typeof row === 'string' ? row : JSON.stringify(row)}`);
  }
  if (rows.length > cap) console.log(`  … and ${rows.length - cap} more`);
}

function printPlan(plan) {
  console.log('\nProposed structure import (dry-run — nothing was written)');
  console.log('table                 inserts  updates');
  for (const [table, counts] of Object.entries(plan.tables)) {
    console.log(
      `${table.padEnd(22)}${String(counts.inserts).padStart(7)}${String(counts.updates).padStart(9)}`
    );
  }
  console.log(`\nnote: ${plan.summary.updatesNote}`);
  console.log(
    `sources: ${plan.summary.sources.users} users, ${plan.summary.sources.jobs} jobs, ` +
      `${plan.summary.sources.jobDataBlobs} per-job data blobs`
  );
  console.log(
    `members: ${plan.summary.members.total} (${plan.summary.members.leads} leads) · ` +
      `archived: ${plan.summary.archived.groups} groups / ${plan.summary.archived.areas} areas / ` +
      `${plan.summary.archived.templateEntries} template entries`
  );
  console.log(
    `task state: ${plan.summary.taskStates.complete} complete, ` +
      `${plan.summary.taskStates.in_progress} in progress, ` +
      `${plan.summary.taskStates.unknown} unknown`
  );
  console.log(`job statuses: ${JSON.stringify(plan.summary.distinctJobStatuses)}`);

  printSection('HARD ERRORS', plan.hardErrors);
  printSection('Invalid records (quarantined)', plan.invalidRecords);
  printSection('Duplicate legacy ids', plan.duplicateLegacyIds);
  printSection('Missing references (quarantined)', plan.missingRefs);
  printSection('Warnings', plan.warnings);

  console.log(`\nresult: ${plan.summary.clean ? 'CLEAN' : 'NOT CLEAN — fix before any real import'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'usage: node scripts/importers/structure-dry-run.js [--from-dir <dir>] [--json] [--write]'
    );
    process.exitCode = args.help && process.argv.length > 3 ? 1 : 0;
    return;
  }

  // Mode first: --write must fail loudly BEFORE any source is read.
  const runMode = resolveRunMode(process.argv.slice(2), process.env, supabaseEnvGuard);

  console.log(`mode: ${runMode.mode}`);
  for (const line of describeTarget(process.env)) console.log(line);

  const sources = args.fromDir ? loadFromDir(args.fromDir) : await loadFromBlob();
  const plan = buildStructureImportPlan(sources);

  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    printPlan(plan);
  }
  process.exitCode = plan.summary.clean ? 0 : 1;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
