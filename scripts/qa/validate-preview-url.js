#!/usr/bin/env node
// Preview-only URL guard for credentialed Preview Smoke.
//
//   node scripts/qa/validate-preview-url.js          # validates $PLAYWRIGHT_BASE_URL
//
// Uses the real WHATWG URL parser (not string/sed hacks) so malformed URLs and
// invalid ports are rejected properly. The smoke CREATES and briefly publishes
// jobs, so it must NEVER run against production. Logs only the sanitized
// hostname + protocol — never the raw URL or any credential.
//
// Allowed:
//   - the EXACT Birdwood Vercel preview host pattern (project + team scope)
//   - localhost / 127.0.0.1 (with a valid port if present)
// Rejected: empty, malformed, bad port, production (buhlos.com / www), and any
// other host — including look-alikes like evil-oskars-projects.vercel.app.

const FAIL_MSG =
  'Refusing to run credentialed Preview Smoke against production or unsupported URL.';

// Exact Birdwood project preview host:
//   birdwood-<deployment-or-branch-slug>-oskars-projects-86c0cb7e.vercel.app
// The trailing team scope (-oskars-projects-86c0cb7e.vercel.app) is required, so
// arbitrary "*oskars-projects*.vercel.app" look-alikes do NOT pass.
const BIRDWOOD_PREVIEW = /^birdwood-[a-z0-9-]+-oskars-projects-86c0cb7e\.vercel\.app$/;
const PROD_HOSTS = new Set(['buhlos.com', 'www.buhlos.com']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Pure validator. Returns { ok, reason, host?, protocol? }. No IO — unit-tested
 * in src/domains/qa/preview-url.test.ts against the exact bad/good examples.
 */
function validatePreviewUrl(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'empty URL' };
  }
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'malformed URL' };
  }
  const protocol = u.protocol.replace(/:$/, '');
  if (protocol !== 'http' && protocol !== 'https') {
    return { ok: false, reason: `unsupported protocol "${protocol}"`, host: u.hostname, protocol };
  }
  // new URL() already throws on a non-numeric port (e.g. ":notaport"); this
  // catches anything that parsed but is out of the valid range.
  if (u.port !== '') {
    const p = Number(u.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { ok: false, reason: `invalid port "${u.port}"`, host: u.hostname, protocol };
    }
  }
  const host = u.hostname.toLowerCase();
  if (PROD_HOSTS.has(host)) {
    return { ok: false, reason: 'production host', host, protocol };
  }
  if (LOCAL_HOSTS.has(host)) {
    // Local dev may use http; credentialed REMOTE smoke must use https (below).
    return { ok: true, reason: `localhost (${protocol})`, host, protocol };
  }
  if (BIRDWOOD_PREVIEW.test(host)) {
    // Credentialed remote smoke must never travel over plaintext http.
    if (protocol !== 'https') {
      return { ok: false, reason: 'remote preview must use HTTPS', host, protocol };
    }
    return { ok: true, reason: 'birdwood vercel preview (https)', host, protocol };
  }
  return { ok: false, reason: 'not a permitted preview target', host, protocol };
}

module.exports = { validatePreviewUrl, BIRDWOOD_PREVIEW };

if (require.main === module) {
  const res = validatePreviewUrl(process.env.PLAYWRIGHT_BASE_URL);
  // Sanitized logging only — never echo the raw URL.
  console.log(
    `Preview URL guard: host="${res.host || '(none)'}" protocol="${res.protocol || '(none)'}" -> ` +
      `${res.ok ? 'ALLOWED' : 'REJECTED'} (${res.reason})`
  );
  if (!res.ok) {
    console.error(`::error::${FAIL_MSG} (${res.reason})`);
    process.exit(1);
  }
}
