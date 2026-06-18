const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

// Per-job state document: GET returns the current { dwellings, snags, notes }
// blob for a job — read by the Phil job screen (task state) and the read-only
// client portal (progress). This endpoint is READ-ONLY.
//
// The POST whole-document overwrite was DISARMED (#509). It used to accept a
// full client-supplied body and blindly `writeBlob('jobs/<id>/data.json',
// req.body)` — last-write-wins with no merge, no revision precondition and no
// shrink guard, so a stale or partial body could silently wipe a job's
// evidence/snags/notes (flagged in docs/rebuild-audit/15-risk-register.md and
// 00-executive-summary.md as a latent data-loss path). It has no remaining
// caller — field writes moved to field-owned patch endpoints:
//   - task state → POST /api/task-toggle      (server-side read-modify-write)
//   - snags      → POST /api/snag-quick-raise  (appends one snag, no full doc)
//   - materials  → /api/plans?action=set-dwelling-materials
// Every non-GET method now returns 405 so the unsafe overwrite cannot be reached
// again. New writers must be field-owned patch endpoints, never a full-document
// write (docs/architecture/00-rebuild-non-negotiables.md — "No full-document
// writes for collections that grow").

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Read-only endpoint: reject every mutating method up front. The disarmed
  // POST path is gone (#509); point callers at the field-owned writers.
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'method not allowed',
      detail:
        '/api/data is read-only. Whole-document writes were removed (#509) to ' +
        'prevent silent data loss — use /api/task-toggle (task state), ' +
        '/api/snag-quick-raise (snags) or /api/plans?action=set-dwelling-materials ' +
        '(materials).',
    });
  }

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const data = await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });
  return res.status(200).json(data);
};
