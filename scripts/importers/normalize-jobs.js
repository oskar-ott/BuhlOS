#!/usr/bin/env node
// J8.75 — legacy job structure normalizer (operator-run, NOT wired to any route).
//
//   node scripts/importers/normalize-jobs.js           # dry-run (no writes)
//   node scripts/importers/normalize-jobs.js --write    # canonicalise jobs.json
//   node scripts/importers/normalize-jobs.js --json
//
// Canonicalises legacy jobs' Blob *representation* (order + sparse defaults +
// "" → null) so the J6/J7 read overlays serve them from Postgres. Data is NOT
// changed — see scripts/importers/lib/normalize-job-structure.js for the three
// safety guards (byte-faithful to PG · migrated data unchanged · no field
// dropped). A job that fails any guard is left untouched (Blob-served, safe).
//
// Reads the canonical shape from the PG reconstruction (the blob's own data,
// imported then reconstructed, proven IN SYNC). The only WRITE is jobs.json on
// --write; Postgres is read-only here (the importer-projection is unchanged, so
// no re-mirror is needed). Guarded: getDb({mode:'read'}); --write does NOT need
// Supabase writes.

const { readBlob, writeBlob } = require('../../api/_lib/blob');
const { loadJobStructureFromPg } = require('../../api/_lib/job-read-projection');
const { normalizeJobStructure } = require('./lib/normalize-job-structure');
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/normalize-jobs.js [--write] [--json]');
    return;
  }
  if (!process.env.SUPABASE_DB_URL) {
    console.error('no SUPABASE_DB_URL — this needs the PG reconstruction to canonicalise against. Aborting.');
    process.exitCode = 1;
    return;
  }

  const data = await readBlob('jobs.json', { jobs: [] });
  const jobs = data.jobs || [];

  let pgById;
  try {
    const sql = getDb({ mode: 'read' });
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) { console.error('no tenant in PG'); process.exitCode = 1; return; }
    const recon = await loadJobStructureFromPg(sql, tenant[0].id);
    pgById = new Map((recon.jobs.jobs || []).map((j) => [j.id, j]));
  } finally {
    await closeDb();
  }

  const normalized = [];
  const skipped = [];
  const faithful = [];
  const outJobs = jobs.map((j) => {
    const r = normalizeJobStructure(j, pgById.get(j.id));
    if (r.normalized) { normalized.push(j.id); return r.job; }
    if (r.reason === 'already faithful') faithful.push(j.id);
    else skipped.push({ id: j.id, reason: r.reason });
    return j;
  });

  const report = {
    mode: args.write ? 'write' : 'dry-run',
    total: jobs.length,
    alreadyFaithful: faithful.length,
    normalizable: normalized.length,
    skipped: skipped.length,
    normalizedIds: normalized,
    skippedDetail: skipped,
  };

  if (args.write && normalized.length) {
    await writeBlob('jobs.json', { ...data, jobs: outJobs });
    report.written = true;
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nNormalize jobs — ${report.mode.toUpperCase()}`);
    console.log(`total ${report.total} · already-faithful ${report.alreadyFaithful} · normalizable ${report.normalizable} · skipped ${report.skipped}`);
    if (normalized.length) console.log(`  normalize: ${normalized.join(', ')}`);
    for (const s of skipped) console.log(`  skip ${s.id}: ${s.reason}`);
    if (args.write && report.written) console.log('\njobs.json rewritten (canonical representation; data unchanged). Re-run to confirm 0 normalizable (idempotent).');
    else if (!args.write) console.log('\nrun with --write to canonicalise jobs.json.');
  }
  process.exitCode = 0;
}

if (require.main === module) {
  main().catch((err) => { console.error(err && err.message ? err.message : err); process.exitCode = 1; });
}

module.exports = { parseArgs };
