#!/usr/bin/env node
// #383 — sweep jobs.json for out-of-enum statuses and fix forward.
//
// The deleted legacy builder offered 'paused' (never in JOB_STATUSES);
// rows it wrote are a live hazard for strict parsers. Mapping:
//   paused → on_hold        (same semantics)
//   anything else unknown   → REPORTED ONLY, never auto-mapped
//
// DRY-RUN BY DEFAULT. --write applies the fix as ONE batch write to
// jobs.json (never loop writes — the resurrection hazard from #117).
//
//   node scripts/fix-job-statuses.js            # report only
//   node scripts/fix-job-statuses.js --write    # apply
//
// Requires BLOB_READ_WRITE_TOKEN (run with: node --env-file=.env.local …)

const { list } = require('@vercel/blob');

const VALID = new Set(['active', 'complete', 'archived', 'on_hold', 'draft']);
const MAP = { paused: 'on_hold' };

async function main() {
  const write = process.argv.includes('--write');
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN required');

  const { blobs } = await list({ prefix: 'jobs.json', token });
  const reg = blobs.find((b) => b.pathname === 'jobs.json');
  if (!reg) throw new Error('jobs.json not found');
  const res = await fetch(reg.url + '?t=' + Date.now(), { cache: 'no-store' });
  const data = await res.json();
  const jobs = data.jobs || [];

  const fixes = [];
  const unknown = [];
  for (const j of jobs) {
    const s = j.status;
    if (s === undefined || s === null || VALID.has(s)) continue;
    if (MAP[s]) fixes.push({ id: j.id, name: j.name, from: s, to: MAP[s] });
    else unknown.push({ id: j.id, name: j.name, status: s });
  }

  console.log(`jobs: ${jobs.length} · mappable: ${fixes.length} · unknown: ${unknown.length}`);
  for (const f of fixes) console.log(`  FIX ${f.id} (${f.name}): ${f.from} → ${f.to}`);
  for (const u of unknown) console.log(`  ?? ${u.id} (${u.name}): '${u.status}' — needs a human`);

  if (!write) { console.log('dry-run — pass --write to apply the mappable fixes'); return; }
  if (!fixes.length) { console.log('nothing to write'); return; }

  for (const f of fixes) {
    const j = jobs.find((x) => x.id === f.id);
    j.status = f.to;
    j.updatedAt = new Date().toISOString();
  }
  // ONE batch write through the app's own write path (guards + rev stamp).
  const { writeBlob } = require('../api/_lib/blob');
  await writeBlob('jobs.json', data);
  console.log(`wrote jobs.json once with ${fixes.length} fix(es)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
