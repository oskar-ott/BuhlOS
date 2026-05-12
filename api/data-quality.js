// Data quality scanner — admin "fix the rough edges" tool.
//
//   GET /api/data-quality
//
// Walks core blobs and surfaces records that are missing fields,
// inconsistent, or in suspect states. Each finding is grouped into a
// named category with a severity (`warning` or `info`) and a sample
// list (capped at 10 per category) so the UI can show "12 jobs missing
// client · view samples".
//
// Why this exists:
//   Operational data accumulates rough edges over time: a job created
//   without a client, a tradie with no hourly rate, a snag still
//   assigned to a user who's been archived. None of these are bugs but
//   each costs Daniel minutes when it surfaces at the wrong moment
//   (the payroll run, the handover walk, the client email). A single
//   dashboard view turns "I'll fix that when I notice it" into "I'll
//   fix all of them on Friday afternoon".
//
// Response shape:
//   {
//     asOf,
//     totalIssues,
//     categories: [
//       { id, label, severity, count, samples: [{ id, label, sub }] }
//     ]
//   }
//
// Categories shipped in this revision:
//   active-job-no-client          warning  (active job, no clientUserId)
//   active-job-no-lh              warning  (active job, no LH assigned)
//   active-job-no-areas           warning  (active job, no areaGroups)
//   staff-no-email                info     (tradie/LH with no email)
//   staff-no-rate                 warning  (tradie/LH with hourlyRate = 0)
//   staff-no-jobs                 info     (tradie not on any job)
//   snag-empty-desc               warning  (snag without description)
//   snag-orphan-assignee          warning  (snag assignedToUserId is unknown)
//   quote-accepted-stale          warning  (accepted >30d, no convertedJobId)
//
// Permissions: admin only — touches every namespace and exposes IDs.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const SAMPLE_CAP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const QUOTE_ACCEPTED_STALE_DAYS = 30;

function category(id, label, severity) {
  return { id, label, severity, count: 0, samples: [] };
}
function record(cat, item) {
  cat.count++;
  if (cat.samples.length < SAMPLE_CAP) cat.samples.push(item);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  // ── Categories (seeded with empty rows so consumer can render zeros). ──
  const cats = {
    activeJobNoClient: category('active-job-no-client', 'Active jobs with no client linked', 'warning'),
    activeJobNoLh:     category('active-job-no-lh', 'Active jobs with no leading hand', 'warning'),
    activeJobNoAreas:  category('active-job-no-areas', 'Active jobs with no areas defined', 'warning'),
    staffNoEmail:      category('staff-no-email', 'Tradies / LHs with no email', 'info'),
    staffNoRate:       category('staff-no-rate', 'Tradies / LHs with no hourly rate', 'warning'),
    staffNoJobs:       category('staff-no-jobs', 'Tradies not assigned to any job', 'info'),
    snagEmptyDesc:     category('snag-empty-desc', 'Snags with no description', 'warning'),
    snagOrphan:        category('snag-orphan-assignee', 'Snags assigned to unknown user', 'warning'),
    quoteAcceptedStale: category('quote-accepted-stale', `Accepted quotes >${QUOTE_ACCEPTED_STALE_DAYS}d not converted`, 'warning'),
  };

  // ── Reference data ────────────────────────────────────────────────────
  const [usersBlob, jobsBlob, quotesBlob] = await Promise.all([
    readBlob('users.json',  { users:  [] }),
    readBlob('jobs.json',   { jobs:   [] }),
    readBlob('quotes.json', { quotes: [] }),
  ]);
  const users  = usersBlob.users  || [];
  const jobs   = jobsBlob.jobs    || [];
  const quotes = quotesBlob.quotes || [];

  const userById = {};
  for (const u of users) userById[u.id] = u;

  // Per-job LH set, for "active-job-no-lh".
  const lhsByJobId = {};
  for (const u of users) {
    if (u.role !== 'leadingHand' || u.archived) continue;
    for (const jid of (u.assignedJobIds || [])) {
      (lhsByJobId[jid] = lhsByJobId[jid] || []).push(u);
    }
  }

  // ── Job-level checks ─────────────────────────────────────────────────
  const active = jobs.filter(j => (j.status || 'active') === 'active');
  for (const j of active) {
    if (!j.clientUserId) {
      record(cats.activeJobNoClient, { id: j.id, label: j.name || j.id, sub: j.type || '' });
    }
    const lhs = lhsByJobId[j.id] || [];
    if (lhs.length === 0) {
      record(cats.activeJobNoLh, { id: j.id, label: j.name || j.id, sub: j.type || '' });
    }
    const areaCount = (j.areaGroups || []).reduce((s, g) => s + ((g.areas || []).length), 0);
    if (areaCount === 0) {
      record(cats.activeJobNoAreas, { id: j.id, label: j.name || j.id, sub: 'no areas defined' });
    }
  }

  // ── Staff-level checks ───────────────────────────────────────────────
  for (const u of users) {
    if (u.archived) continue;
    if (u.role !== 'tradie' && u.role !== 'leadingHand') continue;

    if (!u.email) {
      record(cats.staffNoEmail, { id: u.id, label: u.username, sub: u.role });
    }
    if (typeof u.hourlyRate !== 'number' || u.hourlyRate <= 0) {
      record(cats.staffNoRate, { id: u.id, label: u.username, sub: u.role });
    }
    if (u.role === 'tradie' && (!u.assignedJobIds || !u.assignedJobIds.length)) {
      record(cats.staffNoJobs, { id: u.id, label: u.username, sub: 'tradie · no assignedJobIds' });
    }
  }

  // ── Snag-level checks (per active job, parallel) ─────────────────────
  await Promise.all(active.map(async j => {
    let data;
    try { data = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
    catch { return; }
    for (const s of (data.snags || [])) {
      if (!s) continue;
      const desc = (s.desc || '').trim();
      if (!desc) {
        record(cats.snagEmptyDesc, {
          id: s.id, label: '(no description)',
          sub: j.name + (s.priority ? ' · ' + s.priority : ''),
        });
      }
      if (s.assignedToUserId && !userById[s.assignedToUserId]) {
        record(cats.snagOrphan, {
          id: s.id, label: desc || '(no description)',
          sub: j.name + ' · assignee id ' + s.assignedToUserId,
        });
      }
    }
  }));

  // ── Quote stalls ─────────────────────────────────────────────────────
  const now = Date.now();
  for (const q of quotes) {
    if (q.status !== 'accepted') continue;
    if (q.convertedJobId) continue;
    const ref = q.updatedAt || q.createdAt;
    if (!ref) continue;
    const t = Date.parse(ref);
    if (!Number.isFinite(t)) continue;
    if ((now - t) / DAY_MS < QUOTE_ACCEPTED_STALE_DAYS) continue;
    record(cats.quoteAcceptedStale, {
      id: q.id, label: q.name || q.id,
      sub: 'accepted ' + Math.floor((now - t) / DAY_MS) + 'd ago',
    });
  }

  const categories = Object.values(cats);
  const totalIssues = categories.reduce((s, c) => s + c.count, 0);

  return res.status(200).json({
    asOf: new Date().toISOString(),
    totalIssues,
    categories,
  });
};
