// Cash-watch cron — fires a push to admins when an active job's
// forecast end first crosses its contractValue. Closes the brief §13
// follow-up: "Cron alert when overrun first crosses contractValue."
//
// Run daily by Vercel Cron (see vercel.json). Reads:
//   jobs.json                   → contractValue, labourEstimate, last alert hash
//   per-user time-entries blobs → labour spent (lifetime)
//   jobs/<id>/materials-list.json (if it exists) → received + invoiced materials
//
// For each active job that has just crossed (or moved deeper into) an
// overrun, computes a hash of { spent, forecastEnd, contractValue }
// and compares it to job.cashWatch.lastAlertedHash. Different hash + still
// overrun → fire one push to every admin user. Same hash → no-op.
//
// GET /api/cash-watch?action=check-overruns
// Authorisation: shared CRON_SECRET (same pattern as /api/notifications).
//
// Manual trigger by admins (for debugging / preview) is also allowed:
//   GET /api/cash-watch?action=check-overruns&dryRun=1

const crypto = require('crypto');
const { list } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { sendPushToUserId } = require('./_lib/push');
const { appendActivity } = require('./_lib/activity');

function cronAuthorised(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${expected}`) return true;
  if ((req.headers['x-cron-secret'] || '') === expected) return true;
  return false;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const action = (req.query && req.query.action) || '';
  if (action !== 'check-overruns') return res.status(400).json({ error: 'unknown action' });

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';

  // Manual mode for admins (dev / debug) vs cron-secret mode.
  let me = null;
  if (!cronAuthorised(req)) {
    me = await requireAuth(req, res, { roles: ['admin'] });
    if (!me) return;
  }

  // ── Load reference data ──────────────────────────────────────────
  const [jobsBlob, usersBlob] = await Promise.all([
    readBlob('jobs.json', { jobs: [] }),
    readBlob('users.json', { users: [] }),
  ]);
  const jobs  = (jobsBlob.jobs  || []).filter(j => (j.status || 'active') === 'active');
  const users = (usersBlob.users || []);

  // Labour cost per job — lifetime. Walk every per-user time-entries blob,
  // sum allocation hours × user.hourlyRate by jobId. Same path the existing
  // /api/costs endpoint walks, inlined here so this endpoint can run inside
  // a cron without nested HTTP calls.
  const rateByUserId = {};
  for (const u of users) {
    if (u.role === 'tradie' || u.role === 'leadingHand') {
      rateByUserId[u.id] = Number(u.hourlyRate) || 0;
    }
  }
  const labourSpendByJob = {};
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    const entryBlobs = (r.blobs || []).filter(b =>
      b.pathname.includes('/time-entries/') &&
      !b.pathname.includes('/time-entries-audit/') &&
      b.pathname.endsWith('.json'));
    const entries = (await Promise.all(entryBlobs.map(async b => {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) return null;
        return await rr.json();
      } catch { return null; }
    }))).filter(Boolean);
    for (const e of entries) {
      const rate = rateByUserId[e.userId] || 0;
      for (const a of (e.allocations || [])) {
        if (!a.jobId) continue;
        const hrs = Number(a.hours) || 0;
        if (!hrs) continue;
        labourSpendByJob[a.jobId] = (labourSpendByJob[a.jobId] || 0) + (hrs * rate);
      }
    }
  } catch (e) {
    console.error('cash-watch: labour walk failed', e);
  }

  // Per-job materials rollup. Each job has its own materials-list blob;
  // we read each in parallel. Failures are non-fatal — materialsSpent
  // just defaults to 0 for that job.
  const materialsByJob = {};
  await Promise.all(jobs.map(async j => {
    try {
      const r = await readBlob(`jobs/${j.id}/materials-list.json`, null);
      if (r && r.costRollup) materialsByJob[j.id] = r.costRollup;
    } catch {}
  }));

  // ── Compute per-job spend + forecast ─────────────────────────────
  const results = [];
  for (const j of jobs) {
    const contractValue   = Number(j.contractValue)  || 0;
    const labourEstimate  = Number(j.labourEstimate) || 0;
    const labourSpent     = Number(labourSpendByJob[j.id]) || 0;
    const matsRollup      = materialsByJob[j.id] || {};
    const materialsSpent  = Number(matsRollup.receivedExGst) ||
                            Number(matsRollup.invoicedExGst) || 0;
    const spent           = labourSpent + materialsSpent;

    let forecastEnd = null;
    if (labourEstimate > 0 && labourSpent > 0) {
      const burnPct = Math.min(1, labourSpent / labourEstimate);
      if (burnPct > 0.05) forecastEnd = Math.round(spent / burnPct);
    }
    const effective = forecastEnd != null ? forecastEnd : spent;
    const isOverrun = contractValue > 0 && effective > contractValue;

    results.push({
      jobId:   j.id,
      jobName: j.name,
      contractValue, labourEstimate, labourSpent, materialsSpent, spent,
      forecastEnd, isOverrun,
    });
  }

  // ── Fire alerts for newly-crossing or newly-deeper overruns ──────
  // Hash bucket: roundedSpent/roundedForecast/roundedContract. If the
  // hash equals the last-alerted hash, no push (we already told them).
  function bucket(n) { return Math.round(n / 100) * 100; }
  function hashOf(r) {
    return crypto.createHash('sha256')
      .update(`${bucket(r.spent)}|${bucket(r.forecastEnd || 0)}|${bucket(r.contractValue)}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
  }

  const admins = users.filter(u => u.role === 'admin' && !u.archived);
  let alertCount = 0;
  const alerts = [];

  // Re-read jobs.json to write any cashWatch updates (the in-memory list
  // we walked may have been built from a slightly older snapshot).
  const liveJobs = (await readBlob('jobs.json', { jobs: [] })).jobs || [];
  let mutated = false;

  for (const r of results) {
    if (!r.isOverrun) continue;
    const h = hashOf(r);
    const job = liveJobs.find(x => x.id === r.jobId);
    if (!job) continue;
    const prev = (job.cashWatch && job.cashWatch.lastAlertedHash) || null;
    if (prev === h) continue; // already alerted at this severity

    const deltaPct = r.contractValue > 0
      ? Math.round(((r.forecastEnd || r.spent) - r.contractValue) / r.contractValue * 1000) / 10
      : 0;
    const body = `Forecast ${fmt$(r.forecastEnd || r.spent)} vs ${fmt$(r.contractValue)} contract · ${deltaPct >= 0 ? '+' : ''}${deltaPct}%`;
    alerts.push({ jobId: r.jobId, jobName: r.jobName, hash: h, body });

    if (!dryRun) {
      // Fan-out to every admin's subscriptions. sendPushToUserId is
      // best-effort — failures don't abort the loop.
      for (const a of admins) {
        try {
          await sendPushToUserId(a.id, {
            title: `Job overrun · ${r.jobName}`,
            body,
            url: `/admin/cash`,
            tag: 'buhl-cash-watch-' + r.jobId,
          });
        } catch {}
      }
      job.cashWatch = {
        lastAlertedHash: h,
        lastAlertedAt:   new Date().toISOString(),
        forecastEnd:     r.forecastEnd,
        contractValue:   r.contractValue,
        spent:           r.spent,
      };
      mutated = true;
      alertCount++;
      // Activity log so the trail is auditable.
      try {
        await appendActivity({
          action: 'cash.overrun-alert',
          scope:  'payroll', // money-side event — bucketed alongside payroll
          actor:  'system',
          actorName: 'cash-watch',
          target: `job:${r.jobId}`,
          targetLabel: r.jobName,
          meta: { hash: h, ...r },
        });
      } catch {}
    }
  }

  if (mutated) {
    await writeBlob('jobs.json', { jobs: liveJobs });
  }

  return res.status(200).json({
    ok: true,
    checked: results.length,
    overruns: results.filter(r => r.isOverrun).length,
    alertCount,
    dryRun,
    alerts: dryRun ? alerts : undefined,
  });
};

function fmt$(n) {
  return '$' + Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 });
}
