// Client portal sanitisation boundary (Epic 16 / #271).
//
// This is the ONE place that decides what a client is allowed to see about a
// job. Every portal endpoint (api/portal-jobs.js, api/portal-job.js) projects
// a raw job through here, so the client-safe allowlist can never drift between
// the list view and the single-job view.
//
// CONSERVATIVE ALLOWLIST (P7 — no fake data, no leaks). A client sees ONLY:
//   - id            job identifier (needed to open the job)
//   - name          the job name
//   - siteAddress   the site address (their own site — client-appropriate)
//   - status        high-level status; only 'active' jobs are ever projected
//                   for a client (draft/archived/complete are filtered upstream
//                   AND defended here), so this is effectively always 'active'
//   - progressPct   overall completion %, from the CANONICAL pooled task counts
//                   (api/_lib/job-tasks.js jobTaskCounts — the #198 definition
//                   production /v2/jobs uses), or null when the job has no
//                   checklist yet (render "not started", never a fake 0%)
//   - stageLabel    a coarse, DERIVED phase word ('Not started' / 'In progress'
//                   / 'Complete') computed from progressPct — not a stored
//                   field, not fabricated; purely a function of the real number
//
// DELIBERATELY EXCLUDED (leave out when unsure): money / margin / costs /
// quotes; internal + access + parking notes; assignee / crew / worker names or
// any worker PII; raw dwellings, task detail, evidence, snag descriptions,
// observations, RFIs, ITP instances, diary, plans; job.ref (internal office
// reference); clientUserId; dates; job type (kept out of the foundation — a
// content decision for a later child). Anything not on the allowlist above is
// absent from the response by construction (we build a fresh object, never
// spread the raw job).

const { jobTaskCounts } = require('./job-tasks');

// Only 'active' jobs are shown to clients. Kept here as the single definition so
// endpoints and tests agree.
function isClientVisibleStatus(status) {
  const s = status || 'active';
  return s !== 'draft' && s !== 'archived' && s !== 'complete';
}

// Overall completion % from the canonical pooled task counts, or null when the
// job carries no applicable checklist (caller/UI renders "not started", never a
// misleading 0%). Mirrors the #198 definition in src/domains/jobs/progress.ts.
function overallProgressPct(job, dwellings) {
  const c = jobTaskCounts(job, dwellings || {});
  if (!c.total) return null;
  return Math.round((c.complete / c.total) * 100);
}

// A coarse, human phase word derived purely from progressPct. Not stored, not
// fabricated — a deterministic function of the real number.
function stageLabelFor(progressPct) {
  if (progressPct === null || progressPct === undefined) return 'Not started';
  if (progressPct <= 0) return 'Not started';
  if (progressPct >= 100) return 'Complete';
  return 'In progress';
}

// Build the client-safe view of ONE job. `dwellings` is the job's
// jobs/<id>/data.json dwellings map (for progress); pass {} if unavailable.
// Returns null for a job a client must never see (wrong status) so callers
// can't accidentally serialise it.
function projectJobForClient(job, dwellings) {
  if (!job || !isClientVisibleStatus(job.status)) return null;
  const progressPct = overallProgressPct(job, dwellings);
  return {
    id: job.id,
    name: job.name || '',
    siteAddress: job.siteAddress || null,
    status: job.status || 'active',
    progressPct,
    stageLabel: stageLabelFor(progressPct),
  };
}

module.exports = {
  isClientVisibleStatus,
  overallProgressPct,
  stageLabelFor,
  projectJobForClient,
};
