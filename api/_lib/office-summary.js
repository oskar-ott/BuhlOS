// #171 — office daily summary of yesterday across jobs (pure stage).
//
// Deterministic fact-gathering for the morning "what happened yesterday"
// summary. EVERYTHING here is computable with zero AI (P7 — no invented
// numbers): the handler (api/office-daily-summary.js) fetches the raw
// sources and this module does the maths + the deterministic wording. The
// model, when configured, only REPHRASES the facts this module produced —
// the two-stage honesty contract the #347 insights digest established.
//
// Partial-failure honesty (#171 requirement 2): the digest cron swallows
// per-blob fetch errors, which is fine for a one-line push but not for an
// auditable document. Callers pass what they could and could not read;
// coverage records the gaps so partial data is never presented as complete.

/**
 * The previous calendar day of a YYYY-MM-DD date string. Pure calendar
 * maths at UTC noon — no wall-clock time is ever consulted, so DST cannot
 * shift the result. The *Sydney* part comes from the caller deriving
 * `today` via sydneyToday() (Intl, Australia/Sydney) — this function only
 * steps the calendar back one day.
 */
function previousCalendarDay(today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(today));
  if (!m) throw new Error(`previousCalendarDay: invalid date "${today}"`);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function summaryKey(date) {
  return `analytics/office-summaries/${date}.json`;
}

/** Whole days between two YYYY-MM-DD strings (asOf - from), floored at 0. */
function daysBetween(fromDate, asOfDate) {
  const from = Date.parse(String(fromDate).slice(0, 10) + 'T00:00:00Z');
  const asOf = Date.parse(String(asOfDate).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(from) || !Number.isFinite(asOf)) return 0;
  return Math.max(0, Math.round((asOf - from) / 86400000));
}

const OUTSTANDING_BLOCKERS_CAP = 5;

/** The honest statement of what this summary does and does not read. */
const COVERAGE = {
  sees: [
    'submitted/approved hours for the day (per-user time-entry blobs)',
    'snags opened/closed and evidence captured on scanned active jobs',
    'blocker observations raised/resolved, plus ones still waiting',
  ],
  doesNotSee: [
    'draft hours',
    'draft or archived jobs',
    'material requests, RFIs, variations, ITPs or quotes',
  ],
};

function dayOf(value) {
  return String(value || '').slice(0, 10);
}

/**
 * Aggregate one Sydney calendar day of activity into a fact table.
 * Pure — callers do the IO and pass what they read (and what they failed
 * to read). Never invents a number.
 *
 * @param {{
 *   date: string,
 *   jobs: Array<object>,          // raw jobs.json jobs
 *   users: Array<object>,         // raw users.json users (for names)
 *   entries: Array<object>,       // the day's per-user time-entry docs
 *   observations: Array<object>,  // raw observations.json items
 *   perJobData: Array<{jobId: string, data: object|null}>, // scanned active jobs; data null = unreadable
 *   entriesUnreadable?: number,   // day-entry blobs that could not be read
 * }} input
 */
function collectOfficeFacts({ date, jobs, users, entries, observations, perJobData, entriesUnreadable = 0 }) {
  const activeJobs = (jobs || []).filter((j) => j && (j.status || 'active') === 'active');
  const jobNames = new Map(activeJobs.map((j) => [j.id, j.name || j.id]));
  const userNames = new Map((users || []).map((u) => [u.id, u.name || u.username || 'Unknown']));

  // Per-job accumulators, keyed by active-job id.
  const perJob = new Map();
  function jobAcc(jobId) {
    if (!perJob.has(jobId)) {
      perJob.set(jobId, {
        jobId,
        jobName: jobNames.get(jobId) || jobId,
        ref: { store: 'jobs', id: jobId },
        hours: 0,
        workerNames: [],
        snagsOpened: 0,
        snagsClosed: 0,
        evidenceCaptured: 0,
        blockersRaised: 0,
      });
    }
    return perJob.get(jobId);
  }

  // ── Hours: submitted/approved entries for the day ──────────────────────
  let hoursLogged = 0;
  let entryCount = 0;
  let pendingCount = 0;
  const workerIds = new Set();
  for (const e of entries || []) {
    if (!e || (e.status !== 'submitted' && e.status !== 'approved')) continue;
    entryCount++;
    if (e.status === 'submitted') pendingCount++;
    if (e.userId) workerIds.add(e.userId);
    const name = userNames.get(e.userId) || 'Unknown';
    for (const a of Array.isArray(e.allocations) ? e.allocations : []) {
      const h = Number(a && a.hours) || 0;
      if (h <= 0) continue;
      hoursLogged += h;
      if (a.jobId && jobNames.has(a.jobId)) {
        const acc = jobAcc(a.jobId);
        acc.hours += h;
        if (!acc.workerNames.includes(name)) acc.workerNames.push(name);
      }
    }
  }
  hoursLogged = Math.round(hoursLogged * 10) / 10;

  // ── Snags + evidence: per scanned active job ───────────────────────────
  let snagsOpened = 0;
  let snagsClosed = 0;
  let evidenceCaptured = 0;
  let jobsUnreadable = 0;
  for (const { jobId, data } of perJobData || []) {
    if (!data) {
      jobsUnreadable++;
      continue;
    }
    // Both per-job snag stores (legacy snags[] + snagsV2[]), same fields the
    // day-pulse/digest walks read.
    for (const arr of [data.snags, data.snagsV2]) {
      for (const s of Array.isArray(arr) ? arr : []) {
        if (!s) continue;
        if (dayOf(s.createdAt || s.date) === date) {
          snagsOpened++;
          jobAcc(jobId).snagsOpened++;
        }
        if (dayOf(s.closedAt) === date) {
          snagsClosed++;
          jobAcc(jobId).snagsClosed++;
        }
      }
    }
    for (const ev of Array.isArray(data.evidence) ? data.evidence : []) {
      if (ev && dayOf(ev.capturedAt) === date) {
        evidenceCaptured++;
        jobAcc(jobId).evidenceCaptured++;
      }
    }
  }

  // ── Blockers: observations of type 'blocker' ───────────────────────────
  let blockersRaised = 0;
  let blockersResolved = 0;
  const outstanding = [];
  for (const o of observations || []) {
    if (!o || o.type !== 'blocker') continue;
    if (dayOf(o.createdAt) === date) {
      blockersRaised++;
      if (o.jobId && jobNames.has(o.jobId)) jobAcc(o.jobId).blockersRaised++;
    }
    if (dayOf(o.resolvedAt) === date) blockersResolved++;
    if (o.status === 'new' || o.status === 'needs_action') {
      outstanding.push({
        id: o.id,
        ref: { store: 'observations', id: o.id },
        jobId: o.jobId || null,
        jobName: o.jobName || (o.jobId ? jobNames.get(o.jobId) || o.jobId : null),
        title: o.title || 'Blocker',
        ageDays: daysBetween(o.createdAt, date),
      });
    }
  }
  outstanding.sort((a, b) => b.ageDays - a.ageDays);
  const blockersOutstanding = outstanding.slice(0, OUTSTANDING_BLOCKERS_CAP);

  // ── Job lines: activity only; the quiet ones are named, not faked ──────
  const jobLines = [...perJob.values()]
    .filter(
      (j) =>
        j.hours > 0 || j.snagsOpened > 0 || j.snagsClosed > 0 || j.evidenceCaptured > 0 || j.blockersRaised > 0
    )
    .map((j) => ({ ...j, hours: Math.round(j.hours * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours || a.jobName.localeCompare(b.jobName));
  const activeWithLine = new Set(jobLines.map((j) => j.jobId));
  const quietJobs = (perJobData || [])
    .filter(({ jobId, data }) => data && !activeWithLine.has(jobId))
    .map(({ jobId }) => ({ jobId, jobName: jobNames.get(jobId) || jobId }));

  const quietDay =
    entryCount === 0 &&
    snagsOpened === 0 &&
    snagsClosed === 0 &&
    evidenceCaptured === 0 &&
    blockersRaised === 0 &&
    blockersResolved === 0;

  return {
    date,
    totals: {
      hoursLogged,
      entryCount,
      pendingCount,
      workerCount: workerIds.size,
      snagsOpened,
      snagsClosed,
      evidenceCaptured,
      blockersRaised,
      blockersResolved,
      blockersOutstanding: outstanding.length,
      jobsWithActivity: jobLines.length,
      activeJobs: activeJobs.length,
    },
    jobs: jobLines,
    quietJobs,
    blockersOutstanding,
    quietDay,
    coverage: {
      ...COVERAGE,
      scannedJobs: (perJobData || []).length,
      totalActiveJobs: activeJobs.length,
      jobsUnreadable,
      entriesUnreadable,
    },
  };
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * The deterministic wording — every sentence comes straight off the fact
 * table. This is what renders when the model is unconfigured, fails, or
 * utters a number the facts can't ground: AI absence degrades to facts,
 * never to nothing and never to fakes.
 * @returns {Array<{text: string, href: string}>}
 */
function renderDeterministicLines(facts) {
  const t = facts.totals;
  const lines = [];
  if (facts.quietDay) {
    lines.push({
      text: `No activity was recorded on ${facts.date} — no hours, snags, evidence or blockers across ${t.activeJobs} active ${plural(t.activeJobs, 'job', 'jobs')}.`,
      href: '/command-centre',
    });
  } else {
    lines.push({
      text: `${t.workerCount} ${plural(t.workerCount, 'worker', 'workers')} logged ${t.hoursLogged}h across ${t.jobsWithActivity} ${plural(t.jobsWithActivity, 'job', 'jobs')}.`,
      href: '/hours',
    });
    for (const j of facts.jobs) {
      const bits = [];
      if (j.hours > 0) bits.push(`${j.hours}h (${j.workerNames.join(', ')})`);
      if (j.snagsOpened > 0) bits.push(`${j.snagsOpened} ${plural(j.snagsOpened, 'snag', 'snags')} opened`);
      if (j.snagsClosed > 0) bits.push(`${j.snagsClosed} closed`);
      if (j.evidenceCaptured > 0)
        bits.push(`${j.evidenceCaptured} ${plural(j.evidenceCaptured, 'photo/proof', 'photos/proofs')} captured`);
      if (j.blockersRaised > 0)
        bits.push(`${j.blockersRaised} ${plural(j.blockersRaised, 'blocker', 'blockers')} raised`);
      lines.push({ text: `${j.jobName} — ${bits.join(' · ')}.`, href: `/v2/jobs/${j.jobId}` });
    }
    if (t.pendingCount > 0) {
      lines.push({
        text: `${t.pendingCount} ${plural(t.pendingCount, 'timesheet', 'timesheets')} still waiting for approval.`,
        href: '/hours/approvals',
      });
    }
  }
  if (t.blockersOutstanding > 0) {
    const oldest = facts.blockersOutstanding[0];
    lines.push({
      text: `${t.blockersOutstanding} ${plural(t.blockersOutstanding, 'blocker', 'blockers')} still open${oldest ? ` — oldest ${oldest.ageDays} ${plural(oldest.ageDays, 'day', 'days')} (${oldest.title})` : ''}.`,
      href: '/observations',
    });
  }
  return lines;
}

module.exports = {
  previousCalendarDay,
  summaryKey,
  collectOfficeFacts,
  renderDeterministicLines,
  COVERAGE,
  OUTSTANDING_BLOCKERS_CAP,
};
