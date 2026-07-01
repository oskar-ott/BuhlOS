// Job closeout (#349, Epic 3). ADMIN-TIER ONLY.
//
//   GET  /api/job-closeout?jobId=<id>                 → { status, latest, versionCount }
//   POST /api/job-closeout?jobId=<id>&action=close    → freeze a final-numbers
//        snapshot + set status 'complete' (append-only; archived → backfilled)
//   POST /api/job-closeout?jobId=<id>&action=reopen   → status 'complete' → 'active'
//        (audited); prior snapshots are KEPT, never overwritten
//
// The snapshot is a job's permanent report card: revenue, labour (approved hours
// × effective-dated cost rate #304), material (received-rollup proxy), margin,
// planned-vs-actual duration, and snag lifecycle — every line honest about
// missing inputs (#327's badge discipline). Walks the per-user time-entry blobs
// like api/cash-watch.js / api/job-profitability.js (no per-job hours index).

const { list } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { readCostRates, historyFor, effectiveCostRate } = require('./_lib/cost-rates');
const { buildCloseoutSnapshot, snagLifecycleStats } = require('./_lib/job-closeout');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { isFlagEnabled } = require('./_lib/feature-flags');

const CLOSEOUT_KEY = (jobId) => `jobs/${jobId}/closeout.json`;
const dollarsToCents = (v) =>
  v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 100) : null;

async function readSnapshots(jobId) {
  const data = await readBlob(CLOSEOUT_KEY(jobId), { versions: [] });
  return Array.isArray(data && data.versions) ? data : { versions: [] };
}

// Gather approved labour (costed at the effective-dated rate), hours total, and
// the first/last activity dates for the job — the cash-watch walk, approved-only.
async function gatherLabour(jobId, ratesData, userById) {
  let labourCostCents = 0;
  let hoursTotal = 0;
  let firstActivity = null;
  let lastActivity = null;
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
      try { const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' }); return rr.ok ? await rr.json() : null; }
      catch { return null; }
    }))).filter(Boolean);
    for (const e of entries) {
      if (!e || e.status !== 'approved') continue;
      const hrs = (e.allocations || []).filter((a) => a && a.jobId === jobId).reduce((s, a) => s + (Number(a.hours) || 0), 0);
      if (!hrs) continue;
      hoursTotal += hrs;
      if (e.date) {
        if (!firstActivity || e.date < firstActivity) firstActivity = e.date;
        if (!lastActivity || e.date > lastActivity) lastActivity = e.date;
      }
      totalHoursByUser[e.userId] = (totalHoursByUser[e.userId] || 0) + hrs;
      const rate = effectiveCostRate(historyFor(ratesData, e.userId), e.date);
      if (rate && rate.costRateCents > 0) {
        labourCostCents += Math.round(hrs * rate.costRateCents);
        costedHoursByUser[e.userId] = (costedHoursByUser[e.userId] || 0) + hrs;
      }
    }
  } catch (err) {
    console.error('job-closeout: labour walk failed', err && err.message);
  }
  const unratedWorkers = [];
  for (const uid of Object.keys(totalHoursByUser)) {
    if ((costedHoursByUser[uid] || 0) < totalHoursByUser[uid] - 0.001) {
      const u = userById[uid];
      unratedWorkers.push((u && u.username) || uid);
    }
  }
  return { labourCostCents, hoursTotal, unratedWorkers, firstActivity, lastActivity };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!(await isFlagEnabled('closeout', me))) return res.status(404).json({ error: 'not found' });
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  const jobId = String((req.query && req.query.jobId) || '');
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const jobIdx = (jobsBlob.jobs || []).findIndex((j) => j.id === jobId);
  if (jobIdx < 0) return res.status(404).json({ error: 'job not found' });
  const job = jobsBlob.jobs[jobIdx];

  if (req.method === 'GET') {
    const snaps = await readSnapshots(jobId);
    return res.status(200).json({
      jobId,
      status: job.status,
      latest: snaps.versions[snaps.versions.length - 1] || null,
      versionCount: snaps.versions.length,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const action = String((req.query && req.query.action) || '');

  if (action === 'reopen') {
    if (job.status !== 'complete') {
      return res.status(409).json({ error: 'only a completed job can be reopened' });
    }
    jobsBlob.jobs[jobIdx] = { ...job, status: 'active' };
    await writeBlob('jobs.json', jobsBlob);
    await appendAuditLog({
      action: 'job.reopened', actorId: me.id, actorName: me.username, actorRole: me.role,
      jobId, targetType: 'job', targetId: jobId,
      summary: `${me.username} re-opened job ${job.name || jobId}`, metadata: {},
    }).catch(() => {});
    return res.status(200).json({ jobId, status: 'active' });
  }

  if (action === 'close') {
    if (job.status === 'complete') {
      return res.status(409).json({ error: 'job is already closed out — reopen it first to re-close' });
    }
    const backfilled = job.status !== 'active'; // archived / on_hold / draft → backfilled

    const [usersBlob, ratesData, matsList, dataBlob] = await Promise.all([
      readBlob('users.json', { users: [] }),
      readCostRates(),
      readBlob(`jobs/${jobId}/materials-list.json`, null),
      readBlob(`jobs/${jobId}/data.json`, { snags: [] }),
    ]);
    const userById = {};
    (usersBlob.users || []).forEach((u) => { userById[u.id] = u; });

    const labour = await gatherLabour(jobId, ratesData, userById);

    let materialCostCents = null;
    let materialSource = 'none';
    if (matsList && matsList.costRollup) {
      const dollars = Number(matsList.costRollup.receivedExGst) || Number(matsList.costRollup.invoicedExGst) || 0;
      if (dollars > 0) { materialCostCents = Math.round(dollars * 100); materialSource = 'received_proxy'; }
    }

    const snaps = await readSnapshots(jobId);
    const version = snaps.versions.length + 1;
    const snapshot = buildCloseoutSnapshot({
      contractValueCents: dollarsToCents(job.contractValue),
      claimedToDateCents: dollarsToCents(job.claimedToDate),
      labourCostCents: labour.labourCostCents,
      unratedWorkers: labour.unratedWorkers,
      hoursTotal: labour.hoursTotal,
      labourEstimateCents: dollarsToCents(job.labourEstimate),
      materialCostCents,
      materialSource,
      duration: {
        startDate: job.startDate || null,
        dueDate: job.dueDate || null,
        programmedDurationDays: job.programmedDurationDays != null ? job.programmedDurationDays : null,
        firstActivity: labour.firstActivity,
        lastActivity: labour.lastActivity,
      },
      snags: snagLifecycleStats((dataBlob && dataBlob.snags) || []),
      meta: {
        closedBy: me.id, closedByName: me.username, closedAt: new Date().toISOString(),
        backfilled, version, fromStatus: job.status,
      },
    });

    snaps.versions.push(snapshot); // append-only — prior versions kept
    await writeBlob(CLOSEOUT_KEY(jobId), snaps);
    jobsBlob.jobs[jobIdx] = { ...job, status: 'complete' };
    await writeBlob('jobs.json', jobsBlob);

    await appendAuditLog({
      action: 'job.closed', actorId: me.id, actorName: me.username, actorRole: me.role,
      jobId, targetType: 'job', targetId: jobId,
      summary: `${me.username} closed out job ${job.name || jobId}${backfilled ? ' (backfilled)' : ''}`,
      metadata: { version, backfilled, marginCents: snapshot.margin.cents },
    }).catch(() => {});

    return res.status(201).json({ jobId, status: 'complete', snapshot });
  }

  return res.status(400).json({ error: 'unknown action — use close or reopen' });
};
