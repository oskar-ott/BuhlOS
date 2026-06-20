#!/usr/bin/env node
// J5 read-parity proof — does the DARK Postgres read projection reconstruct the
// Blob shape faithfully? READ-ONLY: reads Blob + PG, writes NOTHING (no --write,
// no getDb write mode, no Blob writes). Blob stays authoritative.
//
//   node scripts/importers/job-read-parity.js [--json]
//
// Method: reconstruct the Blob sources from Postgres (job-read-projection), then
// run the SAME importer Blob-projections on BOTH the real Blob and the
// reconstruction and compare the migrated entities. If they match, the read
// projection is a faithful inverse of the importers — i.e. a PG-served read would
// return the same migrated data as Blob. Timestamps are excluded (capture/import
// metadata; cross-store precision) exactly as the structure sync-check does.
//
// Exit 0 iff every section matches.

const crypto = require('node:crypto');
const { buildStructureRows } = require('./lib/structure-rows');
const { buildTaskProjection } = require('./lib/task-projection');
const { loadJobStructureFromPg } = require('../../api/_lib/job-read-projection');
const { getDb, closeDb } = require('../../api/_lib/supabase-db');

const NOW = '2000-01-01T00:00:00.000Z'; // fixed clock so the two builds align on proxy timestamps
const DATA_CONCURRENCY = 8;

function parseArgs(argv) {
  const args = { json: false, help: false };
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else { console.error(`unknown argument: ${a}`); args.help = true; }
  }
  return args;
}

async function loadBlob() {
  const { readBlob } = require('../../api/_lib/blob');
  const jobs = await readBlob('jobs.json', null);
  const jobData = {};
  const ids = (jobs && Array.isArray(jobs.jobs) ? jobs.jobs : []).filter((j) => j && j.id).map((j) => j.id);
  for (let i = 0; i < ids.length; i += DATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + DATA_CONCURRENCY);
    const res = await Promise.all(chunk.map((id) => readBlob(`jobs/${id}/data.json`, null)));
    chunk.forEach((id, idx) => { jobData[id] = res[idx]; });
  }
  return { jobs, jobData };
}

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sortByKey = (arr, keyFn) => [...arr].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
// created_at is a timestamp (real=Blob ISO vs PG ::text) — strip before compare.
const stripTs = (rows) => rows.map(({ created_at, ...rest }) => rest);

// Comparison entities for both sides, via the SAME canonical builders.
function comparable(sources) {
  const s = buildStructureRows({ jobs: sources.jobs }, { nowIso: NOW });
  const proj = buildTaskProjection(sources);
  // evidence: compare on blob-shape semantic fields; exclude actor-id round-trips
  // (captured_by/reviewed_by are NULLed for unresolved users — label is preserved)
  // and timestamps.
  const evidence = [];
  for (const jobId of Object.keys(sources.jobData || {})) {
    for (const e of (sources.jobData[jobId] && sources.jobData[jobId].evidence) || []) {
      evidence.push({
        key: `${jobId}|${e.id}`, kind: e.kind, status: e.status, source: e.source, note: e.note ?? null,
        photoId: e.photoId ?? null, photoUrl: e.photoUrl ?? null, thumbnailUrl: e.thumbnailUrl ?? null,
        areaId: e.areaId ?? null, stage: e.stage ?? null, taskId: e.taskId ?? null,
        capturedByName: e.capturedByName ?? null, reviewedByName: e.reviewedByName ?? null,
        rejectionReason: e.rejectionReason ?? null,
        exifLat: e.exifLocation ? (e.exifLocation.lat ?? null) : null,
        exifLng: e.exifLocation ? (e.exifLocation.lng ?? null) : null,
      });
    }
  }
  return {
    jobs: sortByKey(stripTs(s.jobRows), (r) => r.legacy_id),
    groups: sortByKey(stripTs(s.groupRows), (r) => r.legacy_id),
    areas: sortByKey(stripTs(s.areaRows), (r) => r.legacy_id),
    templates: sortByKey(stripTs(s.templateRows), (r) => `${r.job_legacy_id}|${r.site_area_legacy_id}|${r.stage}|${r.legacy_id}`),
    tasks: sortByKey(proj.instances, (r) => `${r.areaLegacy}|${r.stage}|${r.legacyTemplateId}`),
    evidence: sortByKey(evidence, (r) => r.key),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('usage: node scripts/importers/job-read-parity.js [--json]'); return; }

  let real, pg;
  try {
    const sql = getDb({ mode: 'read' });
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl")');
    const pgSources = await loadJobStructureFromPg(sql, tenant[0].id);
    real = comparable(await loadBlob());
    pg = comparable(pgSources);
  } finally {
    await closeDb();
  }

  const sections = ['jobs', 'groups', 'areas', 'templates', 'tasks', 'evidence'];
  const report = { sections: {}, clean: true };
  for (const sec of sections) {
    const blobHash = sha(real[sec]);
    const pgHash = sha(pg[sec]);
    const match = blobHash === pgHash;
    report.sections[sec] = { blob: real[sec].length, pg: pg[sec].length, match, blobHash, pgHash };
    if (!match) report.clean = false;
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nJ5 read-parity — ${report.clean ? 'PG read projection MATCHES Blob ✓' : 'DRIFT — reconstruction != Blob'}\n`);
    for (const sec of sections) {
      const s = report.sections[sec];
      console.log(`  ${sec.padEnd(10)} blob ${String(s.blob).padStart(4)} · pg ${String(s.pg).padStart(4)} · ${s.match ? 'match ✓' : 'MISMATCH ✗ (' + String(s.blobHash).slice(0, 8) + ' vs ' + String(s.pgHash).slice(0, 8) + ')'}`);
    }
    console.log(`\nresult: ${report.clean ? 'FAITHFUL — a PG-served read returns the same migrated data as Blob' : 'NOT FAITHFUL — fix the reconstruction'}`);
  }
  process.exitCode = report.clean ? 0 : 1;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
