// DWD-04 — surface silent dual-write drift (#152).
//
// The Supabase mirrors are best-effort and Blob-authoritative: a PG write that
// fails is swallowed so field work never stops. The cost is that a
// Blob-succeeds / PG-fails DIVERGENCE was invisible until the daily sync-check.
// This records that one case — and ONLY that case — to the in-house error
// journal (platform/errors.json, #154) so it lands on the owner-console errors
// panel as a `warning`, turning silent drift into a live signal.
//
// It is deliberately narrow: gated skips (no env, flag off) and not-yet-mirrored
// rows (tenant/job/area/task not in PG) are EXPECTED while a flag is dark or a
// row hasn't been imported — journalling those would be noise. Two cases ARE
// drift: a genuine PG ERROR (reason:'error'), and a PARTIAL write (partial:true)
// where PG accepted an INCOMPLETE row. The partial case was added after an
// unmirrored job made the hours mirror drop a live entry's allocations while
// still reporting success — a row that is present but wrong is worse than one
// that is absent, because a read cutover will serve it. Best-effort throughout:
// appendError never throws, and this wrapper swallows anything else too, so it
// can never throw into the mirror's already-best-effort caller.

const { appendError } = require('./error-log');

/**
 * Record a Blob-succeeded / PG-mirror-diverged divergence. No-op unless the
 * mirror result reports reason === 'error' (a real PG failure) or partial ===
 * true (PG accepted an incomplete row) — never on a gated/unmirrored skip.
 * Never throws.
 *
 * @param {object} args
 * @param {string} args.domain e.g. 'hours' | 'tasks' | 'task-mirror'
 * @param {{reason?:string, error?:string, partial?:boolean}} args.result the mirror's return value
 * @param {string} [args.jobId]
 * @param {string} [args.key]  the blob key / logical target (for context)
 * @param {(p:object)=>Promise<unknown>} [args.capture] injectable for tests
 */
async function recordMirrorDrift(args = {}) {
  const { domain, result, jobId = null, key = null, capture = appendError } = args;
  try {
    if (!result) return;
    const partial = result.partial === true;
    if (result.reason !== 'error' && !partial) return; // not drift — gated/unmirrored/ok
    const what = partial
      ? 'PG row mirrored INCOMPLETE after Blob succeeded'
      : 'PG write failed after Blob succeeded';
    await capture({
      source: 'api',
      handler: 'mirror-drift',
      message: `${domain || 'mirror'} ${what}${result.error ? `: ${result.error}` : ''}`,
      severity: 'warning',
      statusCode: null,
      jobId,
      metadata: { domain, jobId, key, reason: result.reason, error: result.error || null, partial },
    });
  } catch (e) {
    // Never throw into an already-best-effort mirror caller.
    console.error('[mirror-drift] failed to record drift (swallowed):', e && e.message);
  }
}

module.exports = { recordMirrorDrift };
