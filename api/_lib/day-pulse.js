// Company day-pulse aggregation — extracted VERBATIM from api/today-pulse.js
// (#170) so the endpoint and the AI assistant's `company_day_pulse` tool run
// the SAME numbers (one engine, two consumers), instead of the tool
// re-implementing the walk.
//
// Visibility is viewer-scoped exactly as the endpoint always did: admin tier
// sees the whole company; a leading hand sees only assigned jobs. Callers gate
// WHO may ask (the endpoint gates staff; the AI tool gates admin-tier) — this
// module only scopes WHAT the viewer sees.
//
// Cost: 1 jobs.json read + 1 blob list on users/ + N parallel per-active-job
// data.json reads. Same cost shape as the digest cron.

const { list } = require('@vercel/blob');
const { readBlob } = require('./blob');
const { isAdminRole } = require('./auth');

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * @param {{ role?: string, assignedJobIds?: string[] }} viewer
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<{date: string, hours: object, snags: object, jobs: object}>}
 */
async function computeDayPulse(viewer, date) {
  // Resolve which jobs this user can see (LH gets a subset).
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs  = jobsBlob.jobs || [];
  const active   = allJobs.filter(j => (j.status || 'active') === 'active');
  // Tier-aware (not literal 'admin'): office/boss/PM see the whole company's
  // pulse; leading hands stay scoped to their jobs (#123).
  const meIsAdminTier = isAdminRole(viewer.role);
  const visible  = meIsAdminTier
    ? active
    : active.filter(j => (viewer.assignedJobIds || []).includes(j.id));
  const visibleIds = new Set(visible.map(j => j.id));

  // ── Hours: walk per-user time-entries for the date ────────────────────
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let hours = {
    submittedCount: 0, submittedTotal: 0,
    approvedCount:  0, approvedTotal:  0,
    pendingCount:   0, draftCount:     0,
    crewOnSite:     0,
  };
  const crewSet = new Set();
  const jobsWithHoursToday = new Set();

  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    const blobs = (r.blobs || []).filter(b =>
      b.pathname.endsWith(`/time-entries/${date}.json`));

    const entries = (await Promise.all(blobs.map(async b => {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) return null;
        return await rr.json();
      } catch { return null; }
    }))).filter(Boolean);

    for (const e of entries) {
      // LH-visibility filter on allocations.
      const allocs = (e.allocations || []).filter(a =>
        meIsAdminTier || (a.jobId && visibleIds.has(a.jobId)));
      if (!allocs.length) continue;

      const allocHours = allocs.reduce((s, a) => s + (Number(a.hours) || 0), 0);
      if (allocHours <= 0) continue;

      if (e.status === 'submitted') {
        hours.submittedCount++;
        hours.submittedTotal += allocHours;
        hours.pendingCount++;
      } else if (e.status === 'approved') {
        hours.approvedCount++;
        hours.approvedTotal += allocHours;
      } else if (e.status === 'draft') {
        hours.draftCount++;
      }
      if (e.userId) crewSet.add(e.userId);
      for (const a of allocs) if (a.jobId) jobsWithHoursToday.add(a.jobId);
    }
  } catch (err) { console.error('day-pulse: hours walk failed', err); }

  hours.crewOnSite      = crewSet.size;
  hours.submittedTotal  = Math.round(hours.submittedTotal * 10) / 10;
  hours.approvedTotal   = Math.round(hours.approvedTotal  * 10) / 10;

  // ── Snags: per active job, count opened / resolved on `date` ──────────
  let openedToday = 0;
  let resolvedToday = 0;
  const jobsWithSnagsToday = new Set();

  await Promise.all(visible.map(async j => {
    let data;
    try { data = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
    catch { return; }
    let any = false;
    for (const s of (data.snags || [])) {
      const created = (s.createdAt || s.date || '').slice(0, 10);
      const closed  = (s.closedAt  || '').slice(0, 10);
      if (created === date) { openedToday++; any = true; }
      if (closed  === date) { resolvedToday++; any = true; }
    }
    if (any) jobsWithSnagsToday.add(j.id);
  }));

  const jobsWithActivityToday = new Set([
    ...jobsWithHoursToday, ...jobsWithSnagsToday,
  ]).size;

  return {
    date,
    hours,
    snags: { openedToday, resolvedToday },
    jobs: {
      activeJobs: visible.length,
      jobsWithActivityToday,
    },
  };
}

module.exports = { computeDayPulse, sydneyToday };
