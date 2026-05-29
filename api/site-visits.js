// Cross-job attendance log.
//
//   GET /api/site-visits?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
//                       &jobId=<id>     (optional)
//                       &userId=<id>    (optional)
//                       &format=json|csv
//
// Flattens time-entry allocations across a date range into one row per
// (date × user × job) with hours, ordered date-desc then job-asc. This
// is the "who was on Riley House last Tuesday?" lookup — not a hours
// management view, an attendance audit.
//
// Distinct from existing endpoints:
//   /api/time-entries-on-site    — single job, single date
//   /api/time-entries-overview   — hours management with approval state
//   /api/time-entries-export     — payroll CSV with rate + Xero IDs
//
// Site-visits is calendar-shaped — a log of presence regardless of
// status. Submitted, approved, even rejected are all included; the
// `status` column is preserved so the consumer can filter.
//
// Defaults:
//   fromDate / toDate → current week's Mon → today (Sydney)
//   format            → json
//
// Response (JSON):
//   {
//     filters: { fromDate, toDate, jobId, userId },
//     count,
//     visits: [{ date, userId, userName, jobId, jobName,
//                hours, status }]
//   }
//
// Permissions:
//   - admin: any range / any job / any user
//   - leadingHand: scoped to assignedJobIds; userId filter ignored if
//                  the user isn't on a shared job (defensive)
//   - tradie / client: 403

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isStaffRole } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function sydneyMondayOf(today) {
  const wdShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney', weekday: 'short',
  }).format(new Date(today + 'T00:00:00Z'));
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const wd = map[wdShort] ?? 0;
  return new Date(new Date(today + 'T00:00:00Z').getTime() - wd * DAY_MS)
    .toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isStaffRole(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const q = req.query || {};
  const today = sydneyToday();
  const fromDate = q.fromDate || sydneyMondayOf(today);
  const toDate   = q.toDate   || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return res.status(400).json({ error: 'fromDate / toDate must be YYYY-MM-DD' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ error: 'fromDate must be <= toDate' });
  }
  const jobIdF   = q.jobId  || '';
  const userIdF  = q.userId || '';
  const format   = (q.format || 'json').toLowerCase();

  const inWindow = (d) => d >= fromDate && d <= toDate;

  // Visible jobs (for LH scoping).
  const [jobsBlob, usersBlob] = await Promise.all([
    readBlob('jobs.json',  { jobs:  [] }),
    readBlob('users.json', { users: [] }),
  ]);
  const allJobs   = jobsBlob.jobs   || [];
  const visibleIds = (me.role === 'admin')
    ? new Set(allJobs.map(j => j.id))
    : new Set(me.assignedJobIds || []);
  const jobNameById = {};
  for (const j of allJobs) jobNameById[j.id] = j.name;
  const userById = {};
  for (const u of (usersBlob.users || [])) userById[u.id] = u;

  // Walk every per-user time-entries blob in the date window.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let entries = [];
  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    const candidates = (r.blobs || []).filter(b => {
      const m = b.pathname.match(/^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) return false;
      if (!inWindow(m[2])) return false;
      if (userIdF && m[1] !== userIdF) return false;
      return true;
    });
    entries = (await Promise.all(candidates.map(async b => {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) return null;
        return await rr.json();
      } catch { return null; }
    }))).filter(Boolean);
  } catch (e) { console.error('site-visits: walk failed', e); }

  // Flatten allocations into (date, user, job, hours) rows.
  const visits = [];
  for (const e of entries) {
    const allocs = e.allocations || [];
    for (const a of allocs) {
      if (!a.jobId) continue;                       // skip internal/no-job
      if (!visibleIds.has(a.jobId)) continue;        // LH scoping
      if (jobIdF && a.jobId !== jobIdF) continue;    // job filter
      const h = Number(a.hours) || 0;
      if (h <= 0) continue;
      visits.push({
        date: e.date,
        userId: e.userId,
        userName: e.userName || (userById[e.userId] && userById[e.userId].username) || e.userId,
        jobId: a.jobId,
        jobName: jobNameById[a.jobId] || a.jobId,
        hours: Math.round(h * 100) / 100,
        status: e.status || 'draft',
      });
    }
  }

  // Sort: date desc, then jobName asc, then userName asc.
  visits.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    if ((a.jobName || '') !== (b.jobName || '')) return (a.jobName || '').localeCompare(b.jobName || '');
    return (a.userName || '').localeCompare(b.userName || '');
  });

  if (format === 'csv') {
    const cols = ['Date', 'User ID', 'User', 'Job ID', 'Job', 'Hours', 'Status'];
    const lines = [cols.map(csvCell).join(',')];
    for (const v of visits) {
      lines.push([
        v.date, v.userId, v.userName,
        v.jobId, v.jobName, v.hours, v.status,
      ].map(csvCell).join(','));
    }
    const csv = lines.join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="buhl-visits_${fromDate}_to_${toDate}.csv"`);
    res.setHeader('X-Row-Count', String(visits.length));
    return res.status(200).send(csv);
  }

  return res.status(200).json({
    filters: { fromDate, toDate, jobId: jobIdF || null, userId: userIdF || null },
    count: visits.length,
    visits,
  });
};

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
