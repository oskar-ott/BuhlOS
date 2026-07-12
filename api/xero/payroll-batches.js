// /api/xero/payroll-batches (#893/#894) — the payroll-batch surface.
//   GET                 → batches (optionally ?periodStart&periodEnd)
//   GET ?id=<batchId>   → one batch + items + event history
//   POST {action:'preview', periodStart, periodEnd}  → validate, persist nothing
//   POST {action:'create', periodStart, periodEnd, supersedesBatchId?}
//   POST {action:'lock'|'unlock'|'delete', id}
//
// Admin-only + xero_connection flag. NOTHING here writes to Xero and nothing
// stamps time entries — batches snapshot; the CSV export keeps its own
// commit semantics and #249 owns the future push. Every batch mutation is
// audit-logged AND evented in payroll_batch_events.

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured } = require('../_lib/xero/config');
const batches = require('../_lib/xero/payroll-batches');
const { XeroError } = require('../_lib/xero/errors');

const FLAG = 'xero_connection';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function statusFor(err) {
  if (!(err instanceof XeroError)) return 500;
  if (err.category === 'not_connected' || err.category === 'pending_selection') return 409;
  if (err.category === 'validation') return 400;
  if (err.category === 'conflict') return 409;
  return 502;
}

function auditBatch(user, action, batchId, summary, metadata) {
  return audit.append({
    action,
    actorId: user.id,
    actorName: user.name || user.username || '',
    actorRole: user.role,
    targetType: 'payroll_batch',
    targetId: String(batchId),
    summary,
    metadata,
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;
  if (!(await isFlagEnabled(FLAG, user))) return res.status(404).json({ error: 'not found' });
  if (!xeroConfigured()) return res.status(503).json({ error: 'xero not configured' });

  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      const q = req.query || {};
      if (q.id) {
        const out = await batches.getBatch({ batchId: String(q.id) });
        if (!out) return res.status(404).json({ error: 'batch not found' });
        return res.status(200).json(out);
      }
      const list = await batches.listBatches({
        periodStart: DATE.test(String(q.periodStart || '')) ? String(q.periodStart) : undefined,
        periodEnd: DATE.test(String(q.periodEnd || '')) ? String(q.periodEnd) : undefined,
      });
      return res.status(200).json({ batches: list });
    }

    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const action = body.action;

      if (action === 'preview' || action === 'create') {
        const periodStart = String(body.periodStart || '');
        const periodEnd = String(body.periodEnd || '');
        if (!DATE.test(periodStart) || !DATE.test(periodEnd) || periodStart > periodEnd) {
          return res.status(400).json({ error: 'periodStart / periodEnd must be YYYY-MM-DD and ordered' });
        }
        if (action === 'preview') {
          const out = await batches.previewBatch({ periodStart, periodEnd });
          return res.status(200).json(out);
        }
        const supersedesBatchId = typeof body.supersedesBatchId === 'string' && body.supersedesBatchId
          ? body.supersedesBatchId : undefined;
        const out = await batches.createBatch({ periodStart, periodEnd, supersedesBatchId, actor: user });
        await auditBatch(
          user,
          supersedesBatchId ? 'payroll.batch_correction_created' : 'payroll.batch_created',
          out.batch.id,
          `${supersedesBatchId ? 'Correction batch' : 'Payroll batch'} ${periodStart} → ${periodEnd}: ${out.batch.status} (${out.batch.item_count} items, ${out.batch.total_hours}h)`,
          {
            periodStart, periodEnd, status: out.batch.status,
            itemCount: out.batch.item_count, totalHours: Number(out.batch.total_hours),
            sourceHash: out.batch.source_hash,
            errors: out.validation.errors.map((e) => e.code),
            warnings: out.validation.warnings.map((w) => w.code),
            ...(supersedesBatchId ? { supersedes: supersedesBatchId } : {}),
          }
        );
        return res.status(200).json(out);
      }

      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) return res.status(400).json({ error: 'id required' });

      if (action === 'lock') {
        let out;
        try {
          out = await batches.lockBatch({ batchId: id, actor: user });
        } catch (err) {
          if (err instanceof XeroError && err.category === 'conflict') {
            // honest lock refusals: drifted source / failed validation / lost race
            return res.status(409).json({
              error: err.detailMessage || 'Could not lock the batch.',
              code: err.message.includes('source_drift') ? 'source_drift'
                : err.message.includes('validation_failed') ? 'validation_failed'
                : err.message.includes('lock_lost') ? 'lock_lost'
                : 'not_lockable',
            });
          }
          throw err;
        }
        await auditBatch(user, 'payroll.batch_locked', id,
          `Locked payroll batch ${id.slice(0, 8)} (${out.batch.item_count} items, ${out.batch.total_hours}h)`,
          { sourceHash: out.batch.source_hash, itemCount: out.batch.item_count });
        return res.status(200).json(out);
      }

      if (action === 'unlock') {
        const batch = await batches.unlockBatch({ batchId: id, actor: user });
        await auditBatch(user, 'payroll.batch_unlocked', id, `Unlocked payroll batch ${id.slice(0, 8)}`, {});
        return res.status(200).json({ ok: true, batch });
      }

      if (action === 'delete') {
        const gone = await batches.deleteBatch({ batchId: id, actor: user });
        if (!gone) return res.status(404).json({ error: 'batch not found' });
        await auditBatch(user, 'payroll.batch_deleted', id,
          `Deleted ${gone.status} payroll batch ${id.slice(0, 8)} (${gone.item_count} items)`, { status: gone.status });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    const category = err instanceof XeroError ? err.category : 'unexpected';
    if (!(err instanceof XeroError)) console.error('payroll-batches error', err && err.message);
    return res.status(statusFor(err)).json({ error: 'payroll batch operation failed', errorCategory: category, detail: err instanceof XeroError ? err.message : undefined });
  }
};
