// /api/xero/worktype-mappings (#611) — work type ↔ Xero earnings rate.
//   GET  → the mapping board (work types × link state × health + rate picker)
//   POST {action:'map', workType, rateId} → confirm/remap (admin-only)
//   POST {action:'unmap', workType}       → remove
// A work type never silently defaults to ordinary: unmapped is a named
// blocker surfaced here and enforced by the payroll validation engine (#894).

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured } = require('../_lib/xero/config');
const lib = require('../_lib/xero/worktype-mappings');
const { XeroError } = require('../_lib/xero/errors');

const FLAG = 'xero_connection';

function statusFor(err) {
  if (!(err instanceof XeroError)) return 500;
  if (err.category === 'not_connected' || err.category === 'pending_selection') return 409;
  if (err.category === 'validation') return 400;
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
      return res.status(200).json(await lib.getWorktypeMappingBoard());
    } catch (err) {
      const category = err instanceof XeroError ? err.category : 'unexpected';
      return res.status(statusFor(err)).json({ error: 'mapping board unavailable', errorCategory: category });
    }
  }

  if (req.method === 'POST') {
    const action = req.body && req.body.action;
    const workType = req.body && typeof req.body.workType === 'string' ? req.body.workType.trim() : '';
    if (!workType) return res.status(400).json({ error: 'workType required' });

    if (action === 'map') {
      const rateId = req.body && typeof req.body.rateId === 'string' ? req.body.rateId.trim() : '';
      if (!rateId) return res.status(400).json({ error: 'rateId required' });
      let result;
      try {
        result = await lib.confirmWorktypeMapping({ workType, rateId, actor: user });
      } catch (err) {
        const category = err instanceof XeroError ? err.category : 'unexpected';
        return res.status(statusFor(err)).json({ error: 'could not confirm the mapping', errorCategory: category });
      }
      await audit.append({
        action: 'xero.worktype_mapped',
        actorId: user.id,
        actorName: user.name || user.username || '',
        actorRole: user.role,
        targetType: 'xero_mapping',
        targetId: `worktype:${workType}`,
        summary: `Mapped ${result.workTypeLabel} → ${result.rateName}${result.rateInactive ? ' (rate inactive in Xero)' : ''}${result.typeMismatch ? ' (earnings-type mismatch)' : ''}`,
        metadata: { rateId, rateName: result.rateName, typeMismatch: result.typeMismatch },
      }).catch(() => {});
      return res.status(200).json({
        ok: true,
        workTypeLabel: result.workTypeLabel,
        rateName: result.rateName,
        rateInactive: result.rateInactive,
        typeMismatch: result.typeMismatch,
      });
    }

    if (action === 'unmap') {
      let removed;
      try {
        removed = await lib.removeWorktypeMapping({ workType });
      } catch (err) {
        const category = err instanceof XeroError ? err.category : 'unexpected';
        return res.status(statusFor(err)).json({ error: 'could not unmap', errorCategory: category });
      }
      if (!removed) return res.status(404).json({ error: 'no mapping to remove' });
      await audit.append({
        action: 'xero.worktype_unmapped',
        actorId: user.id,
        actorName: user.name || user.username || '',
        actorRole: user.role,
        targetType: 'xero_mapping',
        targetId: `worktype:${workType}`,
        summary: `Unmapped ${workType} from ${removed.xero_name_snapshot || removed.xero_id}`,
        metadata: { rateId: removed.xero_id },
      }).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
};
