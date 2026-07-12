// /api/xero/worker-mappings (#248) — the explicit worker ↔ Xero employee
// mapping surface.
//   GET  → the mapping board (workers × link state × suggestion × legacy-id
//          validity × org-mismatch, the employee picker, honest cache
//          provenance)
//   POST {action:'map', workerId, employeeId, source?} → confirm/remap a link
//   POST {action:'unmap', workerId}                    → remove a link
//
// Admin-only + xero_connection flag (mapping pairs identities with payroll —
// nothing here writes to Xero). Every change is audit-logged; a 1:1 conflict
// names the existing holder; a terminated employee can still be confirmed
// (final-pay case) but the response says so honestly.

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured } = require('../_lib/xero/config');
const mappings = require('../_lib/xero/worker-mappings');
const { XeroError } = require('../_lib/xero/errors');

const FLAG = 'xero_connection';

function statusFor(err) {
  if (!(err instanceof XeroError)) return 500;
  if (err.category === 'not_connected' || err.category === 'pending_selection') return 409;
  if (err.category === 'validation') return 400;
  if (err.category === 'conflict') return 409;
  return 502;
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;
  if (!(await isFlagEnabled(FLAG, user))) return res.status(404).json({ error: 'not found' });
  if (!xeroConfigured()) return res.status(503).json({ error: 'xero not configured' });

  if (req.method === 'GET') {
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(await mappings.getWorkerMappingBoard());
    } catch (err) {
      const category = err instanceof XeroError ? err.category : 'unexpected';
      return res.status(statusFor(err)).json({ error: 'mapping board unavailable', errorCategory: category });
    }
  }

  if (req.method === 'POST') {
    const action = req.body && req.body.action;
    const workerId = req.body && typeof req.body.workerId === 'string' ? req.body.workerId.trim() : '';
    if (!workerId) return res.status(400).json({ error: 'workerId required' });

    if (action === 'map') {
      const employeeId = req.body && typeof req.body.employeeId === 'string' ? req.body.employeeId.trim() : '';
      if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
      let result;
      try {
        result = await mappings.confirmMapping({
          workerId,
          employeeId,
          source: req.body.source,
          actor: user,
        });
      } catch (err) {
        if (err instanceof XeroError && err.category === 'conflict' && err.conflictWith) {
          return res.status(409).json({
            error: `That Xero employee is already linked to ${err.conflictWith.workerName}. Unlink them first.`,
            conflictWith: err.conflictWith,
          });
        }
        const category = err instanceof XeroError ? err.category : 'unexpected';
        return res.status(statusFor(err)).json({ error: 'could not confirm the link', errorCategory: category });
      }

      await audit.append({
        action: 'xero.worker_mapped',
        actorId: user.id,
        actorName: user.name || user.username || '',
        actorRole: user.role,
        targetType: 'xero_mapping',
        targetId: workerId,
        summary: `Linked ${result.workerName} → ${result.employeeName}${result.employeeInactive ? ' (employee inactive in Xero)' : ''}`,
        metadata: {
          employeeId,
          employeeName: result.employeeName,
          source: result.mapping.source,
          ...(result.previousEmployeeId ? { previousEmployeeId: result.previousEmployeeId } : {}),
        },
      }).catch(() => {});

      return res.status(200).json({
        ok: true,
        workerName: result.workerName,
        employeeName: result.employeeName,
        employeeInactive: result.employeeInactive,
        remapped: Boolean(result.previousEmployeeId),
      });
    }

    if (action === 'unmap') {
      let removed;
      try {
        removed = await mappings.removeMapping({ workerId });
      } catch (err) {
        const category = err instanceof XeroError ? err.category : 'unexpected';
        return res.status(statusFor(err)).json({ error: 'could not unlink', errorCategory: category });
      }
      if (!removed) return res.status(404).json({ error: 'no link to remove' });

      await audit.append({
        action: 'xero.worker_unmapped',
        actorId: user.id,
        actorName: user.name || user.username || '',
        actorRole: user.role,
        targetType: 'xero_mapping',
        targetId: workerId,
        summary: `Unlinked worker from ${removed.xero_name_snapshot || removed.xero_id}`,
        metadata: { employeeId: removed.xero_id, employeeName: removed.xero_name_snapshot },
      }).catch(() => {});

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
};
