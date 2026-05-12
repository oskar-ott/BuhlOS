// Fast-path single task state mutation.
//
//   POST /api/task-toggle?jobId=<id>
//        body: { areaId, stage, taskId, state }
//
//   stage  : 'roughIn' | 'fitOff'
//   state  : 'not_started' | 'in_progress' | 'complete'
//
// Atomically reads the job data blob, sets dwellings[areaId][stage]
// .tasks[taskId] = state, writes back. Same end state as posting the
// whole data document via /api/data, but with vastly less network — a
// mobile checkbox tick no longer ships the entire snags + dwellings
// blob over 3G.
//
// Why a dedicated endpoint:
//   The Phase 03-05 mobile UI ticks tasks constantly. The existing
//   pattern (GET full data → modify → POST full data) means every tick:
//     - downloads ~hundreds of KB of unrelated snag/photo data
//     - uploads ~hundreds of KB back
//     - opens a race window where another client's POST can stomp
//   This endpoint does one server-side mutation per request, so:
//     - request body is tiny
//     - server is the single point of truth
//     - the read-modify-write window is collapsed to a few ms
//
// Note: this still uses the full-document write under the hood (Vercel
// Blob doesn't support partial JSON patch). If two clients toggle two
// different tasks simultaneously the late one will win. That's the
// same behaviour as today's /api/data POST, just with a much narrower
// window.
//
// Permissions: write access to the job (admin / LH / tradie assigned).
// Client: 403.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

const VALID_STATES = new Set(['not_started', 'in_progress', 'complete']);
const VALID_STAGES = new Set(['roughIn', 'fitOff']);

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const me = await requireAuth(req, res, { jobId });
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (!canWrite(me, jobId)) return res.status(403).json({ error: 'no write access to job' });

  const { areaId, stage, taskId, state } = req.body || {};
  if (!areaId) return res.status(400).json({ error: 'areaId required' });
  if (!stage || !VALID_STAGES.has(stage)) {
    return res.status(400).json({ error: 'stage must be roughIn or fitOff' });
  }
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  if (!state || !VALID_STATES.has(state)) {
    return res.status(400).json({ error: 'state must be not_started, in_progress or complete' });
  }

  // Verify the area + task actually belong to the job. Cheap guard against
  // a stale mobile cache POSTing a deleted area id; without it we'd write
  // ghost state that never renders anywhere.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const area = (job.areaGroups || [])
    .flatMap(g => (g.areas || []))
    .find(a => a.id === areaId);
  if (!area) return res.status(404).json({ error: 'area not found on job' });
  const taskList = stage === 'roughIn'
    ? ((Array.isArray(area.roughInTasks) && area.roughInTasks.length) ? area.roughInTasks : (job.roughInTasks || []))
    : ((Array.isArray(area.fitOffTasks)  && area.fitOffTasks.length)  ? area.fitOffTasks  : (job.fitOffTasks  || []));
  if (!taskList.some(t => t.id === taskId)) {
    return res.status(404).json({ error: 'task not found for area + stage' });
  }

  // Read → mutate → write the data blob.
  const KEY = `jobs/${jobId}/data.json`;
  const data = await readBlob(KEY, { dwellings: {}, snags: [], notes: [] });
  data.dwellings = data.dwellings || {};
  const dw = (data.dwellings[areaId] = data.dwellings[areaId] || {});
  const stageObj = (dw[stage] = dw[stage] || { tasks: {} });
  stageObj.tasks = stageObj.tasks || {};

  const previous = stageObj.tasks[taskId] || 'not_started';
  if (previous === state) {
    // No-op — return current state so the client can reconcile without writing.
    return res.status(200).json({
      jobId, areaId, stage, taskId,
      state, previous,
      changed: false,
    });
  }
  stageObj.tasks[taskId] = state;

  // Light audit on the dwelling so we know who touched this task last.
  // Kept minimal — not a full audit-log entry; that's #53 territory.
  dw.lastTouchedBy = me.username;
  dw.lastTouchedAt = new Date().toISOString();

  try {
    await writeBlob(KEY, data);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  return res.status(200).json({
    jobId, areaId, stage, taskId,
    state, previous,
    changed: true,
    by: me.username,
    at: dw.lastTouchedAt,
  });
};
