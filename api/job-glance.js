// Tradie / LH mobile job page — top-of-page "at a glance" data.
//
//   GET /api/job-glance?jobId=<id>
//
// Single fetch that powers the header strip on the mobile job page:
// job progress %, *my* assigned-snag count, *my* hours today on this
// job, who else is on site today, last activity. Avoids the cascade
// of 4-5 GETs the page would otherwise do on every open.
//
// Why this exists:
//   The job-mobile front-end (Phase 03-05 of the unmerged stack) opens
//   onto a single Job Home screen. That screen needs a snapshot above
//   the fold — progress + my action items — without burning the
//   mobile bundle on five separate requests over a 3G connection. One
//   endpoint, one paint.
//
// Response:
//   {
//     job:      { id, name, type, status },
//     progress: { roughInPct, fitOffPct, overallPct, areasCount, areasComplete },
//     me: {
//       hoursToday,                    // hours allocated to this job today (Sydney)
//       hoursEntryStatus,              // 'draft' | 'submitted' | 'approved' | 'rejected' | null
//       assignedOpenSnags              // count, open, assignedToUserId === me.id
//     },
//     crew: {
//       onSiteToday                    // distinct other users with hours today
//     },
//     snags:    { openTotal, openHigh },
//     lastActivityAt
//   }
//
// Permissions:
//   - admin / leadingHand / tradie with write access (canWrite)
//   - client owning the job: forbidden (use /api/client-update — sanitised)
//
// Cost: 1 jobs.json read + 1 data.json read + 1 hours blob list +
//       1 fetch per matching hours entry (one per user, same Sydney day).

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const me = await requireAuth(req, res, { jobId });
  if (!me) return;

  // Clients get a different endpoint — the sanitised summary. Guard here
  // so a client deep-linking to /jobs/<id> doesn't trip on internal data.
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (!canWrite(me, jobId) && me.role !== 'admin') {
    return res.status(403).json({ error: 'no access to job' });
  }

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const data = await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [] });

  // ── Progress (mirrors client.html math) ──────────────────────────────
  const areas = (job.areaGroups || []).flatMap(g => g.areas || []);
  const dwellings = data.dwellings || {};
  const jobRt = job.roughInTasks || [];
  const jobFt = job.fitOffTasks  || [];
  const effRough = (a) => (Array.isArray(a.roughInTasks) && a.roughInTasks.length) ? a.roughInTasks : jobRt;
  const effFit   = (a) => (Array.isArray(a.fitOffTasks)  && a.fitOffTasks.length)  ? a.fitOffTasks  : jobFt;
  let rSum = 0, fSum = 0, rCount = 0, fCount = 0;
  let areasComplete = 0;
  for (const a of areas) {
    const rMap = ((dwellings[a.id] || {}).roughIn || {}).tasks || {};
    const fMap = ((dwellings[a.id] || {}).fitOff  || {}).tasks || {};
    const aRt = effRough(a), aFt = effFit(a);
    let rPct = null, fPct = null;
    if (aRt.length) {
      rPct = aRt.filter(t => rMap[t.id] === 'complete').length / aRt.length;
      rSum += rPct; rCount++;
    }
    if (aFt.length) {
      fPct = aFt.filter(t => fMap[t.id] === 'complete').length / aFt.length;
      fSum += fPct; fCount++;
    }
    const parts = [rPct, fPct].filter(v => v !== null);
    if (parts.length && parts.every(v => v === 1)) areasComplete++;
  }
  const roughInPct = rCount ? Math.round(rSum / rCount * 100) : 0;
  const fitOffPct  = fCount ? Math.round(fSum / fCount * 100) : 0;
  const overallPct = (rCount || fCount)
    ? Math.round((rCount && fCount) ? (roughInPct + fitOffPct) / 2 : (rCount ? roughInPct : fitOffPct))
    : 0;

  // ── Snags ────────────────────────────────────────────────────────────
  let openTotal = 0, openHigh = 0;
  let assignedOpenSnags = 0;
  let lastActivityAt = '';
  for (const s of (data.snags || [])) {
    for (const ts of [s.createdAt, s.closedAt, s.updatedAt]) {
      if (ts && ts > lastActivityAt) lastActivityAt = ts;
    }
    if ((s.status || 'Open') === 'Open') {
      openTotal++;
      if ((s.priority || 'Medium') === 'High') openHigh++;
      if (s.assignedToUserId === me.id) assignedOpenSnags++;
    }
  }

  // ── Hours: my today's allocation to THIS job + how many others on site
  const today = sydneyToday();
  let myHoursToday = 0;
  let myHoursEntryStatus = null;
  let onSiteToday = 0;
  try {
    // My entry (single direct read by path)
    const mine = await readBlob(`users/${me.id}/time-entries/${today}.json`, null);
    if (mine) {
      myHoursEntryStatus = mine.status || 'draft';
      for (const a of (mine.allocations || [])) {
        if (a.jobId === jobId) myHoursToday += Number(a.hours) || 0;
      }
    }

    // Crew on site (excluding me)
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    const blobs = (r.blobs || []).filter(b =>
      b.pathname.endsWith(`/time-entries/${today}.json`));
    const others = await Promise.all(blobs.map(async b => {
      // Skip my own blob; we already read it.
      if (b.pathname === `users/${me.id}/time-entries/${today}.json`) return null;
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) return null;
        return await rr.json();
      } catch { return null; }
    }));
    const seenUsers = new Set();
    for (const e of others) {
      if (!e || !e.userId) continue;
      const onThisJob = (e.allocations || []).some(a =>
        a.jobId === jobId && (Number(a.hours) || 0) > 0);
      if (onThisJob) seenUsers.add(e.userId);
    }
    onSiteToday = seenUsers.size;
  } catch (e) { console.error('job-glance: hours walk failed', e); }

  return res.status(200).json({
    job: { id: job.id, name: job.name, type: job.type || null, status: job.status || 'active' },
    progress: {
      roughInPct, fitOffPct, overallPct,
      areasCount: areas.length, areasComplete,
    },
    me: {
      hoursToday: Math.round(myHoursToday * 10) / 10,
      hoursEntryStatus: myHoursEntryStatus,
      assignedOpenSnags,
    },
    crew: { onSiteToday },
    snags: { openTotal, openHigh },
    lastActivityAt: lastActivityAt || null,
  });
};
