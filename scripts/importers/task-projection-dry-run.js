#!/usr/bin/env node
// Task-expansion projection — DRY-RUN ONLY. The J3 validation gate.
//
//   node scripts/importers/task-projection-dry-run.js            # print the plan
//   node scripts/importers/task-projection-dry-run.js --json
//   node scripts/importers/task-projection-dry-run.js --from-dir <snapshot>
//
// Prints EXACTLY which canonical task instances J3 would create by expanding the
// imported job_task_templates across the live areas (override-wins), with the
// per-area rough/fit-off breakdown, override/suppressed/orphaned counts, and any
// canonical-identity collision — BEFORE a single `tasks` row is written.
//
// READ-ONLY BY CONSTRUCTION: imports ONLY readBlob; opens NO Supabase connection
// (no getDb); writes NOTHING (no Blob, no DB, no tasks). There is no --write flag.
// Exit 0 when the projection is CLEAN (0 collisions, 0 orphaned state), 1 otherwise
// — so it can gate J3 in a checklist. If this matches Blob, J3 is a straightforward
// importer; if not, the drift is surfaced here first.

const fs = require('node:fs');
const path = require('node:path');

const { buildTaskProjection } = require('./lib/task-projection');

const DATA_CONCURRENCY = 8;

function parseArgs(argv) {
  const args = { fromDir: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-dir') args.fromDir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else { console.error(`unknown argument: ${a}`); args.help = true; }
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

function loadFromDir(dir) {
  const jobs = readJsonFile(path.join(dir, 'jobs.json'));
  const jobData = {};
  for (const job of jobs && Array.isArray(jobs.jobs) ? jobs.jobs : []) {
    if (!job || !job.id) continue;
    jobData[job.id] = readJsonFile(path.join(dir, 'jobs', String(job.id), 'data.json'));
  }
  return { jobs, jobData };
}

// Live Blob — read-only. Deliberately imports ONLY readBlob.
async function loadFromBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not set — export it (read access) or use --from-dir <snapshot>');
  }
  const { readBlob } = require('../../api/_lib/blob');
  const jobs = await readBlob('jobs.json', null);
  const jobData = {};
  const ids = (jobs && Array.isArray(jobs.jobs) ? jobs.jobs : []).filter((j) => j && j.id).map((j) => j.id);
  for (let i = 0; i < ids.length; i += DATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + DATA_CONCURRENCY);
    const results = await Promise.all(chunk.map((id) => readBlob(`jobs/${id}/data.json`, null)));
    chunk.forEach((id, idx) => { jobData[id] = results[idx]; });
  }
  return { jobs, jobData };
}

function printProjection(p) {
  console.log('\nTask-expansion projection (DRY RUN — nothing written; no `tasks` row created)\n');
  for (const job of p.jobs) {
    console.log(`Job ${job.name}  [${job.jobLegacy}]`);
    console.log(`  task instances to create: ${job.instances}`);
    const withWork = job.areas.filter((a) => a.roughIn + a.fitOff > 0);
    if (withWork.length) {
      console.log('  rough:  ' + withWork.map((a) => `${a.areaName} ${a.roughIn}`).join(' · '));
      console.log('  fitoff: ' + withWork.map((a) => `${a.areaName} ${a.fitOff}`).join(' · '));
    }
  }
  const t = p.totals;
  console.log('\nTOTAL');
  console.log(`  templates (definitions): ${t.templates}`);
  console.log(`  task instances to create: ${t.instances}  (rough ${t.byStage.roughIn} · fitoff ${t.byStage.fitOff})`);
  console.log(`  status: not_started ${t.byStatus.not_started} · in_progress ${t.byStatus.in_progress} · complete ${t.byStatus.complete}`);
  console.log(`  overrides applied: ${p.overrides}`);
  console.log(`  suppressed: ${p.suppressed.archivedAreas} archived areas · ${p.suppressed.archivedTemplates} archived templates`);
  console.log(`  orphaned recorded state: ${p.orphanedState.length}`);
  console.log(`  malformed templates (no id): ${p.malformed.length}`);
  console.log(`  bad status (outside schema CHECK): ${p.badStatus.length}`);
  console.log(`  collisions (canonical identity): ${p.collisions.length}`);
  if (p.badStatus.length) console.log(`    bad status e.g. ${JSON.stringify(p.badStatus.slice(0, 5))}`);
  if (p.collisions.length) console.log(`    e.g. ${JSON.stringify(p.collisions.slice(0, 5))}`);
  if (p.malformed.length) console.log(`    malformed e.g. ${JSON.stringify(p.malformed.slice(0, 5))}`);
  if (p.orphanedState.length) console.log(`    orphaned e.g. ${JSON.stringify(p.orphanedState.slice(0, 5))}`);
  console.log(`\nresult: ${p.clean ? 'CLEAN — J3 expansion is safe to write' : 'NOT CLEAN — resolve collisions/orphaned state before writing J3'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/task-projection-dry-run.js [--from-dir <dir>] [--json]');
    return;
  }
  const sources = args.fromDir ? loadFromDir(args.fromDir) : await loadFromBlob();
  const projection = buildTaskProjection(sources);
  if (args.json) console.log(JSON.stringify(projection, null, 2));
  else printProjection(projection);
  process.exitCode = projection.clean ? 0 : 1;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
