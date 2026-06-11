#!/usr/bin/env node
// Live smoke: every legacy URL must redirect to its canonical modern
// route (or 404 if it was never public) — and nothing reachable may
// render legacy UI.
//
//   node scripts/smoke-legacy-redirects.js                # buhlos.com
//   node scripts/smoke-legacy-redirects.js <preview-url>  # any preview
//
// This is the runtime twin of scripts/check-legacy-quarantine.js: the
// static guard proves the repo can't ship legacy surfaces; this proves a
// real deployment doesn't serve them. Run it against the PR preview
// before merging routing changes, and against production after deploy.
//
// Exit codes: 0 = every check passed · 1 = at least one failure.

'use strict';

const DEFAULT_BASE = 'https://buhlos.com';
const base = (process.argv[2] || DEFAULT_BASE).replace(/\/$/, '');

const ANSI = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', reset: '\x1b[0m' }
  : { red: '', green: '', dim: '', reset: '' };

let failures = 0;
function pass(label, note) {
  console.log(`${ANSI.green}PASS${ANSI.reset} ${label}${note ? ANSI.dim + ' — ' + note + ANSI.reset : ''}`);
}
function failed(label, note) {
  failures += 1;
  console.log(`${ANSI.red}FAIL${ANSI.reset} ${label}${note ? ' — ' + note : ''}`);
}

function locationPath(res) {
  const loc = res.headers.get('location') || '';
  try { return new URL(loc, base).pathname; } catch { return loc; }
}

async function fetchManual(path) {
  return fetch(base + path, { redirect: 'manual', headers: { 'user-agent': 'buhl-legacy-redirect-smoke' } });
}

// Follow up to `max` redirects manually, returning the final response + body.
async function fetchFinal(path, max = 4) {
  let current = path;
  for (let i = 0; i <= max; i += 1) {
    const res = await fetchManual(current);
    if (res.status >= 300 && res.status < 400) {
      current = locationPath(res) + (new URL(res.headers.get('location') || '', base).search || '');
      continue;
    }
    const body = await res.text();
    return { res, body, finalPath: current };
  }
  return null;
}

// Markers that must NEVER appear in any served page.
const LEGACY_MARKERS = [
  'Site Office',
  'SHELL.boot',
  'Birdwood IV3232',
  'buhl-shell-v', // legacy cache names leaking into HTML
  '/admin/_shell.js',
];

async function expectRedirect(label, path, wantPath) {
  try {
    const res = await fetchManual(path);
    if (res.status !== 307 && res.status !== 308) {
      failed(label, `expected 307/308, got ${res.status}`);
      return;
    }
    const got = locationPath(res);
    if (got !== wantPath) {
      failed(label, `redirects to ${got}, expected ${wantPath}`);
      return;
    }
    pass(label, `${res.status} → ${wantPath}`);
  } catch (e) {
    failed(label, e && e.message);
  }
}

async function expectStatus(label, path, want) {
  try {
    const res = await fetchManual(path);
    if (res.status !== want) {
      failed(label, `expected ${want}, got ${res.status}`);
      return;
    }
    pass(label, String(want));
  } catch (e) {
    failed(label, e && e.message);
  }
}

async function expectModernFinal(label, path, mustContain) {
  try {
    const fin = await fetchFinal(path);
    if (!fin) { failed(label, 'redirect loop / too many hops'); return; }
    const { res, body, finalPath } = fin;
    if (res.status !== 200) { failed(label, `final ${finalPath} returned ${res.status}`); return; }
    for (const marker of LEGACY_MARKERS) {
      if (body.includes(marker)) {
        failed(label, `final ${finalPath} contains legacy marker "${marker}"`);
        return;
      }
    }
    if (mustContain && !body.includes(mustContain)) {
      failed(label, `final ${finalPath} missing modern marker "${mustContain}"`);
      return;
    }
    pass(label, `lands ${finalPath}, modern`);
  } catch (e) {
    failed(label, e && e.message);
  }
}

(async () => {
  console.log(`${ANSI.dim}legacy-redirect smoke against ${base}${ANSI.reset}\n`);

  // ── Entry points → login ────────────────────────────────────────────
  await expectRedirect('/login → /v2/login', '/login', '/v2/login');
  await expectRedirect('/login.html → /v2/login', '/login.html', '/v2/login');
  await expectRedirect('/buhlos → /v2/login', '/buhlos', '/v2/login');
  await expectRedirect('/buhlos/login → /v2/login', '/buhlos/login', '/v2/login');
  await expectRedirect('/phil/login → /v2/login', '/phil/login', '/v2/login');

  // ── Field surface ───────────────────────────────────────────────────
  await expectRedirect('/phil → /phil/my-day', '/phil', '/phil/my-day');
  await expectRedirect('/phil/app → /phil/my-day', '/phil/app', '/phil/my-day');
  await expectRedirect('/phil.html → /phil/my-day', '/phil.html', '/phil/my-day');
  await expectRedirect('/my-day → /phil/my-day', '/my-day', '/phil/my-day');
  await expectRedirect('/my-day.html → /phil/my-day', '/my-day.html', '/phil/my-day');
  await expectRedirect('/my-gear → /phil/gear', '/my-gear', '/phil/gear');
  await expectRedirect('/lh → /phil/my-day', '/lh', '/phil/my-day');
  await expectRedirect('/lh-home → /phil/my-day', '/lh-home', '/phil/my-day');
  await expectRedirect('/install → /phil/my-day', '/install', '/phil/my-day');
  await expectRedirect('/jobs/abc → /phil/jobs/abc', '/jobs/abc', '/phil/jobs/abc');

  // ── Admin surface ───────────────────────────────────────────────────
  await expectRedirect('/admin → /command-centre', '/admin', '/command-centre');
  await expectRedirect('/admin/operations → /command-centre', '/admin/operations', '/command-centre');
  await expectRedirect('/admin/operations.html → /command-centre', '/admin/operations.html', '/command-centre');
  await expectRedirect('/overview → /command-centre', '/overview', '/command-centre');
  await expectRedirect('/admin/approvals → /hours/approvals', '/admin/approvals', '/hours/approvals');
  await expectRedirect('/approvals → /hours/approvals', '/approvals', '/hours/approvals');
  await expectRedirect('/admin/hours → /hours', '/admin/hours', '/hours');
  await expectRedirect('/admin/crew → /employees', '/admin/crew', '/employees');
  await expectRedirect('/admin/jobs → /v2/jobs', '/admin/jobs', '/v2/jobs');
  await expectRedirect('/admin/jobs/abc → /v2/jobs/abc', '/admin/jobs/abc', '/v2/jobs/abc');
  await expectRedirect('/admin/assets → /gear', '/admin/assets', '/gear');
  await expectRedirect('/admin/materials → /material-requests', '/admin/materials', '/material-requests');
  await expectRedirect('/admin/quotes → /command-centre', '/admin/quotes', '/command-centre');
  await expectRedirect('/jobs → /v2/jobs', '/jobs', '/v2/jobs');
  await expectRedirect('/buhlos/admin → /command-centre', '/buhlos/admin', '/command-centre');
  await expectRedirect('/buhlos/admin/operations → /command-centre', '/buhlos/admin/operations', '/command-centre');

  // ── Never-public surfaces are dead, not redirected ──────────────────
  await expectStatus('/admin-legacy is gone', '/admin-legacy', 404);
  await expectStatus('/dev/site-office is gone', '/dev/site-office', 404);
  await expectStatus('/dev/components is gone', '/dev/components', 404);
  await expectStatus('/admin/_shell.js is gone', '/admin/_shell.js', 404);
  await expectStatus('/admin/admin-data.js is gone', '/admin/admin-data.js', 404);

  // ── Final pages render the MODERN app (unauthenticated → login) ─────
  await expectModernFinal('/ lands on modern login', '/', 'Welcome back.');
  await expectModernFinal('/login chain lands on modern login', '/login', 'Welcome back.');
  await expectModernFinal('/my-day chain lands modern (login when signed out)', '/my-day', 'Welcome back.');
  await expectModernFinal('/admin/operations chain lands modern (login when signed out)', '/admin/operations', 'Welcome back.');
  await expectModernFinal('/phil chain lands modern (login when signed out)', '/phil', 'Welcome back.');

  // ── The kept exception: client portal still serves ──────────────────
  await expectStatus('/client (kept client portal) serves', '/client', 200);

  // ── The PWA contract ────────────────────────────────────────────────
  try {
    const res = await fetchManual('/manifest.json');
    const manifest = res.status === 200 ? await res.json() : null;
    if (!manifest) failed('/manifest.json serves', `status ${res.status}`);
    else if (manifest.start_url !== '/phil/my-day') {
      failed('manifest start_url', `got ${manifest.start_url}`);
    } else pass('manifest start_url is /phil/my-day');
  } catch (e) { failed('/manifest.json serves', e && e.message); }
  try {
    const res = await fetchManual('/sw.js');
    const sw = res.status === 200 ? await res.text() : '';
    if (res.status !== 200) failed('/sw.js serves', `status ${res.status}`);
    else if (/_shell|STATIC_SHELL/.test(sw)) failed('/sw.js is the push-only worker', 'still references the legacy shell cache');
    else pass('/sw.js serves the push-only worker');
  } catch (e) { failed('/sw.js serves', e && e.message); }

  console.log('');
  if (failures) {
    console.log(`${ANSI.red}${failures} failure(s) — legacy surfaces may be reachable.${ANSI.reset}`);
    process.exit(1);
  }
  console.log(`${ANSI.green}All legacy routes redirect/404 and every reachable page is modern.${ANSI.reset}`);
  process.exit(0);
})();
