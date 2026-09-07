#!/usr/bin/env node
// One-off importer: the Birdwood Townhouses 1–7 outstanding-electrical
// checklist (owner walk-through, 2026-09) becomes REAL job structure the
// crew can tick in Phil — one area group "Townhouses 1–7" with an area per
// townhouse and each outstanding item as a fit-off task. Items that can't
// be finished yet carry their reason inline ("— waiting: benchtop") so the
// field sees WHY a task sits, in site language. Items the walk-through
// recorded as already done (TH6 upstairs bathroom light + fan) are not
// imported — this is the outstanding list.
//
// Two modes, both through the app's own sanctioned write paths (no second
// raw jobs.json writer — #244):
//
//   node --env-file=.env.local scripts/import-birdwood-outstanding.js
//     Dry run (default): validates the structure, prints the plan, lists
//     any existing job whose name matches /birdwood/i so you can choose
//     --into instead of a new job. Writes NOTHING.
//
//   node --env-file=.env.local scripts/import-birdwood-outstanding.js --write
//     Creates a DRAFT job "Birdwood Townhouses 1–7" via api/_lib/job-create
//     (ids minted, per-job data.json/tags.json/temps.json seeded). Drafts
//     are invisible to the field — review it in the Job Builder and publish
//     when happy, exactly like any other job.
//
//   node --env-file=.env.local scripts/import-birdwood-outstanding.js --write --into <jobId>
//     Adds the "Townhouses 1–7" group to an EXISTING job instead (use this
//     when the crew already logs hours/photos against a Birdwood job, so
//     tasks, hours and evidence stay on one job). One batch jobs.json write
//     (#117 — never loop writes); the live-area-id invariant is checked over
//     the COMBINED structure with the same shared guard every write path uses.
//
//   --name "..."  override the new job's name (create mode only)
//
// Requires BLOB_READ_WRITE_TOKEN (vercel env pull .env.local).

const { list } = require('@vercel/blob');
const { validateAreaGroups, findDuplicateLiveAreaId } = require('../api/_lib/validation');

// ── The walk-through data ───────────────────────────────────────────────────
// label = task name as the site says it; wait = why it can't be finished yet
// (omitted when it's ready to do now). Rendered as "label — waiting: wait".
const TOWNHOUSES = [
  { name: 'Townhouse 1', items: [
    { label: 'Front external wall light' },
    { label: 'Spotlight', wait: 'ceiling to be completed' },
    { label: 'Kitchen lights', wait: 'kitchen ceiling to be completed' },
    { label: 'Kitchen cooktop', wait: 'benchtop' },
    { label: 'Kitchen oven', wait: 'benchtop' },
    { label: 'Splashback electrical fit-off', wait: 'splashback not ready' },
    { label: 'Bathroom ceiling fit-off / light', wait: 'bathroom ceiling to be finished' },
    { label: 'Bathroom exhaust fan', wait: 'ceiling to be finished' },
    { label: 'Upstairs ceiling lights', wait: 'upstairs ceilings to be completed' },
    { label: 'Distribution board (DB) — complete fit-off' },
  ]},
  { name: 'Townhouse 2', items: [
    { label: 'Front external wall light' },
    { label: 'Kitchen fridge GPO' },
    { label: 'Kitchen LED' },
    { label: 'Range hood' },
    { label: 'Kitchen cooktop', wait: 'benchtop' },
    { label: 'Kitchen oven', wait: 'benchtop' },
    { label: 'Laundry ceiling fit-off', wait: 'ceiling to be sanded and painted' },
    { label: 'Ground-floor switch' },
    { label: 'Bathroom switch' },
    { label: 'Master bedroom light' },
    { label: 'Walk-in wardrobe light' },
    { label: 'Upstairs bathroom light' },
    { label: 'Upstairs bathroom exhaust fan' },
    { label: 'USB GPOs in bedrooms' },
    { label: 'Bulbs / lights in the two rear bedrooms' },
  ]},
  { name: 'Townhouse 3', items: [
    { label: 'Front external wall light' },
    { label: 'Fridge GPO' },
    { label: 'Kitchen LED' },
    { label: 'Kitchen switch' },
    { label: 'Upstairs bathroom ceiling light' },
    { label: 'Upstairs bathroom exhaust fan' },
    { label: 'USB GPOs in all bedrooms' },
  ]},
  { name: 'Townhouse 4', items: [
    { label: 'Front external wall light' },
    { label: 'Living room GPO — mount / fit off' },
    { label: 'Kitchen switch', wait: 'wall to be rendered' },
    { label: 'Fridge GPO' },
    { label: 'Cooktop', wait: 'benchtop' },
    { label: 'Oven', wait: 'benchtop' },
    { label: 'Range hood' },
    { label: 'Kitchen LED' },
    { label: 'Downstairs bathroom exhaust fan — cut out' },
    { label: 'Downstairs bathroom ceiling light', wait: 'ceiling to be patched and painted' },
    { label: 'All upstairs ceiling lights' },
    { label: 'USB GPOs in upstairs bedrooms' },
    { label: 'Upstairs stair switch' },
  ]},
  { name: 'Townhouse 5', items: [
    { label: 'Front external wall light' },
    { label: 'Living room GPOs' },
    { label: 'Living room ceiling light', wait: 'first coat of paint' },
    { label: 'Living room switch' },
    { label: 'Stair switch' },
    { label: 'Downstairs bathroom switch' },
    { label: 'Fridge GPO' },
    { label: 'Kitchen switch' },
    { label: 'Kitchen range hood' },
    { label: 'Kitchen LEDs' },
    { label: 'Kitchen light', wait: 'blocker not stated on site' },
    { label: 'Cooktop', wait: 'benchtop' },
    { label: 'Oven', wait: 'benchtop' },
    { label: 'Downstairs bathroom exhaust fan — cut out' },
    { label: 'Downstairs bathroom ceiling light', wait: 'ceiling to be sanded and painted' },
    { label: 'Upstairs ceiling lights', wait: 'sanded — need first coat of paint' },
    { label: 'Upstairs bedroom GPOs' },
    { label: 'Upstairs bedroom switches' },
    { label: 'Additional upstairs GPO from inspection — exact location to confirm' },
    { label: 'Upstairs bathroom light' },
    { label: 'Upstairs bathroom ceiling / exhaust fan' },
  ]},
  { name: 'Townhouse 6', items: [
    { label: 'Front external wall light' },
    { label: 'Downstairs bathroom switch' },
    { label: 'Kitchen LEDs' },
    { label: 'Kitchen ceiling light' },
    { label: 'Fridge GPO' },
    { label: 'Range hood' },
    { label: 'Downstairs bathroom exhaust fan — cut out' },
    { label: 'Downstairs bathroom exhaust fan — final fit-off', wait: 'ceiling to be patched and painted' },
    { label: 'Downstairs bathroom ceiling light', wait: 'ceiling to be patched and painted' },
    { label: 'Lights in the two rear upstairs bedrooms' },
    { label: 'USB GPOs in upstairs bedrooms' },
    { label: 'Upstairs bathroom GPO — fit off' },
  ]},
  { name: 'Townhouse 7', items: [
    { label: 'Front external wall light' },
    { label: 'Lounge room spotlight', wait: 'painting to be completed' },
    { label: 'Kitchen LED' },
    { label: 'Range hood' },
    { label: 'Fridge GPO — inspect and pick mounting point' },
    { label: 'Cooktop isolation switch / above-bench fit-off', wait: 'above-bench area not ready' },
    { label: 'Kitchen switch' },
    { label: 'Kitchen ceiling light', wait: 'ceiling patching' },
    { label: 'Downstairs bathroom exhaust / ceiling fan — cut out' },
    { label: 'Downstairs bathroom light', wait: 'ceiling to be painted' },
    { label: 'Upstairs bathroom GPO — fit off' },
    { label: 'Upstairs bathroom ceiling fan', wait: 'ceiling patching' },
    { label: 'Upstairs bathroom light', wait: 'painting' },
    { label: 'USB GPOs in all upstairs bedrooms' },
    { label: 'Wall switches in upstairs bedrooms' },
    { label: 'Hallway wall switches' },
    { label: 'Master bedroom ceiling / light fit-off', wait: 'sanding / upstairs painting not complete' },
  ]},
];

const GROUP_NAME = 'Townhouses 1–7';
const DEFAULT_JOB_NAME = 'Birdwood Townhouses 1–7';

function taskName(item) {
  return item.wait ? `${item.label} — waiting: ${item.wait}` : item.label;
}

function buildGroup() {
  return {
    name: GROUP_NAME,
    areas: TOWNHOUSES.map((th, i) => ({
      name: th.name,
      spaceType: 'Townhouse',
      order: i,
      fitOffTasks: th.items.map((item, j) => ({ name: taskName(item), order: j })),
    })),
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// Authoritative, uncached jobs.json read (the fix-job-statuses pattern).
// HARD-FAILS when the registry is missing or empty rather than handing a
// default `{jobs: []}` to a writer — a bad token must never be able to
// replace the registry with a one-job file.
async function readJobsRegistry(token) {
  const { blobs } = await list({ prefix: 'jobs.json', token });
  const reg = blobs.find((b) => b.pathname === 'jobs.json');
  if (!reg) throw new Error('jobs.json not found in the blob store — wrong token/store?');
  const res = await fetch(reg.url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`jobs.json fetch failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.jobs) || data.jobs.length === 0) {
    throw new Error('jobs.json read back empty — refusing to write anything');
  }
  return data;
}

async function main() {
  const write = process.argv.includes('--write');
  const into = argValue('--into');
  const name = argValue('--name') || DEFAULT_JOB_NAME;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN required (node --env-file=.env.local …)');

  // Validate the structure through the app's own validator up front — the
  // same normalisation every create/PUT runs (ids minted here in --into
  // mode; createJob re-validates and mints in create mode).
  const parsed = validateAreaGroups([buildGroup()], 'areaGroups');
  if (!parsed.ok) throw new Error(`structure invalid: ${parsed.error}`);

  const total = TOWNHOUSES.reduce((s, th) => s + th.items.length, 0);
  const waiting = TOWNHOUSES.reduce((s, th) => s + th.items.filter((i) => i.wait).length, 0);
  console.log(`plan: group "${GROUP_NAME}" · ${TOWNHOUSES.length} townhouse areas · ${total} fit-off tasks (${waiting} marked waiting)`);
  for (const th of TOWNHOUSES) {
    const w = th.items.filter((i) => i.wait).length;
    console.log(`  ${th.name}: ${th.items.length} tasks${w ? ` (${w} waiting)` : ''}`);
  }

  const data = await readJobsRegistry(token);
  const birdwoodish = data.jobs.filter((j) => /birdwood/i.test(j.name || ''));
  if (!into && birdwoodish.length) {
    console.log('\nexisting job(s) matching "birdwood" — consider --into <id> so tasks join the job the crew already uses:');
    for (const j of birdwoodish) console.log(`  ${j.id}  "${j.name}"  status=${j.status}`);
  }

  if (!write) {
    console.log(`\ndry-run — nothing written. Apply with:\n  --write            create a DRAFT job "${name}"\n  --write --into <jobId>   add the group to an existing job`);
    return;
  }

  if (into) {
    const job = data.jobs.find((j) => j.id === into);
    if (!job) throw new Error(`--into ${into}: no job with that id`);
    if ((job.areaGroups || []).some((g) => g && g.name === GROUP_NAME && !g.archived)) {
      throw new Error(`job ${into} already has a live "${GROUP_NAME}" group — refusing a duplicate import`);
    }
    const combined = [...(job.areaGroups || []), ...parsed.groups];
    const dup = findDuplicateLiveAreaId(combined);
    if (dup) throw new Error(`live area id collision after merge: ${dup} — nothing written`);
    job.areaGroups = combined;
    job.updatedAt = new Date().toISOString();
    // ONE batch write through the app's write path (guards + rev stamp).
    const { writeBlob } = require('../api/_lib/blob');
    await writeBlob('jobs.json', data);
    console.log(`\nadded "${GROUP_NAME}" (${total} tasks) to job ${into} ("${job.name}") — live for whoever can see the job now`);
    // Best-effort PG mirror, matching the PUT path (dark by default; never fatal).
    try {
      const { mirrorJobToPg } = require('../api/_lib/jobs-mirror');
      await mirrorJobToPg(into);
    } catch { /* Blob is authoritative; the mirror must never fail the import */ }
    return;
  }

  // Create mode — the sanctioned single writer (validates again, mints ids,
  // writes jobs.json + seeds jobs/<id>/data.json, tags.json, temps.json).
  const { createJob } = require('../api/_lib/job-create');
  const result = await createJob(data, {
    name,
    status: 'draft',
    areaGroups: [buildGroup()],
  });
  if (!result.ok) throw new Error(`create failed (${result.status}): ${result.error}`);
  console.log(`\ncreated DRAFT job "${result.job.name}" (id: ${result.job.id}) with ${total} tasks.`);
  console.log(`review + publish it in the Job Builder: /v2/jobs/${result.job.id} — drafts are invisible to the field until published.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
