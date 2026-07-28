#!/usr/bin/env node
// Static guard: the legacy interface stays dead.
//
// Why: the product repeatedly had old layouts resurface in production —
// stale static HTML, rewrites that kept serving deleted shells, service
// workers replaying cached legacy assets, "open the old page" escape
// hatches in modern UI. The 2026-06 legacy-interface cutover removed the
// whole legacy estate (login.html, my-day.html, phil.html, the /admin/*.html
// suite, dev galleries, legacy components/css) and replaced every old URL
// with a 307 redirect to its canonical modern route. This guard makes that
// state load-bearing: any PR that reintroduces a legacy surface, link,
// rewrite, cache entry or product name fails predeploy + CI.
//
// What it asserts (all static, no network, no build):
//   1. Every deleted legacy file/dir stays deleted.
//   2. public/ contains NO directly-servable HTML except client.html
//      (the kept read-only client portal — replacement tracked as #271).
//   3. vercel.json rewrites are EXACTLY the two /client entries; the
//      legacy-URL redirect matrix is present and points at approved
//      modern destinations; nothing rewrites/redirects to *.html except
//      the client portal.
//   4. manifest.json is the Phil manifest (start_url /phil/my-day).
//   5. public/sw.js never precaches or serves legacy assets (no cache
//      lists, no .html/.css/_shell references, push deep-link defaults
//      are modern).
//   6. Live code (src/ + api/) contains no quoted legacy-URL literals
//      and no banned legacy phrases; the deprecated product names
//      ("Site Office", product-sense "Switchboard") don't reappear in
//      live files. Electrical "switchboard(s)" in src/domains stays legal.
//
// Allowed exceptions, by design:
//   - docs/** and *.md (history is allowed to describe the past)
//   - test files (they assert absence/removal)
//   - this script (it must name what it bans)
//
// Run standalone:  node scripts/check-legacy-quarantine.js
// Run via npm:     npm run check:legacy-quarantine
// Auto-runs on:    npm run predeploy / predeploy:preview + CI

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

const failures = [];
function fail(msg, detail) { failures.push({ msg, detail: detail || '' }); }
function read(rel) { return fs.readFileSync(path.join(REPO, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(REPO, rel)); }

// ── 1. The legacy estate stays deleted ────────────────────────────────
const DELETED_LEGACY_PATHS = [
  'public/login.html',
  'public/phil.html',
  'public/my-day.html',
  'public/my-gear.html',
  'public/phil-hours.html',
  'public/lh-home.html',
  'public/project.html',
  'public/install.html',
  'public/admin.html',
  'public/admin',
  'public/dev',
  'public/components',
  'public/lib',
  'public/install-prompt.js',
  'public/log-hours-sheet.js',
  'public/mobile-nav.js',
  'public/css/buhlos-admin.css',
];
for (const rel of DELETED_LEGACY_PATHS) {
  if (exists(rel)) {
    fail(rel + ' exists — deleted legacy surface has been reintroduced',
      'The legacy interface was removed in the legacy-interface cutover. Old URLs ' +
      'redirect to modern routes (vercel.json). If you need history, use git — ' +
      'never restore a legacy file into public/.');
  }
}

// ── 2. No servable HTML in public/ except the client portal ──────────
// Next.js serves everything in public/ verbatim at the site root, so any
// .html file here is a live page. client.html is the ONE sanctioned
// static page (read-only client portal; replacement tracked as #271).
const ALLOWED_PUBLIC_HTML = new Set([
  'public/client.html', // read-only client portal (replacement tracked as #271)
  'public/offline.html', // self-contained PWA offline fallback served by sw.js (#135)
]);
function walk(dirRel) {
  const out = [];
  if (!exists(dirRel)) return out;
  for (const entry of fs.readdirSync(path.join(REPO, dirRel), { withFileTypes: true })) {
    const rel = dirRel + '/' + entry.name;
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}
const publicFiles = walk('public');
for (const rel of publicFiles) {
  if (rel.endsWith('.html') && !ALLOWED_PUBLIC_HTML.has(rel)) {
    fail(rel + ' is a directly-servable HTML file in public/',
      'public/ files are served verbatim at the site root. The only sanctioned ' +
      'static page is client.html (client portal). New UI belongs in src/app/.');
  }
}

// Reused detector semantics (same spares as the deprecated-naming unit test):
// `buhl-site-office-*` localStorage key is exempt via the lookbehind.
const SITE_OFFICE_RE = /(?<!buhl-)\bsite[ -]?office\b/i;
// Banned phrases from the cutover brief — any of these in a live file means
// a legacy layout/fallback concept is creeping back in.
const BANNED_PHRASES = [
  /legacy layout/i,
  /old admin shell/i,
  /legacy fallback/i,
  /classic admin/i,
  /pills layout/i,
];
// The prototype page title that once replaced production. It is ALSO the
// real job's name (fixtures/tests use it legitimately), so it is banned only
// in directly-served public/ files.
const PUBLIC_ONLY_BANNED = [/Birdwood IV3232/];
for (const rel of publicFiles) {
  if (/\.(png|svg|ico|jpg|jpeg|webp)$/i.test(rel)) continue;
  const text = read(rel);
  text.split(/\r?\n/).forEach((line, idx) => {
    if (SITE_OFFICE_RE.test(line)) {
      fail(rel + ':' + (idx + 1) + ' uses the deprecated product name "Site Office"',
        'The surfaces are BuhlOS (office) and Phil (field).');
    }
    for (const re of [...BANNED_PHRASES, ...PUBLIC_ONLY_BANNED]) {
      if (re.test(line)) {
        fail(rel + ':' + (idx + 1) + ' contains banned legacy phrase ' + re,
          'Legacy layouts/fallbacks must not come back in any form.');
      }
    }
  });
}

// ── 3. vercel.json: redirects-only routing for old URLs ──────────────
// The full legacy URL space must keep 307-redirecting to canonical modern
// routes — and nothing may rewrite to a static HTML page except the client
// portal.
const APPROVED_DESTINATIONS = new Set([
  '/v2/login',
  '/phil/my-day',
  '/phil/gear',
  '/phil/hours',
  '/phil/jobs/:jobId',
  '/v2/jobs',
  '/v2/jobs/:jobId',
  '/command-centre',
  '/hours',
  '/hours/approvals',
  '/employees',
  '/gear',
]);
// source → required destination. Keep in sync with docs/route-ownership.md §6.
const REQUIRED_REDIRECTS = {
  '/login': '/v2/login',
  '/login.html': '/v2/login',
  '/buhlos': '/v2/login',
  '/buhlos/login': '/v2/login',
  '/phil/login': '/v2/login',
  '/phil': '/phil/my-day',
  '/phil/app': '/phil/my-day',
  '/my-day': '/phil/my-day',
  '/my-day.html': '/phil/my-day',
  '/my-gear': '/phil/gear',
  '/lh': '/phil/my-day',
  '/lh-home': '/phil/my-day',
  '/install': '/phil/my-day',
  '/jobs': '/v2/jobs',
  '/jobs/:jobId': '/phil/jobs/:jobId',
  '/admin': '/command-centre',
  '/admin/operations': '/command-centre',
  '/admin/operations.html': '/command-centre',
  '/overview': '/command-centre',
  '/admin/approvals': '/hours/approvals',
  '/approvals': '/hours/approvals',
  '/admin/hours': '/hours',
  '/admin/crew': '/employees',
  '/admin/jobs': '/v2/jobs',
  '/admin/jobs/:jobId': '/v2/jobs/:jobId',
  '/admin/assets': '/gear',
  '/admin/materials': '/command-centre',
  '/buhlos/admin': '/command-centre',
};
if (!exists('vercel.json')) {
  fail('vercel.json missing', 'Platform routing config must exist.');
} else {
  let cfg;
  try { cfg = JSON.parse(read('vercel.json')); }
  catch (e) { cfg = null; fail('vercel.json is not valid JSON', String(e && e.message)); }
  if (cfg) {
    const rewrites = cfg.rewrites || [];
    const allowedRewrites = new Set(['/client', '/client/jobs/:jobId']);
    for (const r of rewrites) {
      if (!allowedRewrites.has(r.source)) {
        fail('vercel.json rewrites "' + r.source + '" — only the /client portal may be rewritten',
          'Legacy URLs must be redirects (307) to modern routes, never rewrites to ' +
          'static files. See docs/route-ownership.md §6.');
      }
      if (!/^\/client\.html$/.test(r.destination)) {
        fail('vercel.json rewrite "' + r.source + '" targets "' + r.destination + '"',
          'The only sanctioned rewrite destination is /client.html.');
      }
    }
    const redirects = cfg.redirects || [];
    const bySource = new Map(redirects.map((r) => [r.source, r]));
    for (const [src, dest] of Object.entries(REQUIRED_REDIRECTS)) {
      const r = bySource.get(src);
      if (!r) {
        fail('vercel.json is missing the legacy redirect "' + src + '" → "' + dest + '"',
          'Every legacy URL must keep redirecting to its canonical modern route — ' +
          'installed PWAs and old bookmarks depend on it.');
      } else if (r.destination !== dest) {
        fail('vercel.json redirects "' + src + '" → "' + r.destination + '" (expected "' + dest + '")',
          'Keep the matrix in sync with docs/route-ownership.md §6 and this guard.');
      }
    }
    for (const r of redirects) {
      if (/\.html(\b|$)/.test(r.destination)) {
        fail('vercel.json redirect "' + r.source + '" targets an HTML file "' + r.destination + '"',
          'Redirect destinations must be modern routes, never static HTML.');
      }
      if (!APPROVED_DESTINATIONS.has(r.destination)) {
        fail('vercel.json redirect "' + r.source + '" targets non-approved "' + r.destination + '"',
          'Approved destinations: ' + [...APPROVED_DESTINATIONS].join(', '));
      }
    }
  }
}

// ── 4. The PWA manifest is the Phil manifest ─────────────────────────
if (exists('public/manifest.json')) {
  let manifest;
  try { manifest = JSON.parse(read('public/manifest.json')); } catch { manifest = null; }
  if (!manifest) {
    fail('public/manifest.json is not valid JSON');
  } else {
    if (manifest.start_url !== '/phil/my-day') {
      fail('manifest start_url is "' + manifest.start_url + '" (must be "/phil/my-day")',
        'Installed field PWAs open start_url — pointing it anywhere else risks ' +
        'resurrecting a legacy entry. The /my-day redirect is the safety net, ' +
        'not the contract.');
    }
    if (manifest.name !== 'BuhlOS' || manifest.short_name !== 'BuhlOS') {
      fail('manifest name/short_name must be "BuhlOS" (got "' + manifest.name + '"/"' + manifest.short_name + '")',
        'SINGLE BRAND (PR #939): every user-visible surface says BuhlOS — "Phil" is ' +
        'an internal/reserved name only (guarded by deprecated-naming.test.ts). The ' +
        'installed PWA is a user-visible surface.');
    }
    for (const sc of manifest.shortcuts || []) {
      if (!String(sc.url || '').startsWith('/phil/')) {
        fail('manifest shortcut "' + sc.name + '" targets "' + sc.url + '"',
          'Manifest shortcuts must deep-link into /phil/*.');
      }
    }
  }
} else {
  fail('public/manifest.json missing', 'The Phil PWA manifest must exist.');
}

// ── 5. Service worker never serves legacy assets ─────────────────────
if (exists('public/sw.js')) {
  const sw = read('public/sw.js');
  const swBans = [
    { re: /_shell/, why: 'references the deleted legacy admin shell' },
    { re: /STATIC_SHELL|addAll\s*\(/, why: 'reintroduces a precache list — the SW must not bulk-cache app assets' },
    { re: /['"`]\/(my-day|my-gear|overview|lh|admin)\b[^'"`]*['"`]/, why: 'deep-links a legacy URL' },
  ];
  for (const b of swBans) {
    if (b.re.test(sw)) {
      fail('public/sw.js ' + b.why + ' (' + b.re + ')',
        'The v9+ worker is push-only plus the #135 offline fallback: no app-shell ' +
        'precache list, no legacy deep-links. Serving cached shells is how old ' +
        'layouts resurrected.');
    }
  }
  // The worker may reference exactly ONE sanctioned static path — the
  // self-contained offline fallback (#135). Any OTHER .html/.css path is a
  // legacy-shell-cache risk and fails.
  const SANCTIONED_SW_PATHS = new Set(['/offline.html']);
  for (const lit of sw.match(/['"`]\/[A-Za-z0-9_\-/]*\.(?:html|css)['"`]/g) || []) {
    const p = lit.slice(1, -1);
    if (!SANCTIONED_SW_PATHS.has(p)) {
      fail('public/sw.js caches/serves a non-sanctioned HTML/CSS path (' + p + ')',
        'The worker may reference only /offline.html (the #135 fallback). ' +
        'New UI belongs in src/app/; serving cached shells resurrects old layouts.');
    }
  }
  if (!/notificationclick/.test(sw) || !/addEventListener\(['"]push['"]/.test(sw)) {
    fail('public/sw.js lost its push handlers',
      'Web Push delivery (hour reminders, office inbox, digests) rides this ' +
      'worker — removing the handlers breaks notifications fleet-wide.');
  }
  if (!/caches\.keys\(\)/.test(sw) || !/skipWaiting\(\)/.test(sw)) {
    fail('public/sw.js lost the legacy-cache purge (caches.keys + skipWaiting)',
      'Devices still carrying buhl-shell-v1..v8 caches need the purge on activate.');
  }
} else {
  fail('public/sw.js missing',
    'Existing PushSubscriptions are registered against /sw.js — deleting it ' +
    'orphans every subscribed device. Replace behaviour, never the URL.');
}

// ── 6. No legacy-URL literals or banned phrases in live code ─────────
// Quoted-literal scan, so prose/comments can still describe history.
const LEGACY_URL_LITERALS = [
  { re: /['"`]\/(my-day|my-gear|lh|lh-home|overview|admin-legacy|install)\b(?![\w-])[^'"`]*['"`]/, name: 'legacy URL' },
  { re: /['"`]\/admin\//, name: '/admin/* URL' },
  { re: /['"`]\/buhlos\b/, name: '/buhlos alias URL' },
  { re: /['"`]\/jobs\//, name: 'legacy /jobs/:id URL (use /phil/jobs or /v2/jobs)' },
  { re: /['"`]\/[A-Za-z0-9_\-/]*\.html(?!\w)[^'"`]*['"`]/, name: 'static .html URL' },
  { re: /['"`]\/phil['"`]/, name: 'bare /phil URL (legacy entry — use /phil/my-day)' },
];
function liveCodeFiles() {
  const out = [];
  const roots = ['src', 'api'];
  for (const root of roots) {
    for (const rel of walk(root)) {
      if (/\.(test|spec)\.[jt]sx?$/.test(rel)) continue;
      if (/\.(md|json|css|snap)$/.test(rel)) continue;
      if (!/\.([jt]sx?|mjs|cjs)$/.test(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}
const VERCEL_EXEMPT = new Set([]); // no exemptions today; add sparingly with a reason
for (const rel of liveCodeFiles()) {
  if (VERCEL_EXEMPT.has(rel)) continue;
  const text = read(rel);
  text.split(/\r?\n/).forEach((line, idx) => {
    for (const ban of LEGACY_URL_LITERALS) {
      if (ban.re.test(line)) {
        fail(rel + ':' + (idx + 1) + ' contains a quoted ' + ban.name,
          'Live code must only emit canonical modern routes ' +
          '(/v2/login, /command-centre, /phil/*, /v2/jobs/*, /hours*, /gear, ' +
          '/employees, /observations, /material-requests). ' +
          'Old URLs exist only as vercel.json redirect SOURCES.');
      }
    }
    if (SITE_OFFICE_RE.test(line)) {
      fail(rel + ':' + (idx + 1) + ' uses the deprecated product name "Site Office"');
    }
    for (const re of BANNED_PHRASES) {
      if (re.test(line)) {
        fail(rel + ':' + (idx + 1) + ' contains banned legacy phrase ' + re);
      }
    }
  });
}

// ── Execute ──────────────────────────────────────────────────────────
console.log(DIM + 'check-legacy-quarantine · ' + failures.length + ' issue' +
  (failures.length === 1 ? '' : 's') + RST);
console.log('');

if (failures.length) {
  for (const f of failures) {
    console.log(RED + 'FAIL ' + RST + f.msg);
    if (f.detail) console.log('     ' + YEL + f.detail + RST);
  }
  console.log('');
  console.log(RED + 'Legacy quarantine violated — the old interface must stay dead.' + RST);
  console.log(DIM + 'See docs/route-ownership.md §6 + docs/legacy-cutover.md.' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'legacy estate absent; redirects, manifest, SW and live code are clean.');
process.exit(0);
