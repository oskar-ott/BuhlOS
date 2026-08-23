// Per-job profitability (#327, Epic 14). ADMIN-TIER ONLY.
//
//   GET /api/job-profitability?jobId=<id>
//     → { jobId, contractValueCents, labourCostCents, materialCostCents,
//         marginCents, marginPct, completeness, badges, budget, variance,
//         hoursTotal, labourChargeOutCents, chargeOutHours, unratedWorkerRefs, asOf }
//
// Revenue (contractValue) − labour − material, with an honest completeness
// statement. Labour is APPROVED hours costed at the EFFECTIVE-DATED cost rate
// (#304) for the day those hours fall on — a worker with no rate effective on
// an entry's date has those hours EXCLUDED and is named (never a silent 0),
// with the employee record the rate is set on (unratedWorkerRefs) so the card
// can link straight to the fix. The same hours valued at each worker's
// optional CHARGE-OUT rate give labourChargeOutCents — "what is this labour
// worth" (owner ask 2026-08-23), kept separate from cost; null until at least
// one worker on the job carries a charge-out rate.
//
// Material (owner pull 2026-08-23): the per-job materials SPEND ledger
// (api/_lib/job-materials.js) when the job_materials_spend flag is on for the
// viewer and the job has lines → materialSource 'ledger'. Otherwise the legacy
// received-materials rollup (jobs/<id>/materials-list.json — written by a tool
// the 2026-07 gut deleted, so present on no current job) as a labelled proxy,
// else 'none'. Never a fabricated $0.
//
// Walks the per-user time-entry blobs through the fully paginated helper
// (api/_lib/time-entry-blobs.js, #935) — there is no per-job hours index.
//
// Reconciliation note: this counts APPROVED entries only, at the confidential
// cost rate. The hub's Labour card costs the same entries with the same pure
// effective-date resolution (src/domains/jobs/job-hours.ts costJobHours), so
// the two labour figures agree by construction.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { readCostRates, historyFor, effectiveCostRate } = require('./_lib/cost-rates');
const { computeJobProfitability, buildBudgetLines } = require('./_lib/job-profitability');
const { listTimeEntryBlobs, fetchTimeEntries } = require('./_lib/time-entry-blobs');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { readLedger, summariseLedger } = require('./_lib/job-materials');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

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

  const [usersBlob, employeesBlob, ratesData, matsList, ledgerOn] = await Promise.all([
    readBlob('users.json', { users: [] }),
    readBlob('employees.json', { employees: [] }),
    readCostRates(),
    readBlob(`jobs/${jobId}/materials-list.json`, null),
    isFlagEnabled('job_materials_spend', me),
  ]);
  const userById = {};
  (usersBlob.users || []).forEach((u) => { userById[u.id] = u; });
  const employeeIdByUserId = {};
  ((employeesBlob && employeesBlob.employees) || []).forEach((e) => {
    if (e && e.userId && e.id) employeeIdByUserId[e.userId] = e.id;
  });

  // ── Labour: walk approved entries allocated to this job ──────────────────
  let labourCostCents = 0;
  let hoursTotal = 0;
  let chargeOutCents = 0;
  let chargeOutHours = 0;
  const totalHoursByUser = {};
  const costedHoursByUser = {};
  try {
    const entries = await fetchTimeEntries(await listTimeEntryBlobs());
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
      if (rate && rate.chargeOutRateCents > 0) {
        chargeOutCents += Math.round(hrs * rate.chargeOutRateCents);
        chargeOutHours += hrs;
      }
    }
  } catch (err) {
    // Non-fatal: a labour-walk failure yields 0 labour + an understated badge,
    // never a 500 — the admin still gets revenue + materials.
    console.error('job-profitability: labour walk failed', err && err.message);
  }

  // A worker is "unrated" when ANY of their approved hours on the job could not
  // be costed (no rate effective on that entry's date) — their costable hours
  // are still counted, but the labour figure is flagged understated. Named by
  // LIVE full name (owner-directed 2026-08-16), never a nickname.
  const unratedWorkerRefs = [];
  for (const uid of Object.keys(totalHoursByUser)) {
    const costed = costedHoursByUser[uid] || 0;
    if (costed < totalHoursByUser[uid] - 0.001) {
      const u = userById[uid];
      const name = (u && (u.name || u.username)) || uid;
      unratedWorkerRefs.push({ userId: uid, name, employeeId: employeeIdByUserId[uid] || null });
    }
  }
  unratedWorkerRefs.sort((a, b) => a.name.localeCompare(b.name));
  const unratedWorkers = unratedWorkerRefs.map((w) => w.name);

  // ── Materials: the spend ledger when lit, else the legacy proxy, else none ─
  let materialCostCents = null;
  let materialSource = 'none';
  if (ledgerOn) {
    try {
      const ledger = summariseLedger(await readLedger(jobId));
      if (ledger.count > 0) {
        materialCostCents = ledger.totalCents;
        materialSource = 'ledger';
      }
    } catch (err) {
      console.error('job-profitability: materials ledger read failed', err && err.message);
    }
  }
  if (materialSource === 'none' && matsList && matsList.costRollup) {
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

  // #341: budget variance — actual vs estimate, the same money module.
  const le = Number(job.labourEstimate);
  const me_ = Number(job.materialEstimate);
  const labourEstimateCents = job.labourEstimate != null && Number.isFinite(le) && le > 0 ? Math.round(le * 100) : null;
  const materialEstimateCents = job.materialEstimate != null && Number.isFinite(me_) && me_ > 0 ? Math.round(me_ * 100) : null;
  const budget = { labourEstimateCents, materialEstimateCents };
  const variance = buildBudgetLines({
    labourCostCents,
    materialCostCents,
    labourEstimateCents,
    materialEstimateCents,
    contractValueCents,
  });

  return res.status(200).json({
    jobId,
    ...result,
    unratedWorkerRefs,
    labourChargeOutCents: chargeOutHours > 0 ? chargeOutCents : null,
    chargeOutHours: round2(chargeOutHours),
    budget,
    variance,
    hoursTotal: round2(hoursTotal),
    asOf: new Date().toISOString(),
  });
};
