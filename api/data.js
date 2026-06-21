const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isFieldRole, isLeadingHandRole, isAdminRole } = require('./_lib/auth');
const { readPhilTaskStatus, readAdminTaskStatus } = require('./_lib/task-read');
const { readAdminEvidence } = require('./_lib/evidence-read');
const { recordTaskRead } = require('./_lib/task-read-diagnostics');
const { recordAdminTaskRead } = require('./_lib/admin-task-read-diagnostics');
const { recordAdminEvidenceRead } = require('./_lib/admin-evidence-read-diagnostics');

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

  // DARK task-status read cutover. The job's task statuses are confirmed against
  // the Postgres mirror and served from PG only when byte-faithful to Blob (else
  // Blob fallback) — output is provably identical to Blob, so a reader can never
  // lose visibility or see a stale status (a not-yet-mirrored toggle fails parity
  // → Blob). The same parity engine serves two audiences, each behind its own
  // flag, so the field and office cut over independently; CLIENTS always read pure
  // Blob (out of scope). Reader isolation is the requireAuth({ jobId }) gate above.
  //   * J10 — FIELD/leading-hand, supabase_read_phil_tasks
  //   * J11 — ADMIN/office,        supabase_read_admin_tasks
  if (isFieldRole(user.role) || isLeadingHandRole(user.role)) {
    const overlay = await readPhilTaskStatus({ jobId, data });
    recordTaskRead(overlay.diag);
    return res.status(200).json(overlay.data);
  }
  if (isAdminRole(user.role)) {
    // ADMIN/office: task-status overlay (J11), then evidence-metadata overlay —
    // each independently flag-gated + parity-gated, each falling back to Blob, so
    // output stays byte-identical to Blob. Evidence overlay is admin-only and
    // touches data.evidence[] only (proof-status and other sections untouched).
    const taskOverlay = await readAdminTaskStatus({ jobId, data });
    recordAdminTaskRead(taskOverlay.diag);
    const evidenceOverlay = await readAdminEvidence({ jobId, data: taskOverlay.data });
    recordAdminEvidenceRead(evidenceOverlay.diag);
    return res.status(200).json(evidenceOverlay.data);
  }
  return res.status(200).json(data); // clients (and any other tier) — pure Blob
};
