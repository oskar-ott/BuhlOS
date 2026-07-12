// POST /api/xero/disconnect (#247) — admin-only, explicit disconnect.
// Revokes the grant at Xero (best-effort — a revocation failure must not
// trap the admin in a half-connected state) then HARD-DELETES the row per
// the credential-storage ADR. The audit entry is written BEFORE the delete
// so the connection's existence survives its own removal; CSV export and
// every operational record are untouched.

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured } = require('../_lib/xero/config');
const { revokeRefreshToken } = require('../_lib/xero/oauth');
const store = require('../_lib/xero/token-store');

const FLAG = 'xero_connection';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;
  if (!(await isFlagEnabled(FLAG, user))) return res.status(404).json({ error: 'not found' });
  if (!xeroConfigured()) return res.status(503).json({ error: 'xero not configured' });

  const row = await store.getConnection();
  if (!row) return res.status(409).json({ error: 'not connected' });

  // Best-effort revocation at Xero. Decrypt failure or a Xero error is
  // recorded but never blocks the local delete — the admin asked to
  // disconnect, and dead ciphertext must not stay because Xero was down.
  let revoked = false;
  try {
    const { refreshToken } = store.decryptTokens(row);
    await revokeRefreshToken(refreshToken);
    revoked = true;
  } catch {
    revoked = false;
  }

  await audit.append({
    action: 'xero.disconnected',
    actorId: user.id,
    actorName: user.name || user.username || '',
    actorRole: user.role,
    targetType: 'integration',
    targetId: 'xero',
    summary: `Xero disconnected (${row.external_tenant_name || 'no organisation selected'})`,
    metadata: {
      externalTenantId: row.external_tenant_id || null,
      revokedAtProvider: revoked,
    },
  }).catch(() => {});

  await store.deleteConnection({ id: row.id });

  return res.status(200).json({ ok: true, revokedAtProvider: revoked });
};
