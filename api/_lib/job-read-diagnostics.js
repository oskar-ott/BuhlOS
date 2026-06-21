// J6/J7 — process-local diagnostics for the jobs read cutover, split by audience
// ('admin' = the J6 office read, 'phil' = the J7 field read).
//
// BEST-EFFORT, IN-MEMORY ONLY. This slice writes NOTHING to Blob or Postgres
// (the migration's "no writes" rule), so the only place a served read can be
// recorded is process memory. Consequences, stated honestly:
//   * counters reset on every cold start;
//   * they are NOT aggregated across serverless instances — they reflect only
//     the reads served by THIS warm instance.
// For a reliable point-in-time picture the /jobs-read-status page runs its own
// live, read-only probe instead of trusting these counters alone.
//
// No PII and no job content is ever stored here — only counts, booleans, a
// sanitised reason string, and a latency number.

function freshAudience() {
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

function freshState() {
  return {
    resetAt: new Date().toISOString(), // when these counters were (re)initialised — lets ops spot cold-start artefacts
    admin: freshAudience(),
    phil: freshAudience(),
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

/** Record one jobs read for an audience ('admin' | 'phil'). Never throws. */
function recordJobsRead(diag, audience = 'admin') {
  if (!diag || typeof diag !== 'object') return;
  const bucket = audience === 'phil' ? state.phil : state.admin;
  bucket.totalReads += 1;
  if (diag.readSource === 'postgres') bucket.pgServedReads += 1;
  else bucket.blobServedReads += 1;
  if (diag.fallbackUsed === true) bucket.fallbackReads += 1;
  if (typeof diag.driftedCount === 'number' && diag.driftedCount > 0) bucket.driftObservations += 1;
  bucket.lastDiag = sanitize(diag);
  bucket.lastAt = new Date().toISOString();
}

function cloneAudience(a) {
  return { ...a, lastDiag: a.lastDiag ? { ...a.lastDiag } : null };
}

/** Snapshot of the process-local counters, per audience. */
function getJobsReadDiagnostics() {
  return { resetAt: state.resetAt, admin: cloneAudience(state.admin), phil: cloneAudience(state.phil) };
}

/** Test hook — clears the in-memory counters. */
function resetJobsReadDiagnostics() {
  state = freshState();
}

module.exports = { recordJobsRead, getJobsReadDiagnostics, resetJobsReadDiagnostics };
