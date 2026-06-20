// J6 — process-local diagnostics for the admin jobs read cutover.
//
// BEST-EFFORT, IN-MEMORY ONLY. This slice writes NOTHING to Blob or Postgres
// (the migration's "no writes" rule), so the only place a served read can be
// recorded is process memory. Consequences, stated honestly:
//   * counters reset on every cold start;
//   * they are NOT aggregated across serverless instances — they reflect only
//     the admin reads served by THIS warm instance.
// For a reliable point-in-time picture the /jobs-read-status page runs its own
// live, read-only probe instead of trusting these counters alone.
//
// No PII and no job content is ever stored here — only counts, booleans, a
// sanitised reason string, and a latency number.

function freshState() {
  return {
    totalReads: 0,
    pgServedReads: 0, // reads where ≥1 job's structure was served from Postgres
    blobServedReads: 0, // reads served entirely from Blob
    fallbackReads: 0, // reads where PG was attempted but threw → full Blob fallback
    driftObservations: 0, // reads where ≥1 in-both job had drifted PG↔Blob
    lastDiag: null,
    lastAt: null,
  };
}

let state = freshState();

// Keep only the non-identifying scalar fields of a per-read diag.
function sanitize(d) {
  return {
    readSource: d.readSource,
    reason: d.reason,
    flagOn: d.flagOn === true,
    reconstructed: d.reconstructed === true,
    parityMatch: d.parityMatch === null ? null : d.parityMatch === true,
    pgFaithfulCount: d.pgFaithfulCount || 0,
    driftedCount: d.driftedCount || 0,
    onlyInBlobCount: d.onlyInBlobCount || 0,
    onlyInPgCount: d.onlyInPgCount || 0,
    matchedCount: d.matchedCount || 0,
    latencyMs: typeof d.latencyMs === 'number' ? d.latencyMs : null,
    fallbackUsed: d.fallbackUsed === true,
  };
}

/** Record one admin jobs read. Never throws. */
function recordJobsRead(diag) {
  if (!diag || typeof diag !== 'object') return;
  state.totalReads += 1;
  if (diag.readSource === 'postgres') state.pgServedReads += 1;
  else state.blobServedReads += 1;
  if (diag.fallbackUsed === true) state.fallbackReads += 1;
  if (typeof diag.driftedCount === 'number' && diag.driftedCount > 0) state.driftObservations += 1;
  state.lastDiag = sanitize(diag);
  state.lastAt = new Date().toISOString();
}

/** Snapshot of the process-local counters. */
function getJobsReadDiagnostics() {
  return { ...state, lastDiag: state.lastDiag ? { ...state.lastDiag } : null };
}

/** Test hook — clears the in-memory counters. */
function resetJobsReadDiagnostics() {
  state = freshState();
}

module.exports = { recordJobsRead, getJobsReadDiagnostics, resetJobsReadDiagnostics };
