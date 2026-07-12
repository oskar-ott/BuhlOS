// /api/xero/status (#247) — the connection-health read + on-demand check.
//   GET  → the derived health payload (safe fields only, never tokens)
//   POST {action:'check'} → live harmless read (GET /connections via the
//         shared client) → updated health. A failed check returns 200 with
//         the honest degraded/reconnect state — the failure IS the answer.

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured, configReport, CONNECTIONS_URL } = require('../_lib/xero/config');
const { deriveConnectionHealth } = require('../_lib/xero/connection-health');
const { xeroFetch } = require('../_lib/xero/client');
const store = require('../_lib/xero/token-store');
const { XeroError } = require('../_lib/xero/errors');

const FLAG = 'xero_connection';

async function health() {
  const configured = xeroConfigured();
  const row = configured ? await store.getConnection() : null;
  return deriveConnectionHealth({ configured, configReport: configReport(), row });
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;
  if (!(await isFlagEnabled(FLAG, user))) return res.status(404).json({ error: 'not found' });

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await health());
  }

  if (req.method === 'POST') {
    const action = req.body && req.body.action;
    if (action !== 'check') return res.status(400).json({ error: 'unknown action' });

    let checkError = null;
    try {
      // The harmless read: /connections is untenanted metadata (ids + names).
      await xeroFetch(CONNECTIONS_URL, { tenanted: false });
    } catch (err) {
      checkError = err instanceof XeroError ? err.category : 'unexpected';
    }

    await audit.append({
      action: 'xero.connection_checked',
      actorId: user.id,
      actorName: user.name || user.username || '',
      actorRole: user.role,
      targetType: 'integration',
      targetId: 'xero',
      summary: checkError ? `Xero connection check failed (${checkError})` : 'Xero connection check ok',
      metadata: checkError ? { errorCategory: checkError } : undefined,
    }).catch(() => {});

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ...(await health()), lastCheck: checkError ? { ok: false, errorCategory: checkError } : { ok: true } });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
};
