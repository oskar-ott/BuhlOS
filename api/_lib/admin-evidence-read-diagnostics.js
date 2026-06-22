// Process-local diagnostics for the ADMIN evidence-metadata READ OVERLAY
// (supabase_read_admin_evidence). Separate counter from the task-read modules and
// from the evidence parity PROBE, so the office evidence cutover is observed
// independently. Same honest caveats as the task-read diagnostics:
//
// BEST-EFFORT, IN-MEMORY ONLY (the read slice writes nothing). Counters reset on
// cold start and are not aggregated across serverless instances — they reflect the
// admin evidence reads served by THIS warm instance. No PII, no evidence content,
// no ids/URLs/note bodies — only counts, booleans, a sanitised reason, and latency.

function freshState() {
  return {
    resetAt: new Date().toISOString(),
    totalReads: 0, // admin evidence reads served (flag on)
    pgServedReads: 0, // reads where parity passed → served from Postgres
    blobServedReads: 0, // reads served from Blob (flag off / fallback / parity fail)
    fallbackReads: 0, // reads where PG was attempted but Blob served (error/parity)
    parityMismatches: 0, // reads where PG was reconstructed but parity failed
    lastDiag: null,
    lastAt: null,
  };
}
let state = freshState();

// Keep only non-identifying scalar fields — never an evidence id, URL or note body.
function sanitize(d) {
  return {
    source: d.source, reason: d.reason, flagOn: d.flagOn === true,
    parityPass: d.parityPass === null ? null : d.parityPass === true,
    matched: d.matched || 0, mismatched: d.mismatched || 0,
    missingInPg: d.missingInPg || 0, missingInBlob: d.missingInBlob || 0,
    latencyMs: typeof d.latencyMs === 'number' ? d.latencyMs : null, fallbackUsed: d.fallbackUsed === true,
  };
}

/** Record one admin evidence read. Never throws. */
function recordAdminEvidenceRead(diag) {
  if (!diag || typeof diag !== 'object') return;
  state.totalReads += 1;
  if (diag.source === 'postgres') state.pgServedReads += 1;
  else state.blobServedReads += 1;
  if (diag.fallbackUsed === true) state.fallbackReads += 1;
  if (diag.parityPass === false) state.parityMismatches += 1;
  state.lastDiag = sanitize(diag);
  state.lastAt = new Date().toISOString();
}

function getAdminEvidenceReadDiagnostics() {
  return { ...state, lastDiag: state.lastDiag ? { ...state.lastDiag } : null };
}
function resetAdminEvidenceReadDiagnostics() {
  state = freshState();
}

module.exports = { recordAdminEvidenceRead, getAdminEvidenceReadDiagnostics, resetAdminEvidenceReadDiagnostics };
