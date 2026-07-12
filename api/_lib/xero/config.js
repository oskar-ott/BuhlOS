// Xero connection configuration (#247) — env contract + endpoints + scopes.
//
// Env (per docs/architecture/integration-credential-storage-adr.md; all
// server-only, per-environment, never NEXT_PUBLIC_*):
//   XERO_CLIENT_ID       the Xero developer app for THIS environment
//   XERO_CLIENT_SECRET   its secret (separate app per environment — Xero
//                        requires exact registered redirect URIs)
//   XERO_TOKEN_ENC_KEY   32-byte base64 secret-box key (../secret-box.js)
//   APP_BASE_URL         canonical https base — the redirect URI is derived
//                        from it, NEVER from request headers (no host-header
//                        or forwarded-host trust, no open redirect surface).
//                        Production: https://buhlos.com
//
// Scopes: the CONNECTION milestone needs identity + refresh only. openid/
// profile/email identify the consenting user, offline_access mints the
// rotating refresh token. Payroll read scopes arrive with #610; write scopes
// with #249 — requesting them now would violate the ADR's no-writes gate.

const { encryptionKeyConfigured } = require('../secret-box');

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const REVOCATION_URL = 'https://identity.xero.com/connect/revocation';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

const SCOPES = 'openid profile email offline_access';

const PROVIDER = 'xero';

/** The settings surface every browser-facing Xero redirect lands on. */
const SETTINGS_PATH = '/settings/integrations/xero';

function clientId(env = process.env) {
  const v = env.XERO_CLIENT_ID;
  return v && String(v).trim() ? String(v).trim() : null;
}

function clientSecret(env = process.env) {
  const v = env.XERO_CLIENT_SECRET;
  return v && String(v).trim() ? String(v).trim() : null;
}

/** Canonical https base URL, no trailing slash — or null when unset/invalid. */
function appBaseUrl(env = process.env) {
  const raw = env.APP_BASE_URL;
  if (!raw || !String(raw).trim()) return null;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return url.origin;
}

function redirectUri(env = process.env) {
  const base = appBaseUrl(env);
  return base ? `${base}/api/xero/callback` : null;
}

/**
 * Configuration report — which pieces are present. Values never leave the
 * server and never appear in the report (presence booleans only).
 */
function configReport(env = process.env) {
  return {
    clientId: Boolean(clientId(env)),
    clientSecret: Boolean(clientSecret(env)),
    encryptionKey: encryptionKeyConfigured(env),
    baseUrl: Boolean(appBaseUrl(env)),
    supabase: Boolean(env.SUPABASE_DB_URL),
  };
}

/** True when everything the OAuth flow needs is present. */
function xeroConfigured(env = process.env) {
  const r = configReport(env);
  return r.clientId && r.clientSecret && r.encryptionKey && r.baseUrl && r.supabase;
}

module.exports = {
  AUTHORIZE_URL,
  TOKEN_URL,
  REVOCATION_URL,
  CONNECTIONS_URL,
  SCOPES,
  PROVIDER,
  SETTINGS_PATH,
  clientId,
  clientSecret,
  appBaseUrl,
  redirectUri,
  configReport,
  xeroConfigured,
};
