// Pre-fill template for "log today's hours" based on the user's most recent prior entry.
//
//   GET /api/log-hours-template
//
// Walks the current user's recent time-entries (last 14 days) and returns
// the shape of the most recent one — start/end times, break minutes, and
// the list of jobs they allocated to — stripped of the actual hours. The
// mobile log-hours sheet pre-fills these defaults; the tradie types
// totalHours and the allocations stay where they were yesterday (or
// Friday, on a Monday morning).
//
// Response:
//   {
//     fromEntry: { date, totalHours, status } | null,
//     template:  { startTime, endTime, breakMinutes,
//                  allocations: [{ jobId, jobName }] }
//   }
//
// Empty template (with sensible defaults) returned if the user has no
// prior entries — keeps the front-end logic simple (always renders).
//
// Why this exists:
//   On Monday morning the tradie is staring at an empty sheet. They
//   worked the same job Friday. The friction of re-picking the job,
//   typing the time, and re-checking the break is what the daily-hours
//   reminder is fighting against. Pre-fill from the last entry removes
//   most of the typing.
//
// Permissions: any authenticated user. Returns their own data only.

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 14;

function sydneyToday() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

// Default template if the user has no recent prior entry.
const DEFAULT_TEMPLATE = {
  startTime: '07:00',
  endTime: '15:30',
  breakMinutes: 30,
  allocations: [],
};

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  const today = sydneyToday();
  const cutoffTs = new Date(today + 'T00:00:00Z').getTime() - LOOKBACK_DAYS * DAY_MS;
  const cutoff = new Date(cutoffTs).toISOString().slice(0, 10);

  // List the user's entries scoped to a tight prefix — single list call.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let candidateBlobs = [];
  try {
    const r = await list({ prefix: `users/${me.id}/time-entries/`, token, limit: 200 });
    candidateBlobs = (r.blobs || []).filter(b => {
      const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) return false;
      // Strictly before today, within the lookback window.
      return m[1] < today && m[1] >= cutoff;
    });
  } catch (e) {
    console.error('log-hours-template: list failed', e);
  }

  if (!candidateBlobs.length) {
    return res.status(200).json({ fromEntry: null, template: DEFAULT_TEMPLATE });
  }

  // Most recent prior date first.
  candidateBlobs.sort((a, b) => b.pathname.localeCompare(a.pathname));

  // Walk newest → older, return the first entry with allocations + totalHours.
  let chosen = null;
  for (const b of candidateBlobs) {
    let entry;
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) continue;
      entry = await r.json();
    } catch { continue; }
    if (!entry) continue;
    const total = Number(entry.totalHours) || 0;
    const allocs = Array.isArray(entry.allocations) ? entry.allocations : [];
    if (total > 0 && allocs.length) {
      chosen = entry;
      break;
    }
  }

  if (!chosen) {
    return res.status(200).json({ fromEntry: null, template: DEFAULT_TEMPLATE });
  }

  // Resolve job names. Read jobs.json once.
  let jobNameById = {};
  try {
    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    for (const j of (jobsBlob.jobs || [])) jobNameById[j.id] = j.name;
  } catch { /* fall back to ids */ }

  // De-dupe allocations to unique jobs — even if Friday had two splits on
  // the same job, the template just shows the job once.
  const seen = new Set();
  const allocs = [];
  for (const a of (chosen.allocations || [])) {
    if (!a || !a.jobId || seen.has(a.jobId)) continue;
    seen.add(a.jobId);
    allocs.push({
      jobId: a.jobId,
      jobName: jobNameById[a.jobId] || a.jobId,
    });
  }

  return res.status(200).json({
    fromEntry: {
      date: chosen.date,
      totalHours: Number(chosen.totalHours) || 0,
      status: chosen.status || 'draft',
    },
    template: {
      startTime: chosen.startTime || DEFAULT_TEMPLATE.startTime,
      endTime:   chosen.endTime   || DEFAULT_TEMPLATE.endTime,
      breakMinutes: (typeof chosen.breakMinutes === 'number' ? chosen.breakMinutes : DEFAULT_TEMPLATE.breakMinutes),
      allocations: allocs,
    },
  });
};
