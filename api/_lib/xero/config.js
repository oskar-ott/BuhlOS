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
// Scopes: identity + refresh (#247) plus the READ-ONLY reference scopes
// (#610): payroll.employees.read / payroll.settings.read (Payroll AU
// employees, calendars, pay items) and accounting.settings.read (tracking
// categories, for #254's job mapping). NO write scope exists anywhere —
// write scopes arrive only with #249 behind its own flag, per the ADR's
// no-writes gate. Connections minted before #610 lack the read scopes;
// hasReferenceReadScopes() detects that and the UI says "reconnect".

const { encryptionKeyConfigured } = require('../secret-box');

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const REVOCATION_URL = 'https://identity.xero.com/connect/revocation';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const PAYROLL_AU_BASE = 'https://api.xero.com/payroll.xro/1.0';
const ACCOUNTING_BASE = 'https://api.xero.com/api.xro/2.0';

const REFERENCE_READ_SCOPES = [
  'payroll.employees.read',
  'payroll.settings.read',
  'accounting.settings.read',
];

const SCOPES = ['openid profile email offline_access', ...REFERENCE_READ_SCOPES].join(' ');

/** True when a connection's granted scopes include every reference read scope. */
function hasReferenceReadScopes(grantedScopes) {
  const granted = new Set(String(grantedScopes || '').split(/\s+/).filter(Boolean));
  return REFERENCE_READ_SCOPES.every((s) => granted.has(s));
}

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
  PAYROLL_AU_BASE,
  ACCOUNTING_BASE,
  SCOPES,
  REFERENCE_READ_SCOPES,
  hasReferenceReadScopes,
  PROVIDER,
  SETTINGS_PATH,
  clientId,
  clientSecret,
  appBaseUrl,
  redirectUri,
  configReport,
  xeroConfigured,
};
