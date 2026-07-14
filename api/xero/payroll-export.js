// /api/xero/payroll-export (#249) — the first Xero WRITE surface. Exports a
// LOCKED payroll batch to Xero Payroll AU as DRAFT timesheets, then reconciles
// each by reading it back.
//   POST {action:'preview',   batchId} → dry-run payload + per-worker verdicts (NO write)
//   POST {action:'export',    batchId} → POST draft timesheets + immediate readback verify
//   POST {action:'retry',     batchId} → re-run only workers not yet verified
//   POST {action:'reconcile', batchId} → re-read accepted-but-unverified (NO new POST)
//   GET  ?batchId                      → per-worker export state (attempts/events)
//   GET  ?batchId&format=csv           → batch-snapshot CSV fallback (no Xero call)
//
// Admin-only. READS (state + CSV fallback) need only `xero_connection` so the
// CSV works with the write flag off and even while the token is disconnected.
// WRITES (preview/export/retry/reconcile) additionally require the independent
// `xero_payroll_export` flag — turning the write gate off never touches time
// capture, the CSV fallback, or the read-only reference sync. DRAFT timesheets
// only — no pay runs, approvals, STP, tax, super or payslips (ADR #609).

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured } = require('../_lib/xero/config');
const exportSvc = require('../_lib/xero/timesheet-export');
const { XeroError } = require('../_lib/xero/errors');

const CONNECT_FLAG = 'xero_connection';
const EXPORT_FLAG = 'xero_payroll_export';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusFor(err) {
  if (!(err instanceof XeroError)) return 500;
  if (['not_connected', 'pending_selection', 'conflict', 'reconnect_required'].includes(err.category)) return 409;
  if (err.category === 'validation') return 400;
  if (err.category === 'forbidden') return 403;
  if (err.category === 'rate_limit') return 429;
  return 502;
}

function auditExport(user, action, batchId, summary, metadata) {
  return audit.append({
    action, actorId: user.id, actorName: user.name || user.username || '', actorRole: user.role,
    targetType: 'payroll_batch', targetId: String(batchId), summary, metadata,
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;
  // xero_connection = the Xero feature is on at all. Required for every route
  // (reads included). WRITE actions additionally require the write flag (below).
  if (!(await isFlagEnabled(CONNECT_FLAG, user))) return res.status(404).json({ error: 'not found' });
  if (!xeroConfigured()) return res.status(503).json({ error: 'xero not configured' });

  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      const q = req.query || {};
      const batchId = String(q.batchId || '');
      if (!UUID.test(batchId)) return res.status(400).json({ error: 'batchId (uuid) required' });

      // CSV fallback — pure batch-snapshot read: no Xero call, no write flag, no
      // state change. Works while Xero is disconnected. Never stamps entries.
      if (String(q.format || '') === 'csv') {
        const out = await exportSvc.batchCsv({ batchId });
        if (!out) return res.status(404).json({ error: 'batch not found' });
        await auditExport(user, 'payroll.csv_downloaded', batchId,
          `Downloaded payroll batch ${batchId.slice(0, 8)} CSV (${out.rowCount} rows)`, { rowCount: out.rowCount });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
        res.setHeader('X-Row-Count', String(out.rowCount));
        return res.status(200).send(out.csv);
      }

      const out = await exportSvc.exportState({ batchId });
      if (!out) return res.status(404).json({ error: 'batch not found' });
      return res.status(200).json(out);
    }

    if (req.method === 'POST') {
      // Writes + the export preview require the independent write flag.
      if (!(await isFlagEnabled(EXPORT_FLAG, user))) return res.status(404).json({ error: 'not found' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const action = body.action;
      const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : '';
      if (!UUID.test(batchId)) return res.status(400).json({ error: 'batchId (uuid) required' });

      if (action === 'preview') {
        const out = await exportSvc.previewExport({ batchId });
        await auditExport(user, 'payroll.export_previewed', batchId,
          `Previewed Xero export for batch ${batchId.slice(0, 8)} (${out.counts.toSend} to send, ${out.counts.blocked} blocked, ${out.counts.toSkip} unchanged)`,
          { counts: out.counts, org: out.org.externalTenantId });
        return res.status(200).json(out);
      }

      if (action === 'export' || action === 'retry') {
        const out = action === 'export'
          ? await exportSvc.exportBatch({ batchId, actor: user })
          : await exportSvc.retryExport({ batchId, actor: user });
        const verified = out.workers.filter((w) => w.outcome === 'verified').length;
        const failed = out.workers.filter((w) => ['rejected', 'retry_required', 'drifted', 'blocked'].includes(w.outcome)).length;
        await auditExport(user,
          action === 'export' ? 'payroll.exported_to_xero' : 'payroll.export_retried', batchId,
          `${action === 'export' ? 'Exported' : 'Retried'} batch ${batchId.slice(0, 8)} → ${verified} verified, ${failed} failed (batch ${out.batch.status})`,
          { batchStatus: out.batch.status, verified, failed,
            workers: out.workers.map((w) => ({ worker: w.worker, outcome: w.outcome, xeroTimesheetId: w.xeroTimesheetId || null, correlationId: w.correlationId || null })) });
        return res.status(200).json(out);
      }

      if (action === 'reconcile') {
        const out = await exportSvc.reconcileExport({ batchId, actor: user });
        const verified = out.workers.filter((w) => w.outcome === 'verified').length;
        const drifted = out.workers.filter((w) => w.outcome === 'drifted').length;
        await auditExport(user, 'payroll.reconciled', batchId,
          `Reconciled batch ${batchId.slice(0, 8)} → ${verified} verified, ${drifted} drifted (batch ${out.batch.status})`,
          { batchStatus: out.batch.status, verified, drifted,
            workers: out.workers.map((w) => ({ worker: w.worker, outcome: w.outcome, xeroTimesheetId: w.xeroTimesheetId || null })) });
        return res.status(200).json(out);
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    const category = err instanceof XeroError ? err.category : 'unexpected';
    if (!(err instanceof XeroError)) console.error('payroll-export error', err && err.message);
    return res.status(statusFor(err)).json({ error: 'payroll export failed', errorCategory: category, detail: err instanceof XeroError ? err.message : undefined });
  }
};
