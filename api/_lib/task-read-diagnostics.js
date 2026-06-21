// J10 — process-local diagnostics for the Phil task-status read cutover.
//
// BEST-EFFORT, IN-MEMORY ONLY (the read slice writes nothing). Counters reset on
// cold start and are not aggregated across serverless instances — they reflect the
// task reads served by THIS warm instance. No PII, no task content — only counts,
// booleans, a sanitised reason, and latency.

function freshState() {
  return {
    resetAt: new Date().toISOString(),
    totalReads: 0, // Phil task-status reads served (flag on)
    pgServedReads: 0, // reads where parity passed → served from Postgres
    blobServedReads: 0, // reads served from Blob (flag off / fallback / parity fail)
    fallbackReads: 0, // reads where PG was attempted but Blob served (error/parity)
    parityMismatches: 0, // reads where PG was reconstructed but parity failed
    lastDiag: null,
    lastAt: null,
  };
}
let state = freshState();

function sanitize(d) {
  return {
    source: d.source, reason: d.reason, flagOn: d.flagOn === true,
    parityPass: d.parityPass === null ? null : d.parityPass === true,
    matched: d.matched || 0, mismatched: d.mismatched || 0, orphans: d.orphans || 0,
    unresolved: d.unresolved || 0, hashMatch: d.hashMatch === null ? null : d.hashMatch === true,
    latencyMs: typeof d.latencyMs === 'number' ? d.latencyMs : null, fallbackUsed: d.fallbackUsed === true,
  };
}

/** Record one Phil task-status read. Never throws. */
function recordTaskRead(diag) {
  if (!diag || typeof diag !== 'object') return;
  state.totalReads += 1;
  if (diag.source === 'postgres') state.pgServedReads += 1;
  else state.blobServedReads += 1;
  if (diag.fallbackUsed === true) state.fallbackReads += 1;
  if (diag.parityPass === false) state.parityMismatches += 1;
  state.lastDiag = sanitize(diag);
  state.lastAt = new Date().toISOString();
}

function getTaskReadDiagnostics() {
  return { ...state, lastDiag: state.lastDiag ? { ...state.lastDiag } : null };
}
function resetTaskReadDiagnostics() {
  state = freshState();
}

module.exports = { recordTaskRead, getTaskReadDiagnostics, resetTaskReadDiagnostics };
