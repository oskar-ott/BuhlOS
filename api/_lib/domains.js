// Central source of truth for the BuhlOS canonical domains.
//
// Defaults match the production domain plan:
//
//   buhlos.com          — main BuhlOS dashboard / login / admin
//   phil.buhlos.com     — Phil mobile worker app
//   api.buhlos.com      — API surface (currently same-origin in this
//                         single-deployment build — see getApiUrl)
//   docs.buhlos.com     — optional future docs / help
//
// Every URL can be overridden by environment variable so local dev,
// staging and preview environments can point at non-production hosts
// without code changes. NEXT_PUBLIC_* names match the names the brief
// asks for; the unprefixed names are accepted as a fallback for non
// Next.js hosts.
//
// Helpers:
//
//   getBuhlOSUrl() / getPhilUrl() / getApiUrl() / getDocsUrl()
//     Return the absolute base URL with no trailing slash.
//
//   buildBuhlOSUrl(path) / buildPhilUrl(path) / buildApiUrl(path) / buildDocsUrl(path)
//     Join a base URL with a path. Path may or may not start with '/'.
//
//   isPhilHost(hostname) / isApiHost(hostname) / isBuhlOSHost(hostname)
//     Classify a hostname against the canonical structure. Used by
//     middleware-ish logic that needs to know which app the request is
//     served from. Localhost counts as the BuhlOS host so dev keeps
//     working from a single port.
//
//   getAllowedOrigins()
//     Returns the origins permitted to call the API with credentials.
//     Used by the CORS helper in _lib/blob.js. Excludes wildcards.
//
//   getCookieDomain()
//     Optional shared cookie domain (e.g. '.buhlos.com') for cross
//     subdomain SSO between buhlos.com and phil.buhlos.com. Returns
//     undefined when unset so cookies stay host-only (the safe default
//     and the only thing that works on localhost).
//
//   getSupportUrl() / getAdminAlertEmail() / getNoReplyAddress()
//     Convenience helpers for the email / triage flows.

const DEFAULTS = Object.freeze({
  buhlos: 'https://buhlos.com',
  phil:   'https://phil.buhlos.com',
  api:    'https://api.buhlos.com',
  docs:   'https://docs.buhlos.com',
});

function clean(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed || null;
}

function envFirst(...names) {
  for (const n of names) {
    const v = clean(process.env[n]);
    if (v) return v;
  }
  return null;
}

function getBuhlOSUrl() {
  return envFirst('NEXT_PUBLIC_BUHLOS_URL', 'BUHLOS_URL') || DEFAULTS.buhlos;
}
function getPhilUrl() {
  return envFirst('NEXT_PUBLIC_PHIL_URL', 'PHIL_URL') || DEFAULTS.phil;
}
function getApiUrl() {
  return envFirst('NEXT_PUBLIC_API_URL', 'API_URL') || DEFAULTS.api;
}
function getDocsUrl() {
  return envFirst('NEXT_PUBLIC_DOCS_URL', 'DOCS_URL') || DEFAULTS.docs;
}

function joinPath(base, path) {
  if (!path) return base;
  const sep = String(path).charAt(0) === '/' ? '' : '/';
  return base + sep + path;
}

function buildBuhlOSUrl(path) { return joinPath(getBuhlOSUrl(), path); }
function buildPhilUrl(path)   { return joinPath(getPhilUrl(),   path); }
function buildApiUrl(path)    { return joinPath(getApiUrl(),    path); }
function buildDocsUrl(path)   { return joinPath(getDocsUrl(),   path); }

function stripPort(hostname) {
  if (!hostname) return '';
  const i = hostname.indexOf(':');
  return i === -1 ? hostname : hostname.slice(0, i);
}

function isPhilHost(hostname) {
  const h = stripPort(hostname).toLowerCase();
  return !!h && /^phil\./.test(h);
}
function isApiHost(hostname) {
  const h = stripPort(hostname).toLowerCase();
  return !!h && /^api\./.test(h);
}
function isLocalHost(hostname) {
  const h = stripPort(hostname).toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || /\.local$/.test(h);
}
function isBuhlOSHost(hostname) {
  const h = stripPort(hostname).toLowerCase();
  if (!h) return false;
  if (isPhilHost(h) || isApiHost(h)) return false;
  if (isLocalHost(h)) return true;
  return /(^|\.)buhlos\.com$/.test(h);
}

// Origins permitted to make credentialed calls to the API. Wildcards are
// deliberately not supported — pairing `Access-Control-Allow-Origin: *`
// with `Access-Control-Allow-Credentials: true` is rejected by browsers,
// so we always echo a specific origin from this list.
function getAllowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => clean(s)).filter(Boolean);
  return Array.from(new Set([
    getBuhlOSUrl(),
    getPhilUrl(),
    getApiUrl(),
    // Vercel preview deployments — Vercel injects VERCEL_URL on
    // preview/serverless functions. The deployment is reached over
    // https in the browser, so prefix with the scheme.
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8080',
    ...extra,
  ].filter(Boolean)));
}

// Pick the Access-Control-Allow-Origin value for a given request origin.
// Returns the origin string when allowed, or null when the request should
// not be granted credentialed cross-origin access (the caller can choose
// to omit the header entirely in that case — same-origin still works).
function resolveAllowedOrigin(origin) {
  if (!origin) return null;
  const allowed = getAllowedOrigins();
  return allowed.includes(origin) ? origin : null;
}

function getCookieDomain() {
  return clean(process.env.BUHLOS_COOKIE_DOMAIN) || undefined;
}

function getSupportUrl() {
  return buildBuhlOSUrl('/admin/support');
}
function getLoginUrl() {
  return buildBuhlOSUrl('/login');
}
function getAdminAlertEmail() {
  return process.env.ADMIN_ALERT_EMAIL || 'office@buhlos.com';
}
function getNoReplyAddress() {
  return process.env.NOREPLY_EMAIL || 'noreply@buhlos.com';
}

module.exports = {
  DEFAULTS,
  getBuhlOSUrl,
  getPhilUrl,
  getApiUrl,
  getDocsUrl,
  buildBuhlOSUrl,
  buildPhilUrl,
  buildApiUrl,
  buildDocsUrl,
  isPhilHost,
  isApiHost,
  isLocalHost,
  isBuhlOSHost,
  getAllowedOrigins,
  resolveAllowedOrigin,
  getCookieDomain,
  getSupportUrl,
  getLoginUrl,
  getAdminAlertEmail,
  getNoReplyAddress,
};
