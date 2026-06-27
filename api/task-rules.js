// Task-generation rules (#224). A single global blob of rules that say
// "areas matching THIS condition get THESE per-stage task lists". The builder's
// "Generate tasks" (api/generate-tasks.js) reads them and fills matching areas.
// Admin-only.
//
// Shape: { rules: [{ id, jobType: string|null, areaPattern: string|null,
//                     roughIn: string[], fitOff: string[] }] }
//
// Saved as ONE full-array replace (the scopeOfWork precedent) — the set is small
// and edited as a block. Validation/normalisation lives in the shared engine
// (api/_lib/task-rules.js) so the maintenance + apply paths can't drift.
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { normaliseRules } = require('./_lib/task-rules');

const BLOB_KEY = 'task-rules.json';

async function readRules() {
  const data = await readBlob(BLOB_KEY, { rules: [] });
  return Array.isArray(data.rules) ? data.rules : [];
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const action = (req.query && req.query.action) || '';

  // GET — list the rules.
  if (req.method === 'GET') {
    const rules = await readRules();
    return res.status(200).json({ rules });
  }

  // POST ?action=save  { rules: [...] } — full-array replace.
  if (req.method === 'POST' && action === 'save') {
    const incoming = (req.body && req.body.rules) || [];
    const { rules, error } = normaliseRules(incoming, nanoid);
    if (error) return res.status(400).json({ error });
    await writeBlob(BLOB_KEY, { rules });
    return res.status(200).json({ rules });
  }

  return res.status(400).json({ error: 'unknown action' });
};
