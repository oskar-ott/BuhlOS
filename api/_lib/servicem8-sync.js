'use strict';

// ServiceM8 → BuhlOS daily job sync (the "job exists in ServiceM8 but not in
// BuhlOS, so nobody can log hours to it" fix).
//
// runServiceM8Sync():
//   1. pulls the active 'Work Order' jobs from ServiceM8 (read-only),
//   2. matches them against BuhlOS jobs — a ServiceM8 job counts as matched
//      when its uuid OR visible job number appears in any BuhlOS job's
//      `serviceM8JobId` or `ref` basics field (case/whitespace-insensitive),
//   3. AUTO-CREATES every unmatched one as an ACTIVE BuhlOS job through the
//      sanctioned createJob path (api/_lib/job-create.js — same validation,
//      seeds and PG mirror as the Job Builder), audit-logged as
//      source 'servicem8_sync',
//   4. writes the report blob (servicem8-sync.json) the command-centre card
//      renders: what was created, what failed, and — crucially — which
//      auto-created jobs still have NO assigned workers. Creation alone does
//      not make hours loggable: time-entries requires the job to be in the
//      worker's assignedJobIds, so the card keeps shouting until someone
//      assigns the crew.
//
// Honesty rules (P7): a ServiceM8 fetch failure is recorded as status 'error'
// (never a false "all matched"), and the cumulative auto-created list is
// preserved across failed runs so needs-assignment warnings don't vanish.

const { readBlob, writeBlob } = require('./blob');
const { createJob } = require('./job-create');
const { append: appendAuditLog } = require('./audit-log');
const { buildJobCreatedEntry } = require('./job-create-audit');
const { serviceM8Configured, fetchServiceM8ActiveJobs } = require('./servicem8');

const REPORT_KEY = 'servicem8-sync.json';

// Cumulative auto-created memory — enough for months of daily runs without
// letting the report blob grow forever.
const AUTO_CREATED_CAP = 200;

function normalizeExternalId(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/** Every external id a BuhlOS job answers to (serviceM8JobId + ref). */
function collectKnownExternalIds(buhlosJobs) {
  const known = new Set();
  for (const j of buhlosJobs || []) {
    const sm8 = normalizeExternalId(j && j.serviceM8JobId);
    if (sm8) known.add(sm8);
    const ref = normalizeExternalId(j && j.ref);
    if (ref) known.add(ref);
  }
  return known;
}

/** ServiceM8 jobs with no BuhlOS job carrying their uuid or number. Pure. */
function findUnmatched(sm8Jobs, buhlosJobs) {
  const known = collectKnownExternalIds(buhlosJobs);
  return (sm8Jobs || []).filter((s) => {
    const byUuid = normalizeExternalId(s.uuid);
    const byNumber = normalizeExternalId(s.number);
    if (byUuid && known.has(byUuid)) return false;
    if (byNumber && known.has(byNumber)) return false;
    return true;
  });
}

/** Human job name for an auto-created job: "Client — 12 Example St". */
function buildJobName(s) {
  const firstAddressLine = String(s.address || '').split('\n')[0].trim();
  const bits = [String(s.company || '').trim(), firstAddressLine].filter(Boolean);
  const base = bits.length
    ? bits.join(' — ')
    : `ServiceM8 job ${s.number || String(s.uuid || '').slice(0, 8)}`;
  return base.slice(0, 120);
}

/**
 * Auto-created jobs that a worker still can't log hours to: job still in a
 * live status but NO user has it in assignedJobIds. Pure.
 */
function computeNeedsAssignment(autoCreated, buhlosJobs, users) {
  const assigned = new Set();
  for (const u of users || []) {
    for (const id of (u && u.assignedJobIds) || []) assigned.add(id);
  }
  const jobById = new Map((buhlosJobs || []).map((j) => [j.id, j]));
  return (autoCreated || [])
    .filter((c) => {
      const job = jobById.get(c.id);
      if (!job) return false; // deleted since
      if (job.status !== 'active' && job.status !== 'on_hold') return false;
      return !assigned.has(c.id);
    })
    .map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Run the daily sync. Never throws — every outcome (skipped / error / ok) is
 * written to the report blob and returned.
 */
async function runServiceM8Sync(deps = {}) {
  const {
    env = process.env,
    fetchJobs = fetchServiceM8ActiveJobs,
    read = readBlob,
    write = writeBlob,
    create = createJob,
    appendAudit = appendAuditLog,
    now = () => new Date().toISOString(),
  } = deps;

  const previous = (await read(REPORT_KEY, null)) || {};
  const prevAutoCreated = Array.isArray(previous.autoCreated) ? previous.autoCreated : [];

  async function finish(report) {
    const full = { lastRun: now(), ...report };
    await write(REPORT_KEY, full);
    return full;
  }

  if (!serviceM8Configured(env)) {
    return finish({
      status: 'skipped',
      reason: 'SERVICEM8_API_KEY is not configured',
      autoCreated: prevAutoCreated,
      needsAssignment: Array.isArray(previous.needsAssignment) ? previous.needsAssignment : [],
    });
  }

  let sm8Jobs;
  try {
    sm8Jobs = await fetchJobs({ env });
  } catch (err) {
    return finish({
      status: 'error',
      error: (err && err.message) || 'ServiceM8 fetch failed',
      autoCreated: prevAutoCreated,
      needsAssignment: Array.isArray(previous.needsAssignment) ? previous.needsAssignment : [],
    });
  }

  const data = await read('jobs.json', { jobs: [] });
  const usersData = await read('users.json', { users: [] });

  const unmatched = findUnmatched(sm8Jobs, data.jobs);
  const created = [];
  const failed = [];

  for (const s of unmatched) {
    const input = {
      name: buildJobName(s),
      status: 'active',
      // Store the visible ServiceM8 job number (what the office reads on
      // screen); fall back to the uuid so the link is never empty. Matching
      // accepts either, so hand-entered links keep working too.
      serviceM8JobId: s.number || s.uuid,
      ...(s.number ? { ref: s.number } : {}),
      ...(s.address ? { siteAddress: s.address.slice(0, 240) } : {}),
    };
    // createJob mutates + persists jobs.json itself (the sanctioned path).
    let result = await create(data, input);
    if (!result.ok && result.error === 'job id already exists') {
      // Same client + address as an existing job slug — disambiguate with the
      // ServiceM8 number rather than dropping the job.
      result = await create(data, {
        ...input,
        id: `${input.name} sm8 ${s.number || String(s.uuid).slice(0, 8)}`,
      });
    }
    if (result.ok) {
      created.push({ id: result.job.id, name: result.job.name, sm8Number: s.number, sm8Uuid: s.uuid });
      await appendAudit(
        buildJobCreatedEntry({
          actor: { id: 'system', username: 'ServiceM8 sync' },
          job: result.job,
          source: 'servicem8_sync',
        }),
      ).catch(() => {});
    } else {
      failed.push({ name: input.name, sm8Number: s.number, sm8Uuid: s.uuid, error: result.error });
    }
  }

  const autoCreated = [
    ...prevAutoCreated,
    ...created.map((c) => ({ id: c.id, name: c.name, sm8Number: c.sm8Number, createdAt: now() })),
  ].slice(-AUTO_CREATED_CAP);

  return finish({
    status: 'ok',
    sm8Count: sm8Jobs.length,
    matchedCount: sm8Jobs.length - unmatched.length,
    created,
    failed,
    autoCreated,
    needsAssignment: computeNeedsAssignment(autoCreated, data.jobs, usersData.users),
  });
}

module.exports = {
  REPORT_KEY,
  normalizeExternalId,
  collectKnownExternalIds,
  findUnmatched,
  buildJobName,
  computeNeedsAssignment,
  runServiceM8Sync,
};
