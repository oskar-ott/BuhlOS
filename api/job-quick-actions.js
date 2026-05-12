// Job-page contextual quick actions for the mobile tradie/LH view.
//
//   GET /api/job-quick-actions?jobId=<id>&limit=3
//
// Looks at the current user's state on this job and returns an ordered
// list of "what would I do next?" actions. The mobile job page renders
// these as a quick-action tray under the header.
//
// The action rule book (priority high → low):
//
//   1. rejected-hours   recent rejected hours entry referencing this job
//                       → "Fix rejected hours from <date>"
//   2. draft-hours      today's entry is in draft with hours on this job
//                       → "Submit your hours (X.Xh)"
//   3. high-snags       open assigned snags marked High
//                       → "N high-priority snag(s) need attention"
//   4. snags-no-photo   open assigned snags with zero photos
//                       → "Add photos to N snag(s)"
//   5. old-snags        open assigned snags > 7 days old
//                       → "N snag(s) overdue (oldest Nd)"
//   6. log-hours        no time-entry today + at least one allocation
//                       to this job in the last 14 days
//                       → "Log today's hours"
//   7. continue-area    a dwelling with progress > 0 but < 100
//                       → "Continue [area name] (Nd% complete)"
//
// Results are sorted by priority, capped to `limit` (default 3, max 5).
// Each action has { type, label, url, meta }.
//
// Permissions:
//   - admin / leadingHand / tradie with write access (canWrite)
//   - client: 403
//
// Cost: 1 jobs.json + 1 data.json + 1 read of my today's time-entry +
//       1 list call on my users/<me>/time-entries/ prefix for recent.
// Bounded by recent-entry count for one user — cheap.

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAG_OLD_DAYS = 7;

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Pretty date "Mon 11 May" — matches the format the payroll reminder uses.
function prettyDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(yyyymmdd + 'T00:00:00Z'));
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 3;
  if (limit > 5) limit = 5;

  const me = await requireAuth(req, res, { jobId });
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (!canWrite(me, jobId) && me.role !== 'admin') {
    return res.status(403).json({ error: 'no access to job' });
  }

  const today = sydneyToday();
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const data = await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [] });

  // ── Snags assigned to me, scoped to this job ─────────────────────────
  const now = Date.now();
  const myOpenSnags = [];
  for (const s of (data.snags || [])) {
    if ((s.status || 'Open') !== 'Open') continue;
    if (s.assignedToUserId !== me.id) continue;
    const created = s.createdAt || s.date || '';
    const t = created ? Date.parse(created) : NaN;
    const ageDays = Number.isFinite(t) ? Math.floor((now - t) / DAY_MS) : 0;
    myOpenSnags.push({
      id: s.id, desc: s.desc || '',
      priority: s.priority || 'Medium',
      ageDays,
      photoCount: (s.photos || []).length,
    });
  }
  const myHighSnags    = myOpenSnags.filter(s => s.priority === 'High');
  const myNoPhotoSnags = myOpenSnags.filter(s => s.photoCount === 0);
  const myOldSnags     = myOpenSnags.filter(s => s.ageDays >= SNAG_OLD_DAYS);
  const oldestSnagAge  = myOldSnags.reduce((m, s) => Math.max(m, s.ageDays), 0);

  // ── Today's hours entry (one read by exact path) ─────────────────────
  const todayEntry = await readBlob(`users/${me.id}/time-entries/${today}.json`, null);
  let myHoursOnJobToday = 0;
  if (todayEntry) {
    for (const a of (todayEntry.allocations || [])) {
      if (a.jobId === jobId) myHoursOnJobToday += Number(a.hours) || 0;
    }
  }

  // ── Recent rejected hours referencing this job ───────────────────────
  // Walk my own time-entries prefix for the last 21 days, find rejected
  // entries with at least one allocation on this job.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const cutoff21 = new Date(Date.now() - 21 * DAY_MS).toISOString().slice(0, 10);
  let recentRejected = null;       // newest rejected entry on this job
  let recentEntries = [];          // for the "have I touched this job lately?" check
  try {
    const r = await list({ prefix: `users/${me.id}/time-entries/`, token, limit: 200 });
    const candidates = (r.blobs || []).filter(b => {
      const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      return m && m[1] >= cutoff21;
    });
    recentEntries = (await Promise.all(candidates.map(async b => {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) return null;
        return await rr.json();
      } catch { return null; }
    }))).filter(Boolean);
  } catch { /* swallow */ }
  for (const e of recentEntries) {
    if (e.status !== 'rejected') continue;
    const onThisJob = (e.allocations || []).some(a => a.jobId === jobId);
    if (!onThisJob) continue;
    if (!recentRejected || (e.date || '') > (recentRejected.date || '')) {
      recentRejected = e;
    }
  }
  const touchedRecently = recentEntries.some(e =>
    (e.allocations || []).some(a => a.jobId === jobId && (Number(a.hours) || 0) > 0));

  // ── A dwelling in progress (mid-completion) ──────────────────────────
  let continueArea = null;
  const dwellings = data.dwellings || {};
  const jobRt = job.roughInTasks || [];
  const jobFt = job.fitOffTasks  || [];
  const effRough = (a) => (Array.isArray(a.roughInTasks) && a.roughInTasks.length) ? a.roughInTasks : jobRt;
  const effFit   = (a) => (Array.isArray(a.fitOffTasks)  && a.fitOffTasks.length)  ? a.fitOffTasks  : jobFt;
  let bestMid = -1;
  for (const g of (job.areaGroups || [])) {
    for (const a of (g.areas || [])) {
      const rMap = ((dwellings[a.id] || {}).roughIn || {}).tasks || {};
      const fMap = ((dwellings[a.id] || {}).fitOff  || {}).tasks || {};
      const aRt = effRough(a), aFt = effFit(a);
      let parts = [];
      if (aRt.length) parts.push(aRt.filter(t => rMap[t.id] === 'complete').length / aRt.length);
      if (aFt.length) parts.push(aFt.filter(t => fMap[t.id] === 'complete').length / aFt.length);
      if (!parts.length) continue;
      const pct = parts.reduce((s, v) => s + v, 0) / parts.length;
      if (pct > 0 && pct < 1) {
        // Pick the area closest to 50% — "actually being worked on", not "barely started".
        const score = -Math.abs(pct - 0.5);
        if (score > bestMid) {
          bestMid = score;
          continueArea = { id: a.id, name: a.name, pct: Math.round(pct * 100) };
        }
      }
    }
  }

  // ── Compose actions in priority order ────────────────────────────────
  const actions = [];

  if (recentRejected) {
    const date = recentRejected.date || '';
    actions.push({
      type: 'rejected-hours',
      label: `Fix rejected hours from ${prettyDate(date)}`,
      url: '/my-day?fixDate=' + encodeURIComponent(date),
      meta: { date, reason: recentRejected.rejectedReason || null },
    });
  }

  if (todayEntry && todayEntry.status === 'draft' && myHoursOnJobToday > 0) {
    actions.push({
      type: 'draft-hours',
      label: `Submit your hours (${(Math.round(myHoursOnJobToday * 10) / 10).toFixed(1)}h)`,
      url: '/my-day?openHours=1',
      meta: { hours: Math.round(myHoursOnJobToday * 10) / 10 },
    });
  }

  if (myHighSnags.length) {
    actions.push({
      type: 'high-snags',
      label: `${myHighSnags.length} high-priority snag${myHighSnags.length === 1 ? '' : 's'} need attention`,
      url: '/jobs/' + jobId + '#snags',
      meta: { count: myHighSnags.length },
    });
  }

  if (myNoPhotoSnags.length) {
    actions.push({
      type: 'snags-no-photo',
      label: `Add photo${myNoPhotoSnags.length === 1 ? '' : 's'} to ${myNoPhotoSnags.length} snag${myNoPhotoSnags.length === 1 ? '' : 's'}`,
      url: '/jobs/' + jobId + '#snags',
      meta: { count: myNoPhotoSnags.length },
    });
  }

  if (myOldSnags.length) {
    actions.push({
      type: 'old-snags',
      label: `${myOldSnags.length} snag${myOldSnags.length === 1 ? '' : 's'} overdue (oldest ${oldestSnagAge}d)`,
      url: '/jobs/' + jobId + '#snags',
      meta: { count: myOldSnags.length, oldestDays: oldestSnagAge },
    });
  }

  if (!todayEntry && touchedRecently) {
    actions.push({
      type: 'log-hours',
      label: "Log today's hours",
      url: '/my-day?openHours=1',
      meta: {},
    });
  }

  if (continueArea) {
    actions.push({
      type: 'continue-area',
      label: `Continue ${continueArea.name} (${continueArea.pct}% complete)`,
      url: '/jobs/' + jobId + '?area=' + encodeURIComponent(continueArea.id),
      meta: { areaId: continueArea.id, areaName: continueArea.name, pct: continueArea.pct },
    });
  }

  return res.status(200).json({
    jobId,
    actions: actions.slice(0, limit),
  });
};
