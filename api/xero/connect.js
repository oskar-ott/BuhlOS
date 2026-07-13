// GET /api/xero/connect (#247) — start the Xero OAuth2 authorization-code
// flow. Admin-only, flag-gated (xero_connection), honest when unconfigured.
// Mints a signed 10-minute state bound to THIS admin and 302s the browser to
// Xero's authorize endpoint. The client secret never appears anywhere here.

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured, configReport } = require('../_lib/xero/config');
const { makeState, authorizeUrl } = require('../_lib/xero/oauth');

const FLAG = 'xero_connection';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;
  if (!(await isFlagEnabled(FLAG, user))) return res.status(404).json({ error: 'not found' });

  if (!xeroConfigured()) {
    // Honest, actionable, value-free: which env pieces are missing.
    return res.status(503).json({ error: 'xero not configured', config: configReport() });
  }

  // #249: request the payroll.timesheets WRITE scope only when the export flag
  // is on for this admin — a default connect stays read-only.
  const write = await isFlagEnabled('xero_payroll_export', user);

  const state = makeState(user.id);

  await audit.append({
    action: 'xero.connect_started',
    actorId: user.id,
    actorName: user.name || user.username || '',
    actorRole: user.role,
    targetType: 'integration',
    targetId: 'xero',
    summary: 'Xero OAuth connect initiated',
  }).catch(() => {});

  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 302;
  res.setHeader('Location', authorizeUrl(state, { write }));
  return res.end();
};
