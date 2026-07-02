// Process-local diagnostics for the ADMIN single-job PG direct read (#152,
// api/_lib/job-detail-pg.js). Deliberately a separate counter module from the
// J6 list-overlay diagnostics (job-read-diagnostics.js) so the two admin read
// paths are observed independently.
//
// BEST-EFFORT, IN-MEMORY ONLY (the read slice writes nothing). Counters reset on
// cold start and are not aggregated across serverless instances — they reflect
// the admin single-job reads attempted by THIS warm instance. No PII, no job
// content — only counts, booleans, a sanitised reason, and latency.

function freshState() {
  return {
    resetAt: new Date().toISOString(),
    totalReads: 0, // admin single-job GETs that reached the PG fast-path attempt
    pgServedReads: 0, // both gates passed → served from Postgres (monolith skipped)
    blobServedReads: 0, // fell through to the full jobs.json read (flag off / miss / stale / mismatch / error)
    fallbackReads: 0, // PG was attempted (extras fresh) but Blob served (absent/mismatch/error)
    parityMismatches: 0, // extras fresh but the PG hash didn't match (mirror lag/drift)
    extrasRebuilds: 0, // reads that asked the full path to rebuild the extras record
    lastDiag: null,
    lastAt: null,
  };
}
let state = freshState();

function sanitize(d) {
  return {
    source: d.source, reason: d.reason, flagOn: d.flagOn === true,
    parityPass: d.parityPass === null ? null : d.parityPass === true,
    rebuildExtras: d.rebuildExtras === true,
    latencyMs: typeof d.latencyMs === 'number' ? d.latencyMs : null,
    fallbackUsed: d.fallbackUsed === true,
  };
}

/** Record one admin single-job read attempt. Never throws. */
function recordAdminJobDetailRead(diag) {
  if (!diag || typeof diag !== 'object') return;
  state.totalReads += 1;
  if (diag.source === 'postgres') state.pgServedReads += 1;
  else state.blobServedReads += 1;
  if (diag.fallbackUsed === true) state.fallbackReads += 1;
  if (diag.parityPass === false) state.parityMismatches += 1;
  if (diag.rebuildExtras === true) state.extrasRebuilds += 1;
  state.lastDiag = sanitize(diag);
  state.lastAt = new Date().toISOString();
}

function getAdminJobDetailReadDiagnostics() {
  return { ...state, lastDiag: state.lastDiag ? { ...state.lastDiag } : null };
}
function resetAdminJobDetailReadDiagnostics() {
  state = freshState();
}

module.exports = {
  recordAdminJobDetailRead,
  getAdminJobDetailReadDiagnostics,
  resetAdminJobDetailReadDiagnostics,
};
