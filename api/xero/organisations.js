// /api/xero/organisations (#247) — explicit organisation selection when a
// grant reaches more than one Xero organisation.
//   GET  → names + tenant ids only (live from GET /connections — the cache-
//          free source; ids/names carry no business data)
//   POST {tenantId} → confirm the selection; verified against the live list
//          so a forged/foreign tenant id can never be persisted.
// Selection only exists while the row is pending_selection; there is no
// silent first-organisation default anywhere.

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured } = require('../_lib/xero/config');
const { listConnections } = require('../_lib/xero/oauth');
const store = require('../_lib/xero/token-store');
const { XeroError } = require('../_lib/xero/errors');

const FLAG = 'xero_connection';

async function pendingContext(res) {
  if (!xeroConfigured()) {
    res.status(503).json({ error: 'xero not configured' });
    return null;
  }
  const row = await store.getConnection();
  if (!row) {
    res.status(409).json({ error: 'not connected' });
    return null;
  }
  if (row.status !== 'pending_selection') {
    res.status(409).json({ error: 'no organisation selection pending' });
    return null;
  }
  let accessToken;
  try {
    ({ accessToken } = store.decryptTokens(row));
  } catch {
    res.status(409).json({ error: 'pending authorisation unusable — reconnect', errorCategory: 'decrypt_failed' });
    return null;
  }
  return { row, accessToken };
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;
  if (!(await isFlagEnabled(FLAG, user))) return res.status(404).json({ error: 'not found' });

  if (req.method === 'GET') {
    const ctx = await pendingContext(res);
    if (!ctx) return;
    try {
      const organisations = await listConnections(ctx.accessToken);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ organisations });
    } catch (err) {
      const category = err instanceof XeroError ? err.category : 'unexpected';
      return res.status(502).json({ error: 'could not list organisations', errorCategory: category });
    }
  }

  if (req.method === 'POST') {
    const tenantId = req.body && typeof req.body.tenantId === 'string' ? req.body.tenantId.trim() : '';
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

    const ctx = await pendingContext(res);
    if (!ctx) return;

    let organisations;
    try {
      organisations = await listConnections(ctx.accessToken);
    } catch (err) {
      const category = err instanceof XeroError ? err.category : 'unexpected';
      return res.status(502).json({ error: 'could not verify organisation', errorCategory: category });
    }
    const chosen = organisations.find((o) => o.tenantId === tenantId);
    if (!chosen) return res.status(400).json({ error: 'tenantId is not one of the authorised organisations' });

    const selected = await store.selectOrganisation({
      id: ctx.row.id,
      externalTenantId: chosen.tenantId,
      externalTenantName: chosen.tenantName,
    });
    if (!selected) return res.status(409).json({ error: 'selection no longer pending' });

    await audit.append({
      action: 'xero.organisation_selected',
      actorId: user.id,
      actorName: user.name || user.username || '',
      actorRole: user.role,
      targetType: 'integration',
      targetId: 'xero',
      summary: `Connected to ${chosen.tenantName}`,
      metadata: { externalTenantId: chosen.tenantId, auto: false },
    }).catch(() => {});

    return res.status(200).json({ ok: true, organisationName: chosen.tenantName });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
};
