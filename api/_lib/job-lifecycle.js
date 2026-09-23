// Job lifecycle — THE one place that says what a job's status means over time.
//
// A job has one stored `status` (draft · active · on_hold · complete ·
// archived — schema.ts JOB_STATUSES). Marking it `complete` stamps
// `completedAt`; everything after that is DERIVED here from the stored fields
// and today's date, never from a cron or a client timer:
//
//   status            phase        crew see it in their lists?   crew can log to it?
//   draft             draft        no (office-only)              no
//   active            active       yes                           yes
//   on_hold           on_hold      yes (paused)                  yes
//   complete, within  finishing    yes — "Finished, log until…"  yes (the callback window)
//     GRACE_DAYS of completedAt
//   complete, later   closed       no — found by search only     yes, by deliberate pick
//   archived          archived     no (office history only)     no
//
// Why derive: "finishing" and "closed" are the SAME stored fact (complete on
// a date) read at two moments. Storing them separately would need a sweep to
// flip one into the other and would drift the day the sweep failed.
//
// Nothing here deletes or rewrites data: closing a job changes what the crew
// see by default, never what exists (docs/job-lifecycle.md).

/** Days after `completedAt` during which a finished job stays in the crew's
 *  normal lists and pickers — long enough for defects, commissioning and the
 *  forgotten item; short enough that last year's jobs don't crowd today's. */
const GRACE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIso(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** ISO instant the callback window ends, or null when not `complete`. A
 *  `complete` job with no `completedAt` (set through the raw status field
 *  before stamping existed) has no window — it reads as closed. */
function graceEndsAt(job) {
  if (!job || job.status !== 'complete') return null;
  const t = parseIso(job.completedAt);
  if (t == null) return null;
  return new Date(t + GRACE_DAYS * DAY_MS).toISOString();
}

/**
 * The job's lifecycle phase at `now` (Date | ISO string; defaults to the real
 * clock). Missing status reads as active (the legacy-row rule in format.ts).
 * @returns {'draft'|'active'|'on_hold'|'finishing'|'closed'|'archived'}
 */
function jobPhase(job, now) {
  const status = (job && job.status) || 'active';
  if (status === 'complete') {
    const ends = graceEndsAt(job);
    if (!ends) return 'closed';
    const t = now == null ? Date.now() : now instanceof Date ? now.getTime() : parseIso(now);
    return t != null && t < Date.parse(ends) ? 'finishing' : 'closed';
  }
  if (status === 'draft' || status === 'on_hold' || status === 'archived') return status;
  return 'active';
}

/** In the crew's DEFAULT lists and pickers (the Jobs tab, the hours dial). */
function isFieldListedByDefault(job, now) {
  const p = jobPhase(job, now);
  return p === 'active' || p === 'on_hold' || p === 'finishing';
}

/** Can a crew member OPEN the job at all (by list, search or a saved link)?
 *  Closed jobs stay openable — that is how a callback finds its job. */
function isFieldOpenable(job) {
  const status = (job && job.status) || 'active';
  return status !== 'draft' && status !== 'archived';
}

/** Can hours be attributed to this job? Same rule as isFieldOpenable — a
 *  finished job still takes callback hours; archived and draft never do. */
function acceptsHours(job) {
  return isFieldOpenable(job);
}

/** The stamps a status change writes. Pure: returns the fields to merge, or
 *  null when nothing lifecycle-relevant changed. `now` is an ISO string. */
function lifecycleStamps(before, after, now) {
  const from = (before && before.status) || 'active';
  const to = after || 'active';
  if (from === to) return null;
  if (to === 'complete') {
    return { completedAt: now, journal: 'job.closed' };
  }
  if (from === 'complete') {
    return { reopenedAt: now, journal: 'job.reopened' };
  }
  return null;
}

/** Search-only: does `q` match the job by name, IV code, legacy ref or street? */
function jobMatchesQuery(job, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return false;
  return [job.name, job.code, job.ref, job.siteAddress].some(
    (f) => typeof f === 'string' && f.toLowerCase().includes(needle)
  );
}

module.exports = {
  GRACE_DAYS,
  graceEndsAt,
  jobPhase,
  isFieldListedByDefault,
  isFieldOpenable,
  acceptsHours,
  lifecycleStamps,
  jobMatchesQuery,
};
