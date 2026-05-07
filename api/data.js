const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

const VALID_TASK_STATES = new Set(['not_started', 'in_progress', 'complete']);

// Scans dwellings for roughIn/fitOff task values and rejects anything that
// isn't a valid three-state string. Returns an error string or null.
function validateTaskStates(body) {
  const dwellings = body && body.dwellings;
  if (!dwellings || typeof dwellings !== 'object') return null;
  for (const [dwId, dw] of Object.entries(dwellings)) {
    for (const stageKey of ['roughIn', 'fitOff']) {
      const tasks = dw && dw[stageKey] && dw[stageKey].tasks;
      if (!tasks || typeof tasks !== 'object') continue;
      for (const [taskId, val] of Object.entries(tasks)) {
        if (!VALID_TASK_STATES.has(val)) {
          return `dwellings.${dwId}.${stageKey}.tasks.${taskId}: invalid value "${val}" (must be not_started|in_progress|complete)`;
        }
      }
    }
  }
  return null;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const KEY = `jobs/${jobId}/data.json`;

  if (req.method === 'GET') {
    const data = await readBlob(KEY, { dwellings: {}, snags: [], notes: [] });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const err = validateTaskStates(req.body);
    if (err) return res.status(400).json({ error: err });
    try {
      await writeBlob(KEY, req.body);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
