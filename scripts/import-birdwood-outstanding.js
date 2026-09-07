#!/usr/bin/env node
// One-off importer: the Birdwood Townhouses 1–7 outstanding-electrical
// checklist (owner walk-through, 2026-09) becomes REAL job structure the
// crew can tick in Phil. The data + structure builders live in
// api/_lib/birdwood-outstanding.js, shared with the owner-gated phone
// route GET /api/birdwood-import — run WHICHEVER is easier; both are
// idempotent and refuse a duplicate import. Delete all three files
// together once the import has run on production.
//
//   node --env-file=.env.local scripts/import-birdwood-outstanding.js
//     Dry run (default): validates the structure, prints the plan, lists
//     any existing job named like Birdwood so you can choose --into.
//     Writes NOTHING.
//
//   node --env-file=.env.local scripts/import-birdwood-outstanding.js --write
//     Creates a DRAFT job "Birdwood Townhouses 1–7" via api/_lib/job-create
//     (ids minted, per-job data.json/tags.json/temps.json seeded). Drafts
//     are invisible to the field — review in the Job Builder and publish.
//     (The phone route creates ACTIVE instead — it exists precisely so the
//     field can find the job immediately.)
//
//   node --env-file=.env.local scripts/import-birdwood-outstanding.js --write --into <jobId>
//     Adds the "Townhouses 1–7" group to an EXISTING job instead (use this
//     when the crew already logs hours/photos against a Birdwood job, so
//     tasks, hours and evidence stay on one job). One batch jobs.json write
//     (#117); the live-area-id invariant runs over the COMBINED structure
//     with the same shared guard every write path uses.
//
//   --name "..."  override the new job's name (create mode only)
//
// Requires BLOB_READ_WRITE_TOKEN (vercel env pull .env.local).

const { list } = require('@vercel/blob');
const {
  GROUP_NAME,
  DEFAULT_JOB_NAME,
  buildGroup,
  planCounts,
  findBirdwoodJobs,
  hasLiveBirdwoodGroup,
  addGroupToJob,
} = require('../api/_lib/birdwood-outstanding');
const { validateAreaGroups } = require('../api/_lib/validation');

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
  // same normalisation every create/PUT runs.
  const parsed = validateAreaGroups([buildGroup()], 'areaGroups');
  if (!parsed.ok) throw new Error(`structure invalid: ${parsed.error}`);

  const counts = planCounts();
  console.log(`plan: group "${GROUP_NAME}" · ${counts.townhouses.length} townhouse areas · ${counts.total} fit-off tasks (${counts.waiting} marked waiting)`);
  for (const th of counts.townhouses) {
    console.log(`  ${th.name}: ${th.tasks} tasks${th.waiting ? ` (${th.waiting} waiting)` : ''}`);
  }

  const data = await readJobsRegistry(token);
  const birdwoodish = findBirdwoodJobs(data.jobs);
  if (!into && birdwoodish.length) {
    console.log('\nexisting job(s) matching "birdwood" — consider --into <id> so tasks join the job the crew already uses:');
    for (const j of birdwoodish) console.log(`  ${j.id}  "${j.name}"  status=${j.status}`);
  }

  if (!write) {
    console.log(`\ndry-run — nothing written. Apply with:\n  --write                  create a DRAFT job "${name}"\n  --write --into <jobId>   add the group to an existing job`);
    return;
  }

  if (into) {
    const job = data.jobs.find((j) => j.id === into);
    if (!job) throw new Error(`--into ${into}: no job with that id`);
    if (hasLiveBirdwoodGroup(job)) {
      throw new Error(`job ${into} already has a live "${GROUP_NAME}" group — refusing a duplicate import`);
    }
    const added = addGroupToJob(job);
    if (!added.ok) throw new Error(`${added.error} — nothing written`);
    // ONE batch write through the app's write path (guards + rev stamp).
    const { writeBlob } = require('../api/_lib/blob');
    await writeBlob('jobs.json', data);
    console.log(`\nadded "${GROUP_NAME}" (${counts.total} tasks) to job ${into} ("${job.name}") — live for whoever can see the job now`);
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
  console.log(`\ncreated DRAFT job "${result.job.name}" (id: ${result.job.id}) with ${counts.total} tasks.`);
  console.log(`review + publish it in the Job Builder: /v2/jobs/${result.job.id} — drafts are invisible to the field until published.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
