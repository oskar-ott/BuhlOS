const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isFieldRole, isLeadingHandRole, isAdminRole } = require('./_lib/auth');
const { isFlagOn } = require('./_lib/feature-flags');
const { readPhilTaskStatus, readAdminTaskStatus } = require('./_lib/task-read');
const { readAdminEvidence, readPhilEvidence } = require('./_lib/evidence-read');
const { recordTaskRead } = require('./_lib/task-read-diagnostics');
const { recordAdminTaskRead } = require('./_lib/admin-task-read-diagnostics');
const { recordAdminEvidenceRead } = require('./_lib/admin-evidence-read-diagnostics');
const { recordPhilEvidenceRead } = require('./_lib/phil-evidence-read-diagnostics');

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

  const field = isFieldRole(user.role) || isLeadingHandRole(user.role);
  const admin = !field && isAdminRole(user.role);

  // Perf: this endpoint used to run FOUR long reads strictly in sequence —
  // data.json, then the task overlay's whole-jobs.json monolith re-read (it
  // projects ONE job but needs the job's structure), then the task overlay's PG
  // queries, then the evidence overlay's PG queries — the "~3-5s task-list
  // skeleton" on the Phil job screen. All four are independent of each other's
  // RESULTS, so they now run concurrently:
  //   1. jobs.json is prefetched here (only when the tier's task flag is on, so
  //      the dark path pays nothing) and handed to the overlay via its injectable
  //      readBlob — same bytes, same 5s-TTL cache, just started ~2s earlier.
  //   2. The two overlays run in parallel on the SAME Blob doc (see the
  //      composition note below).
  const taskFlagKey = field ? 'supabase_read_phil_tasks' : 'supabase_read_admin_tasks';
  const jobsPrefetch =
    (field || admin) && process.env.SUPABASE_DB_URL
      ? isFlagOn(taskFlagKey)
          .then((on) => (on === true ? readBlob('jobs.json', { jobs: [] }) : null))
          .catch(() => null) // never rejects; null → overlay falls back to its own read
      : null;
  const overlayReadBlob = (key, fallback) => {
    if (jobsPrefetch && key === 'jobs.json') {
      return jobsPrefetch.then((pre) => (pre !== null ? pre : readBlob(key, fallback)));
    }
    return readBlob(key, fallback);
  };

  const data = await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });

  // DARK task-status read cutover. The job's task statuses are confirmed against
  // the Postgres mirror and served from PG only when byte-faithful to Blob (else
  // Blob fallback) — output is provably identical to Blob, so a reader can never
  // lose visibility or see a stale status (a not-yet-mirrored toggle fails parity
  // → Blob). The same parity engine serves two audiences, each behind its own
  // flag, so the field and office cut over independently; CLIENTS always read pure
  // Blob (out of scope). Reader isolation is the requireAuth({ jobId }) gate above.
  // Each tier also runs an evidence-metadata overlay (data.evidence[] only, same
  // per-job parity gate, Blob fallback) — admin and field each behind their own
  // flag. Proof-status (job-control.json) is untouched.
  //   * FIELD/leading-hand — supabase_read_phil_tasks, supabase_read_phil_evidence
  //   * ADMIN/office       — supabase_read_admin_tasks, supabase_read_admin_evidence
  //
  // COMPOSITION (why concurrent == the old chained result): the two overlays own
  // DISJOINT sections of the doc — hard scope contracts in api/_lib/task-read.js
  // ("never adds a dwelling entry", rewrites existing dwelling task STATUSES only,
  // never touches evidence[]) and api/_lib/evidence-read.js ("never adds/removes
  // an evidence item, never touches non-evidence sections"). So the evidence
  // overlay's parity check and output are identical whether it runs on the raw
  // doc or on the task overlay's output, and stitching evidence[] onto the task
  // output reproduces the chained doc exactly. Both overlays are additionally
  // parity-gated (PG served only when byte-equal to Blob), so the composed doc
  // stays byte-identical to Blob either way.
  const composeOverlays = (taskData, evidenceData) => {
    if (Object.prototype.hasOwnProperty.call(evidenceData, 'evidence')) {
      taskData.evidence = evidenceData.evidence;
    }
    return taskData;
  };

  if (field) {
    // FIELD/leading-hand: task-status overlay (J10) ∥ evidence-metadata overlay —
    // each independently flag-gated + parity-gated, each falling back to Blob, so
    // output stays byte-identical to Blob. The evidence overlay is field-tier here
    // (supabase_read_phil_evidence, separate from the admin evidence flag) and
    // touches data.evidence[] only (proof-status and other sections untouched).
    const [taskOverlay, evidenceOverlay] = await Promise.all([
      readPhilTaskStatus({ jobId, data, readBlob: overlayReadBlob }),
      readPhilEvidence({ jobId, data }),
    ]);
    recordTaskRead(taskOverlay.diag);
    recordPhilEvidenceRead(evidenceOverlay.diag);
    return res.status(200).json(composeOverlays(taskOverlay.data, evidenceOverlay.data));
  }
  if (admin) {
    // ADMIN/office: task-status overlay (J11) ∥ evidence-metadata overlay — same
    // gates and same disjoint-section composition as the field tier above.
    const [taskOverlay, evidenceOverlay] = await Promise.all([
      readAdminTaskStatus({ jobId, data, readBlob: overlayReadBlob }),
      readAdminEvidence({ jobId, data }),
    ]);
    recordAdminTaskRead(taskOverlay.diag);
    recordAdminEvidenceRead(evidenceOverlay.diag);
    return res.status(200).json(composeOverlays(taskOverlay.data, evidenceOverlay.data));
  }
  return res.status(200).json(data); // clients (and any other tier) — pure Blob
};

// #154: capture any error that ESCAPES the handler above (its internal
// try/catches stay the primary handling) — journal + 500. Signature unchanged.
const { withErrorCapture } = require('./_lib/error-wrap');
module.exports = withErrorCapture(module.exports, 'data');
