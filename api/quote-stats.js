// Quote pipeline stats — admin sales view.
//
//   GET /api/quote-stats
//
// Single-call rollup of the quotes pipeline: counts by status, an
// "active vs terminal" split, conversion rate, and how many in each
// active stage are stale (older than a per-status threshold). For the
// admin sales dashboard widget — "what's stuck in the pipeline?".
//
// Response:
//   {
//     asOf,
//     total,
//     byStatus: { draft, reviewing, estimating, submitted,
//                 accepted, won, lost, declined,
//                 converted_to_job, archived },
//     active,     // sum of non-terminal
//     terminal,   // won + lost + declined + converted_to_job + archived
//     stale: { draft, reviewing, estimating, submitted, accepted },
//     conversionRate     // (won + converted_to_job) / decided  (0..1)
//   }
//
// Stale thresholds (calendar days since updatedAt):
//   draft       3
//   reviewing   5
//   estimating  7
//   submitted   10
//   accepted    5    (accepted → not yet converted)
//
// Permissions: admin only. Quote info is commercial; LH gets to see
// their job's quote (if any) via /api/quotes but not the global view.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const ALL_STATUSES = [
  'draft', 'reviewing', 'estimating', 'submitted',
  'accepted', 'won', 'lost', 'declined',
  'converted_to_job', 'archived',
];
const ACTIVE_STATUSES   = new Set(['draft', 'reviewing', 'estimating', 'submitted', 'accepted']);
const TERMINAL_STATUSES = new Set(['won', 'lost', 'declined', 'converted_to_job', 'archived']);
const STALE_DAYS = {
  draft: 3,
  reviewing: 5,
  estimating: 7,
  submitted: 10,
  accepted: 5,
};
const DAY_MS = 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const data = await readBlob('quotes.json', { quotes: [] });
  const quotes = data.quotes || [];

  // Seed counters at zero so missing statuses still appear in the response.
  const byStatus = Object.fromEntries(ALL_STATUSES.map(s => [s, 0]));
  const stale    = Object.fromEntries(Object.keys(STALE_DAYS).map(s => [s, 0]));

  const now = Date.now();
  let active = 0;
  let terminal = 0;

  for (const q of quotes) {
    const status = ALL_STATUSES.includes(q.status) ? q.status : 'draft';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (ACTIVE_STATUSES.has(status))   active++;
    if (TERMINAL_STATUSES.has(status)) terminal++;

    if (STALE_DAYS[status] !== undefined) {
      const ref = q.updatedAt || q.createdAt;
      if (ref) {
        const t = Date.parse(ref);
        if (Number.isFinite(t)) {
          const ageDays = (now - t) / DAY_MS;
          if (ageDays >= STALE_DAYS[status]) stale[status]++;
        }
      }
    }
  }

  // Conversion rate: only count decided quotes (won + lost + declined +
  // converted_to_job). Archived is excluded — admin-killed, not a sales
  // outcome.
  const wonOrConverted = byStatus.won + byStatus.converted_to_job;
  const decided = wonOrConverted + byStatus.lost + byStatus.declined;
  const conversionRate = decided > 0 ? wonOrConverted / decided : null;

  return res.status(200).json({
    asOf: new Date().toISOString(),
    total: quotes.length,
    byStatus,
    active,
    terminal,
    stale,
    conversionRate: conversionRate === null
      ? null
      : Math.round(conversionRate * 1000) / 1000,
  });
};
