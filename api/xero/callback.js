// GET /api/xero/callback (#247) — the registered OAuth redirect URI
// (production: https://buhlos.com/api/xero/callback). The browser arrives
// here FROM Xero carrying ?code&state (or ?error). Every outcome — success,
// denial, failure — redirects to the settings surface with a safe result
// param; tokens never touch query strings, HTML or logs.
//
// Order of checks: method → session (same admin who started) → flag →
// config → OAuth error param → state → code → exchange → persist encrypted
// → organisation count. DB/encryption failures AFTER a successful exchange
// surface as an honest error state (the grant exists at Xero but BuhlOS
// holds nothing — reconnect re-mints, nothing is half-stored).

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured, SETTINGS_PATH } = require('../_lib/xero/config');
const { verifyState, exchangeCode, listConnections } = require('../_lib/xero/oauth');
const store = require('../_lib/xero/token-store');
const { XeroError } = require('../_lib/xero/errors');

const FLAG = 'xero_connection';

function redirectToSettings(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 302;
  res.setHeader('Location', `${SETTINGS_PATH}${qs ? `?${qs}` : ''}`);
  return res.end();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  // The redirect arrives in the initiating admin's browser — same session
  // cookie. An unauthenticated / non-admin hit gets the JSON 401/403 (no
  // token material is present in that path's params to protect).
  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;

  // Feature dark → no processing beyond a safe redirect (the settings page
  // states the honest disabled state).
  if (!(await isFlagEnabled(FLAG, user))) return redirectToSettings(res, {});

  if (!xeroConfigured()) return redirectToSettings(res, { xero_error: 'not_configured' });

  const q = req.query || {};

  // User denied consent (or Xero reported an OAuth error).
  if (q.error) {
    const denied = String(q.error) === 'access_denied';
    return redirectToSettings(res, { xero_error: denied ? 'consent_denied' : 'oauth_error' });
  }

  if (!q.state || !verifyState(String(q.state), user.id)) {
    return redirectToSettings(res, { xero_error: 'invalid_state' });
  }
  if (!q.code) {
    return redirectToSettings(res, { xero_error: 'missing_code' });
  }

  let tokens;
  try {
    tokens = await exchangeCode(String(q.code));
  } catch (err) {
    const category = err instanceof XeroError ? err.category : 'unexpected';
    return redirectToSettings(res, { xero_error: `exchange_${category}` });
  }

  // Discover the organisations this grant reaches BEFORE persisting, so a
  // grant with zero organisations never leaves a half-usable row behind.
  let organisations;
  try {
    organisations = await listConnections(tokens.accessToken);
  } catch (err) {
    const category = err instanceof XeroError ? err.category : 'unexpected';
    return redirectToSettings(res, { xero_error: `connections_${category}` });
  }
  if (!organisations.length) {
    return redirectToSettings(res, { xero_error: 'no_organisations' });
  }

  let row;
  try {
    row = await store.replaceConnection({ tokens, actor: user });
  } catch {
    // Encryption or DB failure after a successful exchange. Nothing stored;
    // the admin reconnects (a fresh grant) once the cause is fixed.
    return redirectToSettings(res, { xero_error: 'persistence' });
  }

  await audit.append({
    action: 'xero.connected',
    actorId: user.id,
    actorName: user.name || user.username || '',
    actorRole: user.role,
    targetType: 'integration',
    targetId: 'xero',
    summary: `Xero authorised (${organisations.length} organisation${organisations.length === 1 ? '' : 's'} available)`,
    metadata: { organisationCount: organisations.length },
  }).catch(() => {});

  if (organisations.length === 1) {
    // Exactly one organisation: select it, then the harmless verification
    // read already happened (listConnections IS the harmless read).
    const selected = await store.selectOrganisation({
      id: row.id,
      externalTenantId: organisations[0].tenantId,
      externalTenantName: organisations[0].tenantName,
    }).catch(() => null);
    if (!selected) return redirectToSettings(res, { xero_error: 'persistence' });

    await audit.append({
      action: 'xero.organisation_selected',
      actorId: user.id,
      actorName: user.name || user.username || '',
      actorRole: user.role,
      targetType: 'integration',
      targetId: 'xero',
      summary: `Connected to ${organisations[0].tenantName}`,
      metadata: { externalTenantId: organisations[0].tenantId, auto: true },
    }).catch(() => {});

    return redirectToSettings(res, { xero_result: 'connected' });
  }

  // Multiple organisations — explicit selection on the settings page. The
  // row sits in pending_selection; names/ids are re-fetched there (never
  // silently pick the first).
  return redirectToSettings(res, { xero_result: 'select_organisation' });
};
