// ONE-OFF owner import: the Birdwood Townhouses 1–7 outstanding-electrical
// checklist becomes real, tickable job structure — from the owner's PHONE,
// no laptop/token needed. Delete this route (with api/_lib/birdwood-
// outstanding.js and scripts/import-birdwood-outstanding.js) once the
// import has run on production.
//
//   GET /api/birdwood-import                  → DRY RUN: the plan + the
//       chosen mode (which existing job it would add to, or that it would
//       create a new job). Writes nothing.
//   GET /api/birdwood-import?confirm=import   → applies the plan.
//   …&into=<jobId>                            → force a specific target job.
//
// Owner-only, same authoritative boundary as /api/owner: requireAuth
// (HMAC-verified, fresh users.json) then canAccessOwnerConsole. Fails
// CLOSED (401 unauth, 403 non-owner). GET-with-confirm is the deliberate
// phone-tap ergonomic for this one-off (precedent: the auth-gated GET cron
// mutations); the no-param call stays a pure dry run.
//
// Mode is resolved fail-closed from the real registry:
//   * ?into=<id>                        → that job (404 when missing);
//   * exactly one ACTIVE Birdwood job   → add the group to it (tasks join
//     the job the crew already logs hours/photos against);
//   * NO job named like Birdwood at all → create the job via the sanctioned
//     single writer (api/_lib/job-create), status ACTIVE — the whole point
//     is that the field can find it now;
//   * anything else (several matches, or only draft/held ones) → 409
//     listing the candidates; pick one with ?into=.
// Re-runs are safe: a live "Townhouses 1–7" group on the target →
// alreadyImported, nothing written.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canAccessOwnerConsole } = require('./_lib/auth');
const {
  GROUP_NAME,
  DEFAULT_JOB_NAME,
  buildGroup,
  planCounts,
  findBirdwoodJobs,
  hasLiveBirdwoodGroup,
  addGroupToJob,
} = require('./_lib/birdwood-outstanding');

module.exports = async function handler(req, res) {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const me = await requireAuth(req, res, {});
  if (!me) return; // 401 already sent
  if (!canAccessOwnerConsole(me)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const confirm = (req.query && req.query.confirm) === 'import';
  const intoParam = req.query && typeof req.query.into === 'string' ? req.query.into : '';

  const data = await readBlob('jobs.json', { jobs: [] });
  // Never operate on a default/empty registry — a bad read must not be able
  // to turn "import one job" into "replace the registry".
  if (!Array.isArray(data.jobs) || data.jobs.length === 0) {
    return res.status(500).json({ ok: false, error: 'jobs.json read back empty — refusing to write' });
  }

  const counts = planCounts();
  const matches = findBirdwoodJobs(data.jobs);
  const asOption = (j) => ({ id: j.id, name: j.name, status: j.status });

  // ── Resolve the target ────────────────────────────────────────────────
  let mode; // 'into' | 'create'
  let target = null;
  if (intoParam) {
    target = data.jobs.find((j) => j.id === intoParam) || null;
    if (!target) return res.status(404).json({ ok: false, error: `no job with id ${intoParam}` });
    mode = 'into';
  } else {
    const active = matches.filter((j) => j.status === 'active');
    if (active.length === 1) {
      mode = 'into';
      target = active[0];
    } else if (matches.length === 0) {
      mode = 'create';
    } else {
      return res.status(409).json({
        ok: false,
        error: 'more than one (or only a non-active) Birdwood job exists — pick the target with ?into=<id>',
        candidates: matches.map(asOption),
      });
    }
  }

  // Re-run guard on the resolved target (create mode checks the created
  // job's would-be collision inside createJob itself).
  if (target && hasLiveBirdwoodGroup(target)) {
    return res.status(200).json({
      ok: true,
      alreadyImported: true,
      jobId: target.id,
      jobName: target.name,
      philUrl: `/phil/jobs/${target.id}`,
    });
  }

  if (!confirm) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      mode,
      ...(target ? { target: asOption(target) } : { wouldCreate: DEFAULT_JOB_NAME }),
      plan: counts,
      apply: '/api/birdwood-import?confirm=import' + (intoParam ? `&into=${intoParam}` : ''),
    });
  }

  // ── Apply ─────────────────────────────────────────────────────────────
  if (mode === 'into') {
    const added = addGroupToJob(target);
    if (!added.ok) return res.status(400).json({ ok: false, error: added.error });
    // ONE batch jobs.json write through the app's write path (#117).
    await writeBlob('jobs.json', data);
    // Best-effort PG mirror, matching the PUT path (dark by default).
    try {
      const { mirrorJobToPg } = require('./_lib/jobs-mirror');
      await mirrorJobToPg(target.id);
    } catch { /* Blob is authoritative; the mirror never fails the import */ }
    return res.status(200).json({
      ok: true,
      mode,
      jobId: target.id,
      jobName: target.name,
      group: GROUP_NAME,
      tasks: counts.total,
      waiting: counts.waiting,
      philUrl: `/phil/jobs/${target.id}`,
    });
  }

  // create mode — the sanctioned single writer (validates, mints ids, writes
  // jobs.json + seeds jobs/<id>/data.json, tags.json, temps.json).
  const { createJob } = require('./_lib/job-create');
  const result = await createJob(data, {
    name: DEFAULT_JOB_NAME,
    status: 'active',
    areaGroups: [buildGroup()],
  });
  if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
  return res.status(200).json({
    ok: true,
    mode,
    jobId: result.job.id,
    jobName: result.job.name,
    group: GROUP_NAME,
    tasks: counts.total,
    waiting: counts.waiting,
    philUrl: `/phil/jobs/${result.job.id}`,
  });
};
