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
// row hasn't been imported — journalling those would be noise. Only a genuine PG
// ERROR while the Blob write succeeded is drift. Best-effort throughout:
// appendError never throws, and this wrapper swallows anything else too, so it
// can never throw into the mirror's already-best-effort caller.

const { appendError } = require('./error-log');

/**
 * Record a Blob-succeeded / PG-mirror-failed divergence. No-op unless the mirror
 * result reports reason === 'error' (a real PG failure, not a gated/unmirrored
 * skip). Never throws.
 *
 * @param {object} args
 * @param {string} args.domain e.g. 'hours' | 'tasks' | 'task-mirror'
 * @param {{reason?:string, error?:string}} args.result the mirror's return value
 * @param {string} [args.jobId]
 * @param {string} [args.key]  the blob key / logical target (for context)
 * @param {(p:object)=>Promise<unknown>} [args.capture] injectable for tests
 */
async function recordMirrorDrift(args = {}) {
  const { domain, result, jobId = null, key = null, capture = appendError } = args;
  try {
    if (!result || result.reason !== 'error') return; // not drift — gated/unmirrored/ok
    await capture({
      source: 'api',
      handler: 'mirror-drift',
      message: `${domain || 'mirror'} PG write failed after Blob succeeded${result.error ? `: ${result.error}` : ''}`,
      severity: 'warning',
      statusCode: null,
      jobId,
      metadata: { domain, jobId, key, reason: result.reason, error: result.error || null },
    });
  } catch (e) {
    // Never throw into an already-best-effort mirror caller.
    console.error('[mirror-drift] failed to record drift (swallowed):', e && e.message);
  }
}

module.exports = { recordMirrorDrift };
