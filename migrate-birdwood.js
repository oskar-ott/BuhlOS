// One-off migration: backfill type + areaGroups on the Birdwood job.
// Dry-run by default. Pass --apply to write.
//
// Usage:
//   node migrate-birdwood.js           # dry run, prints diff
//   node migrate-birdwood.js --apply   # writes to blob
//
// Reads BLOB_READ_WRITE_TOKEN from .env.local if present, else falls back
// to process.env. No external deps required.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── .env.local loader (no dotenv needed) ──────────────────────────────────
function loadEnvLocal() {
  const p = path.join(__dirname, '.env.local');
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvLocal();

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN is not set.');
  console.error('Add it to .env.local or export it before running this script.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

// ── Minimal blob helpers (inline, avoids require('@vercel/blob') at CLI) ──
async function blobList(prefix) {
  const url = `https://blob.vercel-storage.com/?prefix=${encodeURIComponent(prefix)}&limit=10`;
  return jsonFetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
}

async function blobGet(key) {
  const list = await blobList(key);
  const match = (list.blobs || []).find(b => b.pathname === key);
  if (!match) return null;
  const r = await jsonFetch(match.url + '?t=' + Date.now(), { headers: { 'Cache-Control': 'no-store' } });
  return r;
}

async function blobPut(key, data) {
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const u = new URL(`https://blob.vercel-storage.com/${key}`);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + '?addRandomSuffix=0',
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-cache-control-max-age': '0',
      },
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); } catch { resolve(out); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function jsonFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = https.request(options, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); } catch { resolve(out); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Birdwood area definitions ──────────────────────────────────────────────
// These IDs will be resolved from data.json dwelling keys below.
// Fallback names match what the original app used.
const BIRDWOOD_UNITS      = Array.from({ length: 15 }, (_, i) => `Unit ${i + 1}`);
const BIRDWOOD_TOWNHOUSES = Array.from({ length: 7  }, (_, i) => `Townhouse ${i + 1}`);

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== migrate-birdwood.js (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  // 1. Read jobs.json — find Birdwood
  console.log('Reading jobs.json...');
  const jobsData = await blobGet('jobs.json');
  if (!jobsData || !jobsData.jobs) { console.error('Could not read jobs.json'); process.exit(1); }

  const birdwoodJob = jobsData.jobs.find(j =>
    /birdwood/i.test(j.name) || /birdwood/i.test(j.id)
  );
  if (!birdwoodJob) {
    console.error('Could not find a job matching "Birdwood". Jobs found:');
    jobsData.jobs.forEach(j => console.log(`  id="${j.id}"  name="${j.name}"`));
    process.exit(1);
  }
  console.log(`Found Birdwood job: id="${birdwoodJob.id}"  name="${birdwoodJob.name}"\n`);

  // 2. Read data.json — inspect existing dwelling keys
  const dataKey = `jobs/${birdwoodJob.id}/data.json`;
  console.log(`Reading ${dataKey}...`);
  const jobData = await blobGet(dataKey);
  const dwellingKeys = Object.keys((jobData && jobData.dwellings) || {});
  console.log(`Existing dwelling keys (${dwellingKeys.length}):`);
  dwellingKeys.forEach(k => console.log(`  "${k}"`));
  console.log();

  // Build area id mapping: use dwelling key as id if it matches a known name,
  // otherwise generate a stable slug.
  function areaId(name) {
    // If the key exists verbatim in data.json, use it as the id.
    if (dwellingKeys.includes(name)) return name;
    // Fallback: simple slug
    return name.toLowerCase().replace(/\s+/g, '-');
  }

  const areaGroups = [
    {
      id: 'ag_units',
      name: 'Units',
      areas: BIRDWOOD_UNITS.map(n => ({ id: areaId(n), name: n })),
    },
    {
      id: 'ag_townhouses',
      name: 'Townhouses',
      areas: BIRDWOOD_TOWNHOUSES.map(n => ({ id: areaId(n), name: n })),
    },
  ];

  // 3. Ensure "Residential fitout" job-type exists
  console.log('Reading job-types.json...');
  const jtRaw = await blobGet('job-types.json');
  const jobTypes = (jtRaw && jtRaw.jobTypes) || [];
  let rfType = jobTypes.find(t => /residential fitout/i.test(t.name));

  let jtDataUpdated = null;
  if (!rfType) {
    const newId = 'jt_residential-fitout';
    rfType = { id: newId, name: 'Residential fitout', defaultAreaGroups: [] };
    console.log(`  "Residential fitout" not found — will create with id="${newId}"`);
    jtDataUpdated = { jobTypes: [...jobTypes, rfType] };
  } else {
    console.log(`  Found "Residential fitout": id="${rfType.id}"`);
  }
  console.log();

  // 4. Build the updated job record
  const updatedJob = {
    ...birdwoodJob,
    type: rfType.id,
    areaGroups,
    // preserve old layout/stages fields — do not strip
  };

  // 5. Print diff
  console.log('--- current job record ---');
  console.log(JSON.stringify(birdwoodJob, null, 2));
  console.log('\n+++ updated job record +++');
  console.log(JSON.stringify(updatedJob, null, 2));

  if (jtDataUpdated) {
    console.log('\n+++ job-types.json will gain entry +++');
    console.log(JSON.stringify(rfType, null, 2));
  }

  if (!APPLY) {
    console.log('\n[DRY RUN] No changes written. Re-run with --apply to commit.\n');
    return;
  }

  // 6. Write
  console.log('\nWriting...');

  // Update jobs.json
  const jobIdx = jobsData.jobs.findIndex(j => j.id === birdwoodJob.id);
  jobsData.jobs[jobIdx] = updatedJob;
  await blobPut('jobs.json', jobsData);
  console.log('  wrote jobs.json');

  // Update job-types.json if needed
  if (jtDataUpdated) {
    await blobPut('job-types.json', jtDataUpdated);
    console.log('  wrote job-types.json');
  }

  console.log('\nDone.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
