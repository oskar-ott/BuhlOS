// Per-job profitability (#327, Epic 14). ADMIN-TIER ONLY.
//
//   GET /api/job-profitability?jobId=<id>
//     → { jobId, contractValueCents, labourCostCents, materialCostCents,
//         marginCents, marginPct, completeness, badges, hoursTotal, asOf }
//
// Revenue (contractValue) − labour − material, with an honest completeness
// statement. Labour is APPROVED hours costed at the EFFECTIVE-DATED cost rate
// (#304) for the week those hours fall in — a worker with no rate effective on
// an entry's date has those hours EXCLUDED and is named (never a silent 0).
// Material is the received-materials rollup, labelled a proxy (real consumption
// is Epic 12, not built). Walks the per-user time-entry blobs the same way
// api/cash-watch.js does — there is no per-job hours index.
//
// Reconciliation note (#327 AC): this counts APPROVED entries only and costs
// them at the confidential cost rate; api/costs.js counts ALL statuses at the
// legacy users.json hourlyRate, so the two will differ by design.

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { readCostRates, historyFor, effectiveCostRate } = require('./_lib/cost-rates');
const { computeJobProfitability } = require('./_lib/job-profitability');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  const jobId = String((req.query && req.query.jobId) || '');
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find((j) => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const [usersBlob, ratesData, matsList] = await Promise.all([
    readBlob('users.json', { users: [] }),
    readCostRates(),
    readBlob(`jobs/${jobId}/materials-list.json`, null),
  ]);
  const userById = {};
  (usersBlob.users || []).forEach((u) => { userById[u.id] = u; });

  // ── Labour: walk approved entries allocated to this job ──────────────────
  let labourCostCents = 0;
  let hoursTotal = 0;
  const totalHoursByUser = {};
  const costedHoursByUser = {};
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    const entryBlobs = (r.blobs || []).filter((b) =>
      b.pathname.includes('/time-entries/') &&
      !b.pathname.includes('/time-entries-audit/') &&
      b.pathname.endsWith('.json'));
    const entries = (await Promise.all(entryBlobs.map(async (b) => {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        return rr.ok ? await rr.json() : null;
      } catch { return null; }
    }))).filter(Boolean);

    for (const e of entries) {
      if (!e || e.status !== 'approved') continue;
      const hrs = (e.allocations || [])
        .filter((a) => a && a.jobId === jobId)
        .reduce((s, a) => s + (Number(a.hours) || 0), 0);
      if (!hrs) continue;
      hoursTotal += hrs;
      totalHoursByUser[e.userId] = (totalHoursByUser[e.userId] || 0) + hrs;
      const rate = effectiveCostRate(historyFor(ratesData, e.userId), e.date);
      if (rate && rate.costRateCents > 0) {
        labourCostCents += Math.round(hrs * rate.costRateCents);
        costedHoursByUser[e.userId] = (costedHoursByUser[e.userId] || 0) + hrs;
      }
    }
  } catch (err) {
    // Non-fatal: a labour-walk failure yields 0 labour + an understated badge,
    // never a 500 — the admin still gets revenue + materials.
    console.error('job-profitability: labour walk failed', err && err.message);
  }

  // A worker is "unrated" when ANY of their approved hours on the job could not
  // be costed (no rate effective on that entry's date) — their costable hours
  // are still counted, but the labour figure is flagged understated.
  const unratedWorkers = [];
  for (const uid of Object.keys(totalHoursByUser)) {
    const costed = costedHoursByUser[uid] || 0;
    if (costed < totalHoursByUser[uid] - 0.001) {
      const u = userById[uid];
      unratedWorkers.push((u && u.username) || uid);
    }
  }

  // ── Materials: received-rollup proxy (Epic 12 consumption not built) ─────
  let materialCostCents = null;
  let materialSource = 'none';
  if (matsList && matsList.costRollup) {
    const dollars = Number(matsList.costRollup.receivedExGst) ||
                    Number(matsList.costRollup.invoicedExGst) || 0;
    if (dollars > 0) {
      materialCostCents = Math.round(dollars * 100);
      materialSource = 'received_proxy';
    }
  }

  // ── Revenue ──────────────────────────────────────────────────────────────
  const cv = Number(job.contractValue);
  const contractValueCents = job.contractValue != null && Number.isFinite(cv) && cv > 0
    ? Math.round(cv * 100)
    : null;

  const result = computeJobProfitability({
    contractValueCents,
    labourCostCents,
    unratedWorkers,
    materialCostCents,
    materialSource,
  });

  return res.status(200).json({
    jobId,
    ...result,
    hoursTotal: Math.round(hoursTotal * 100) / 100,
    asOf: new Date().toISOString(),
  });
};
