// Bridge: existing Xero sync operations → the #251 sync-outcome recorder.
//
// The M4 export lib keeps its OWN durable per-worker record (immutable PG
// attempts/events) — that stays authoritative. This bridge is the VISIBILITY
// projection: per-BATCH rollups into the cross-sync working set the health
// dashboard reads, at the batch granularity the office actually drives
// (retry is batch-wide through the original guards, so worker granularity
// buys nothing here).
//
// Recording is #355-classified best-effort-with-loud-surfacing: the export
// itself already concluded (and is durably recorded in PG), so a recorder
// write failure must not fail the operation — but it MUST reach the caller's
// response (`syncLogWarning`), never vanish.
//
// Retry handlers register at module load (the recorder's registry is the
// ONLY retry path): 'timesheet_export' re-enters retryExport, and
// 'reference_sync' re-runs syncReferenceData for the one group — both the
// original code paths with their idempotency guards intact.

const syncLog = require('../xero-sync-log');
const exportSvc = require('./timesheet-export');
const refSync = require('./reference-sync');

/** Worker outcomes that leave a batch not-landed. Mirrors the handler's
 *  failed-set in api/xero/payroll-export.js. */
const FAILED_OUTCOMES = new Set(['rejected', 'retry_required', 'drifted', 'blocked']);

/** Pure per-batch rollup of an export/retry/reconcile result. */
function summariseBatch(out) {
  const workers = (out && out.workers) || [];
  const failed = workers.filter((w) => FAILED_OUTCOMES.has(w.outcome));
  const verified = workers.filter((w) => w.outcome === 'verified').length;
  const skipped = workers.filter((w) => w.outcome === 'skipped').length;
  const landed = failed.length === 0;
  const category = failed.length
    ? failed.find((w) => w.category)?.category || 'unknown_remote'
    : undefined;
  return {
    landed,
    verified,
    skipped,
    failedCount: failed.length,
    total: workers.length,
    category,
    reason: landed
      ? `${verified} verified, ${skipped} already landed`
      : `${failed.length} of ${workers.length} workers not landed (${failed
          .map((w) => `${w.worker}: ${w.outcome}`)
          .join(', ')})`,
    failedWorkers: failed.map((w) => ({ worker: w.worker, outcome: w.outcome, category: w.category || null })),
  };
}

/**
 * Record a batch operation's rollup. Returns a warning string when the
 * recorder write failed (caller surfaces it in the response), else null.
 */
async function recordBatchOutcome({ batchId, out }) {
  const s = summariseBatch(out);
  try {
    await syncLog.record({
      syncType: 'timesheet_export',
      operation: `tsx:${batchId}`,
      recordRef: String(batchId),
      status: s.landed ? 'ok' : 'failed',
      reason: s.reason,
      ...(s.category ? { category: s.category } : {}),
      ...(s.landed ? {} : { xeroError: { failedWorkers: s.failedWorkers } }),
    });
    return null;
  } catch (e) {
    console.error('sync-log-bridge: timesheet outcome not recorded', e);
    return `sync-log write failed (${e.message}) — the export outcome above is authoritative; the health dashboard may lag`;
  }
}

/** Record per-group reference-sync outcomes. Same warning contract. */
async function recordReferenceOutcomes(results) {
  try {
    for (const r of results || []) {
      await syncLog.record({
        syncType: 'reference_sync',
        operation: `ref:${r.group}`,
        recordRef: String(r.group),
        status: r.status === 'ok' ? 'ok' : 'failed',
        reason:
          r.status === 'ok'
            ? `${r.itemCount ?? 0} items cached`
            : `reference fetch failed (${r.errorCategory || 'unknown'})`,
        ...(r.status === 'ok' || !r.errorCategory ? {} : { category: r.errorCategory }),
      });
    }
    return null;
  } catch (e) {
    console.error('sync-log-bridge: reference outcome not recorded', e);
    return `sync-log write failed (${e.message}) — the sync result above is authoritative; the health dashboard may lag`;
  }
}

// ── Retry handlers (registered at load; the dashboard endpoint requires
//    this module so the registrations exist in its process) ───────────────

const RETRY_ACTOR = { id: 'sync-log-retry', username: 'sync-log', name: 'Sync health retry' };

syncLog.registerRetryHandler('timesheet_export', async (item) => {
  const batchId = item.recordRef;
  const out = await exportSvc.retryExport({ batchId, actor: RETRY_ACTOR });
  const s = summariseBatch(out);
  if (s.landed) {
    // Nothing was actually sent (every worker already verified) → the batch
    // was fixed elsewhere (a manual re-push, a reconcile) — say so honestly.
    const meanwhile = s.verified === 0 && s.skipped > 0;
    return { outcome: meanwhile ? 'resolved_meanwhile' : 'resolved', reason: s.reason };
  }
  return { outcome: 'failed', reason: s.reason, category: s.category, xeroError: { failedWorkers: s.failedWorkers } };
});

syncLog.registerRetryHandler('reference_sync', async (item) => {
  const group = item.recordRef;
  const results = await refSync.syncReferenceData({ groups: [group], actor: RETRY_ACTOR });
  const r = (results || []).find((x) => x.group === group);
  if (r && r.status === 'ok') return { outcome: 'resolved', reason: `${r.itemCount ?? 0} items cached` };
  return {
    outcome: 'failed',
    reason: `reference fetch failed (${(r && r.errorCategory) || 'unknown'})`,
    category: r && r.errorCategory,
  };
});

module.exports = { summariseBatch, recordBatchOutcome, recordReferenceOutcomes, FAILED_OUTCOMES };
