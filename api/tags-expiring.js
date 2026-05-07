// Cross-job listing of test & tag entries whose expiryDate falls within
// a configurable window (default: 14 days from today). Used by /my-day's
// "Needs action" card so tradies/LHs see compliance-critical retests
// without having to open every job.
//
//   GET /api/tags-expiring
//     ?withinDays=N  (default: 14)   — include tags expiring in the next N days
//     ?jobId=<id>                    — restrict to one job (optional)
//
// Response: {
//   tags: [{ id, jobId, jobName, tagNumber, applianceType, owner,
//            expiryDate, expiryISO, daysToExpiry, status }]
// }
//   - daysToExpiry: signed integer; <0 means already expired.
//   - status: 'expired' | 'expiring' (within window) — never 'ok' (those are filtered out).
//
// Sorting: expired-first (oldest expiry first), then earliest upcoming.
//
// Visibility:
//   - admin: all jobs
//   - leadingHand / tradie: only jobs in their assignedJobIds
//   - clients: 403

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

// Parse "dd/mm/yyyy" (the canonical storage format) → ms-since-epoch
// at local midnight. Returns NaN if the string isn't in that shape.
// Also accepts "yyyy-mm-dd" as a defensive fallback.
function parseDdmmyyyy(str) {
  if (!str) return NaN;
  const s = String(str).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const day = +m[1], mon = +m[2] - 1, yr = +m[3];
    return new Date(yr, mon, day).getTime();
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return NaN;
}

function toIsoDay(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const q = req.query || {};
  const withinDays = Math.max(1, Math.min(365, Number(q.withinDays) || 14));
  const filterJobId = q.jobId || '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs  = today.getTime();
  const cutoffMs = todayMs + withinDays * 24 * 60 * 60 * 1000;

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs = jobsBlob.jobs || [];
  let visible = (me.role === 'admin')
    ? allJobs
    : allJobs.filter(j => (me.assignedJobIds || []).includes(j.id));
  if (filterJobId) visible = visible.filter(j => j.id === filterJobId);

  // Read each job's tags.json in parallel; flatten + filter to expired/expiring.
  const collected = await Promise.all(visible.map(async job => {
    let tagsBlob;
    try {
      tagsBlob = await readBlob('jobs/' + job.id + '/tags.json', { tags: [] });
    } catch (e) { return []; }

    return (tagsBlob.tags || []).map(t => {
      const ms = parseDdmmyyyy(t.expiryDate || '');
      if (!Number.isFinite(ms)) return null;
      // Expired or within the window
      if (ms > cutoffMs) return null;
      const daysToExpiry = Math.round((ms - todayMs) / (24 * 60 * 60 * 1000));
      return {
        id: t.id,
        jobId: job.id,
        jobName: job.name,
        tagNumber:     t.tagNumber || '',
        applianceType: t.applianceType || '',
        owner:         t.owner || '',
        result:        t.result || '',
        expiryDate:    t.expiryDate || '',
        expiryISO:     toIsoDay(ms),
        daysToExpiry,
        status:        ms < todayMs ? 'expired' : 'expiring',
      };
    }).filter(Boolean);
  }));

  // Flatten + sort: expired first (oldest expiry first), then upcoming
  // (soonest expiry first).
  const tags = [].concat.apply([], collected).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'expired' ? -1 : 1;
    return (a.expiryISO || '').localeCompare(b.expiryISO || '');
  });

  return res.status(200).json({ tags, withinDays });
};
