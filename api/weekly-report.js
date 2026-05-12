// Weekly report endpoint for admins/leading hands.
//
//   GET /api/weekly-report?weekStart=YYYY-MM-DD
//
// Returns aggregated counts of hours, snags, and new jobs for the given
// Mon→Sun week. weekStart defaults to the current week's Monday (in Sydney).
//
// Response shape:
//   {
//     weekStart: '2026-05-11',
//     weekEnd:   '2026-05-17',
//     hours: {
//       submittedCount, submittedTotal,
//       approvedCount,  approvedTotal,
//       pendingCount,
//       byJob: [{ jobId, jobName, hours }]
//     },
//     snags: {
//       opened, resolved,
//       byJob: [{ jobId, jobName, opened, resolved }]
//     },
//     jobs: {
//       newJobs: [{ id, name, createdAt }]
//     }
//   }
//
// Permissions:
//   - admin:       all jobs counted; all per-user time entries counted
//   - leadingHand: only assigned jobs counted; only allocations to assigned
//                  jobs counted toward hours
//   - everyone else: 403
//
// Why this exists:
//   Daniel writes the Friday client email & runs the Monday planning meeting
//   off "what changed this week". The answer is scattered across snags,
//   hours and jobs blobs — this endpoint walks them once and hands back the
//   numbers ready for any UI (admin dashboard widget, weekly email, etc.).

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;

// Monday of the week containing the given date, in Sydney time. Returns YYYY-MM-DD.
function sydneyMonday(d) {
  // Format the date in Sydney to grab the local calendar day, then back out
  // the weekday by constructing the Sydney-local midnight.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(d);
  const parts = {};
  for (const p of fmt) parts[p.type] = p.value;
  // weekday: 'Mon','Tue','Wed','Thu','Fri','Sat','Sun'
  const wd = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[parts.weekday] ?? 0;
  // Compute Monday of the local week as a UTC-encoded YYYY-MM-DD; we don't
  // need precise tz arithmetic, just the calendar day label.
  const local = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  const monday = new Date(local.getTime() - wd * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

function addDaysISO(yyyymmdd, n) {
  const t = new Date(`${yyyymmdd}T00:00:00Z`).getTime() + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!['admin', 'leadingHand'].includes(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Resolve week window — default current week's Monday (Sydney).
  let weekStart = (req.query && req.query.weekStart) || sydneyMonday(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
  }
  const weekEnd = addDaysISO(weekStart, 6); // inclusive Sun
  const dateInWindow = (yyyymmdd) =>
    yyyymmdd >= weekStart && yyyymmdd <= weekEnd;

  // Visible jobs for this user.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs = jobsBlob.jobs || [];
  const visible = (me.role === 'admin')
    ? allJobs
    : allJobs.filter(j => (me.assignedJobIds || []).includes(j.id));
  const visibleIds = new Set(visible.map(j => j.id));
  const jobNameById = {};
  for (const j of visible) jobNameById[j.id] = j.name;

  // ── Hours ──────────────────────────────────────────────────────────────
  // Walk per-user time-entries blobs in one list call, filter to filenames
  // matching dates within the window. For LHs, filter allocations down to
  // their visible jobs only.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let hoursBlobs = [];
  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    hoursBlobs = (r.blobs || []).filter(b => {
      const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      return m && dateInWindow(m[1]);
    });
  } catch (e) {
    console.error('weekly-report: blob list failed', e);
  }

  const hours = {
    submittedCount: 0, submittedTotal: 0,
    approvedCount:  0, approvedTotal:  0,
    pendingCount:   0,
    byJob: [],
  };
  const hoursByJob = {}; // jobId → totalHours (approved+submitted, allocated-only)

  await Promise.all(hoursBlobs.map(async b => {
    let entry;
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      entry = await r.json();
    } catch { return; }
    if (!entry) return;

    // For LH role, restrict to allocations that hit a visible job; admin
    // sees everything.
    const allocs = (entry.allocations || []).filter(a =>
      me.role === 'admin' || (a.jobId && visibleIds.has(a.jobId)));
    if (!allocs.length) return;

    const totalForWindow = allocs.reduce((s, a) => s + (Number(a.hours) || 0), 0);
    if (totalForWindow <= 0) return;

    if (entry.status === 'submitted') {
      hours.submittedCount++;
      hours.submittedTotal += totalForWindow;
      hours.pendingCount++;
    } else if (entry.status === 'approved') {
      hours.approvedCount++;
      hours.approvedTotal += totalForWindow;
    }

    if (entry.status === 'submitted' || entry.status === 'approved') {
      for (const a of allocs) {
        if (!a.jobId) continue;
        hoursByJob[a.jobId] = (hoursByJob[a.jobId] || 0) + (Number(a.hours) || 0);
      }
    }
  }));

  hours.byJob = Object.entries(hoursByJob)
    .map(([jobId, h]) => ({
      jobId,
      jobName: jobNameById[jobId] || jobId,
      hours: Math.round(h * 100) / 100,
    }))
    .sort((a, b) => b.hours - a.hours);

  // Round totals to 1 decimal for response.
  hours.submittedTotal = Math.round(hours.submittedTotal * 10) / 10;
  hours.approvedTotal  = Math.round(hours.approvedTotal  * 10) / 10;

  // ── Snags ──────────────────────────────────────────────────────────────
  const snags = { opened: 0, resolved: 0, byJob: [] };
  const snagsByJob = {}; // jobId → { opened, resolved }

  for (const j of visible) {
    let d;
    try { d = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
    catch { continue; }
    let opened = 0, resolved = 0;
    for (const s of (d.snags || [])) {
      const created = (s.createdAt || s.date || '').slice(0, 10);
      const closed  = (s.closedAt  || '').slice(0, 10);
      if (created && dateInWindow(created)) opened++;
      if (closed  && dateInWindow(closed))  resolved++;
    }
    if (opened || resolved) {
      snagsByJob[j.id] = { opened, resolved };
      snags.opened   += opened;
      snags.resolved += resolved;
    }
  }

  snags.byJob = Object.entries(snagsByJob)
    .map(([jobId, c]) => ({
      jobId,
      jobName: jobNameById[jobId] || jobId,
      opened:   c.opened,
      resolved: c.resolved,
    }))
    .sort((a, b) => (b.opened + b.resolved) - (a.opened + a.resolved));

  // ── New jobs created this week ─────────────────────────────────────────
  const newJobs = visible
    .filter(j => {
      const c = (j.createdAt || '').slice(0, 10);
      return c && dateInWindow(c);
    })
    .map(j => ({ id: j.id, name: j.name, createdAt: j.createdAt }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  return res.status(200).json({
    weekStart, weekEnd,
    hours,
    snags,
    jobs: { newJobs },
  });
};
