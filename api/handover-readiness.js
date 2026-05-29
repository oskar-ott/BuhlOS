// Handover readiness scorecard.
//
//   GET /api/handover-readiness?jobId=<id>
//
// "Can I hand this over?" — surface what's left between today and a
// clean handover walk. Combines progress %, outstanding snag burden,
// and incomplete-area count into a single readiness score, then names
// the top 3-5 blockers in plain language.
//
// Response:
//   {
//     jobId, jobName,
//     overall:   { roughInPct, fitOffPct, overallPct },
//     areas: [{
//       dwellingId, dwellingName,
//       roughInPct, fitOffPct, overallPct, isComplete
//     }],
//     outstanding: {
//       snags: { open, highOpen, unphotographed },
//       incompleteAreas
//     },
//     readinessScore,     // 0..100, weighted (see calc below)
//     bottlenecks: [{ type, label, severity }]
//   }
//
// Score calc (intentionally simple — readable, easy to tune):
//   start at 100
//   subtract (100 - overallPct)               (progress gap)
//   subtract openHighSnags     × 8            (each High snag is loud)
//   subtract otherOpenSnags    × 2            (each Medium/Low less)
//   subtract incompleteAreas   × 3            (an unfinished area)
//   clamp [0, 100]
//
// A score of 100 means "no progress gap, zero open snags, every area
// 100% complete". Real handover threshold is judgement; admin uses the
// score to triage and the bottlenecks to remediate.
//
// Permissions: admin / leadingHand (canManageJob).

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isStaffRole } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isStaffRole(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'no access to job' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const data = await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [] });
  const dwellings = data.dwellings || {};

  // ── Per-area progress ─────────────────────────────────────────────────
  const areas = (job.areaGroups || []).flatMap(g => (g.areas || []).map(a => ({
    ...a, _groupName: g.name,
  })));
  const jobRt = job.roughInTasks || [];
  const jobFt = job.fitOffTasks  || [];
  const effRough = (a) => (Array.isArray(a.roughInTasks) && a.roughInTasks.length) ? a.roughInTasks : jobRt;
  const effFit   = (a) => (Array.isArray(a.fitOffTasks)  && a.fitOffTasks.length)  ? a.fitOffTasks  : jobFt;

  let overallR = 0, overallF = 0, rCount = 0, fCount = 0;
  const areaRows = areas.map(a => {
    const rMap = ((dwellings[a.id] || {}).roughIn || {}).tasks || {};
    const fMap = ((dwellings[a.id] || {}).fitOff  || {}).tasks || {};
    const aRt = effRough(a), aFt = effFit(a);
    let rPct = null, fPct = null;
    if (aRt.length) {
      rPct = Math.round(aRt.filter(t => rMap[t.id] === 'complete').length / aRt.length * 100);
      overallR += rPct / 100; rCount++;
    }
    if (aFt.length) {
      fPct = Math.round(aFt.filter(t => fMap[t.id] === 'complete').length / aFt.length * 100);
      overallF += fPct / 100; fCount++;
    }
    const components = [rPct, fPct].filter(v => v !== null);
    const oPct = components.length
      ? Math.round(components.reduce((s, v) => s + v, 0) / components.length)
      : 0;
    return {
      dwellingId: a.id,
      dwellingName: a.name,
      roughInPct: rPct, fitOffPct: fPct,
      overallPct: oPct,
      isComplete: oPct === 100,
    };
  });

  const roughInPct = rCount ? Math.round((overallR / rCount) * 100) : 0;
  const fitOffPct  = fCount ? Math.round((overallF / fCount) * 100) : 0;
  const overallPct = (rCount || fCount)
    ? Math.round((rCount && fCount) ? (roughInPct + fitOffPct) / 2 : (rCount ? roughInPct : fitOffPct))
    : 0;
  const incompleteAreas = areaRows.filter(a => !a.isComplete).length;

  // ── Snags ─────────────────────────────────────────────────────────────
  let openSnags = 0, openHighSnags = 0, unphotographed = 0;
  const openHighList = [];
  for (const s of (data.snags || [])) {
    if ((s.status || 'Open') !== 'Open') continue;
    openSnags++;
    if ((s.priority || 'Medium') === 'High') {
      openHighSnags++;
      openHighList.push(s);
    }
    if (!(s.photos || []).length) unphotographed++;
  }
  const otherOpenSnags = openSnags - openHighSnags;

  // ── Score ─────────────────────────────────────────────────────────────
  let score = 100;
  score -= (100 - overallPct);
  score -= openHighSnags * 8;
  score -= otherOpenSnags * 2;
  score -= incompleteAreas * 3;
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  // ── Bottlenecks (top 5 issues, severity-ranked) ───────────────────────
  const bottlenecks = [];
  if (overallPct < 100) {
    bottlenecks.push({
      type: 'progress-gap',
      label: 'Overall progress at ' + overallPct + '%',
      severity: overallPct < 70 ? 'high' : overallPct < 90 ? 'medium' : 'low',
    });
  }
  for (const s of openHighList.slice(0, 3)) {
    bottlenecks.push({
      type: 'open-high-snag',
      label: 'HIGH: ' + (s.desc || '(no description)').slice(0, 80),
      severity: 'high',
    });
  }
  if (incompleteAreas > 0) {
    bottlenecks.push({
      type: 'incomplete-areas',
      label: incompleteAreas + ' area' + (incompleteAreas === 1 ? '' : 's') + ' not 100% complete',
      severity: incompleteAreas > 3 ? 'high' : 'medium',
    });
  }
  if (otherOpenSnags > 0) {
    bottlenecks.push({
      type: 'open-snags',
      label: otherOpenSnags + ' other open snag' + (otherOpenSnags === 1 ? '' : 's'),
      severity: otherOpenSnags > 10 ? 'high' : otherOpenSnags > 3 ? 'medium' : 'low',
    });
  }
  if (unphotographed > 0) {
    bottlenecks.push({
      type: 'unphotographed-snags',
      label: unphotographed + ' open snag' + (unphotographed === 1 ? '' : 's') + ' without photos',
      severity: 'low',
    });
  }

  return res.status(200).json({
    jobId, jobName: job.name,
    overall: { roughInPct, fitOffPct, overallPct },
    areas: areaRows,
    outstanding: {
      snags: { open: openSnags, highOpen: openHighSnags, unphotographed },
      incompleteAreas,
    },
    readinessScore: score,
    bottlenecks: bottlenecks.slice(0, 5),
  });
};
