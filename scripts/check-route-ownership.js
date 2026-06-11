#!/usr/bin/env node
// Static guard: the modern navigation + landing contract must hold.
//
// Why: BuhlOS and Phil run a legacy static surface (public/*.html) alongside a
// new Next.js surface (src/app/**). The recurring failure is a modern nav link
// quietly pointing at a legacy/obsolete route, or the canonical entry point
// drifting back to a placeholder — so the user lands on the wrong shell. This
// check freezes the contract documented in docs/route-ownership.md so a future
// edit can't break it silently.
//
// What it asserts (all static, no network, no build):
//   1. docs/route-ownership.md exists (the contract this guard enforces).
//   2. Every canonical/transitional modern route source file exists.
//   3. AdminSidebar live items only link to APPROVED admin routes.
//   4. Phil tab bar live tabs only link to APPROVED Phil routes.
//   5. No live nav item links to a legacy public/*.html or /admin/* URL.
//   6. landingFor() maps each role class to its approved landing (in particular
//      field -> /phil/my-day, NOT the /v2/phil placeholder).
//   7. The active legacy user-facing surfaces (login.html / phil.html /
//      lh-home.html / admin/_shell.js) don't render the deprecated "Site
//      Office" product name (the electrical "switchboard" sense is untouched).
//   8. The deprecated /dev/site-office surface carries a DEPRECATED marker.
//
// When the contract intentionally changes (e.g. the /v2/jobs -> /admin/jobs
// cutover), update the APPROVED_* sets below AND docs/route-ownership.md in the
// same PR. This guard is meant to catch *accidental* drift, not block intended
// migration.
//
// Run standalone:  node scripts/check-route-ownership.js
// Run via npm:     npm run check:route-ownership
// Auto-runs on:    npm run predeploy / predeploy:preview

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

// ── Contract: approved modern nav targets ────────────────────────────
// Live nav items may only link to these. UC (non-clickable) items are
// excluded from the check — they render as <span>, not <Link>.
const APPROVED_ADMIN_HREFS = new Set([
  '/command-centre',
  '/hours',
  '/hours/approvals',
  '/hours/weekly', // PR #113 — weekly hours closeout / payroll readiness
  '/gear',
  '/employees',
  '/observations', // PR 3 — cross-job field-to-office observations inbox
  '/material-requests', // PR 11 — cross-job procurement inbox
  '/v2/jobs', // transitional — live admin Jobs index; -> /admin/jobs later
]);
const APPROVED_PHIL_HREFS = new Set([
  '/phil/my-day',
  '/phil/jobs',
  '/phil/gear',
  '/v2/phil', // transitional — "More" / profile placeholder
]);

// A live nav href that matches any of these is a legacy/obsolete link that
// must never appear in modern navigation chrome.
const FORBIDDEN_NAV_PATTERNS = [
  /\.html(\b|$)/,        // any public/*.html
  /^\/admin\//,          // legacy admin module URLs
  /^\/admin-legacy$/,    // the pre-BuhlOS 8k-line admin (route-ownership §7)
  /^\/buhlos\//,         // discarded /buhlos/* mirrors
  /^\/dev\/site-office/, // deprecated "Site Office" naming (route-ownership §7)
  /^\/my-day$/,          // legacy tradie home
  /^\/my-gear$/,         // legacy gear page
  /^\/overview$/,        // legacy alias of /admin/operations
  /^\/approvals$/,       // legacy alias of /admin/approvals
  /^\/phil$/,            // bare /phil is legacy phil.html in prod
];

// Deprecated PRODUCT names. Per docs/architecture/00-rebuild-non-negotiables.md
// the surfaces are BuhlOS and Phil; "Switchboard" / "Site Office" are old
// product names and must not reappear as current UI. Matched against modern nav
// LABELS only (a controlled vocabulary) so the electrical-domain senses survive:
//   - \bSwitchboard\b matches the singular product name but NOT "Switchboards"
//     (the electrical register sense) — see src/domains/itp scope labels.
//   - the legacy shell's own `data-sec="switchboard"` ban lives in
//     scripts/smoke-admin-routes.js.
const DEPRECATED_NAME_PATTERNS = [
  { re: /\bswitchboard\b/i, name: 'Switchboard' },
  { re: /\bsite[ -]?office\b/i, name: 'Site Office' },
];

// Route source files that the contract names as canonical/transitional. If one
// is renamed/removed, the contract (and likely the nav) needs updating.
const REQUIRED_SOURCES = [
  'src/app/v2/login/page.tsx',
  'src/app/(admin)/command-centre/page.tsx',
  'src/app/(admin)/hours/page.tsx',
  'src/app/(admin)/hours/approvals/page.tsx',
  'src/app/(admin)/hours/weekly/page.tsx',
  'src/app/(admin)/gear/page.tsx',
  'src/app/(admin)/employees/page.tsx',
  'src/app/(admin)/employees/[id]/page.tsx',
  'src/app/(admin)/observations/page.tsx',
  'src/app/(admin)/material-requests/page.tsx',
  'src/app/v2/jobs/page.tsx',
  'src/app/v2/jobs/[jobId]/page.tsx',
  'src/app/v2/jobs/[jobId]/builder/page.tsx',
  'src/app/v2/jobs/[jobId]/plans/page.tsx',
  'src/app/phil/my-day/page.tsx',
  'src/app/phil/jobs/page.tsx',
  'src/app/phil/jobs/[jobId]/page.tsx',
  'src/app/phil/jobs/[jobId]/plans/page.tsx',
  'src/app/phil/hours/page.tsx',
  'src/app/phil/gear/page.tsx',
  'src/app/v2/phil/page.tsx',
  // Shell components (their markers are enforced by check-shell-contract.js).
  'src/components/admin/AdminShell.tsx',
  'src/components/admin/AdminSidebar.tsx',
  'src/components/phil/PhilShell.tsx',
  'src/components/phil/PhilTabBar.tsx',
  'src/lib/auth/landing.ts',
];

// ── 1. Contract document present ─────────────────────────────────────
if (!exists('docs/route-ownership.md')) {
  fail('docs/route-ownership.md is missing',
    'The route ownership contract that this guard enforces must exist.');
}

// ── 2. Required route sources present ────────────────────────────────
for (const rel of REQUIRED_SOURCES) {
  if (!exists(rel)) {
    fail('missing route source: ' + rel,
      'docs/route-ownership.md names this file as canonical/transitional. ' +
      'If it moved, update the contract, the nav, and this guard together.');
  }
}

// ── Nav parsing ──────────────────────────────────────────────────────
// Extract the array literal assigned to `const <name>` and pull one href +
// one status from each one-level { ... } object inside it. Nav items contain
// no nested braces, and the interface above `const <name>` is excluded by
// slicing from the declaration. Returns [{ href, status }].
//
// `status` is optional: the admin NAV tags each item live/under-construction,
// but the Phil tab bar (LEFT_TABS/RIGHT_TABS) dropped the field when the centre
// Capture FAB replaced the old UC "Snag" tab — every remaining tab is live, so
// a missing status defaults to 'live'.
function parseNavItems(src, arrayName) {
  const start = src.indexOf('const ' + arrayName);
  if (start === -1) return null;
  const rest = src.slice(start);
  const end = rest.indexOf('\n];');
  const body = end === -1 ? rest : rest.slice(0, end);
  const items = [];
  const objects = body.match(/\{[^{}]*\}/g) || [];
  for (const obj of objects) {
    const hrefM = obj.match(/href:\s*"([^"]+)"/);
    if (!hrefM) continue;
    const statusM = obj.match(/status:\s*"([^"]+)"/);
    const labelM = obj.match(/label:\s*"([^"]+)"/);
    items.push({
      href: hrefM[1],
      status: statusM ? statusM[1] : 'live',
      label: labelM ? labelM[1] : '',
    });
  }
  return items;
}

function checkNav(file, arrayNames, approved, label) {
  if (!exists(file)) return; // already reported by REQUIRED_SOURCES
  const src = read(file);
  let items = [];
  for (const name of arrayNames) {
    const parsed = parseNavItems(src, name);
    if (parsed) items = items.concat(parsed);
  }
  if (items.length === 0) {
    fail(label + ': could not parse nav items from ' + file,
      'Expected `const ' + arrayNames.join('/') + ' = [ { href, status? }, ... ]`. ' +
      'If the nav shape changed, update scripts/check-route-ownership.js.');
    return;
  }
  // Deprecated product names must not reappear as a nav label — live OR UC.
  for (const item of items) {
    for (const dep of DEPRECATED_NAME_PATTERNS) {
      if (item.label && dep.re.test(item.label)) {
        fail(label + ': nav label uses the deprecated product name "' + dep.name +
          '" ("' + item.label + '")',
          'The surfaces are BuhlOS and Phil; "Switchboard" / "Site Office" are ' +
          'deprecated product names and must not appear as current UI. ' +
          'See docs/route-ownership.md §2 and docs/architecture/00-rebuild-non-negotiables.md.');
      }
    }
  }
  const live = items.filter((i) => i.status === 'live');
  if (live.length === 0) {
    fail(label + ': no live nav items found',
      'A nav with zero live destinations is almost certainly a regression.');
  }
  for (const item of live) {
    for (const pat of FORBIDDEN_NAV_PATTERNS) {
      if (pat.test(item.href)) {
        fail(label + ': live nav links to a legacy/obsolete route "' + item.href + '"',
          'Modern navigation must not link to legacy public/*.html or /admin/* URLs. ' +
          'See docs/route-ownership.md §9 Navigation contract.');
      }
    }
    if (!approved.has(item.href)) {
      fail(label + ': live nav links to non-approved route "' + item.href + '"',
        'Approved targets: ' + [...approved].join(', ') + '. ' +
        'If this is an intended new route, add it here and to docs/route-ownership.md §9.');
    }
  }
}

checkNav('src/components/admin/AdminSidebar.tsx', ['NAV'], APPROVED_ADMIN_HREFS, 'AdminSidebar');
checkNav('src/components/phil/PhilTabBar.tsx', ['LEFT_TABS', 'RIGHT_TABS'], APPROVED_PHIL_HREFS, 'PhilTabBar');

// ── 6. landingFor() role -> landing map ──────────────────────────────
// Assert the canonical map, especially that field workers land on the Phil
// home and not the /v2/phil placeholder (the PR 1 fix).
if (exists('src/lib/auth/landing.ts')) {
  const src = read('src/lib/auth/landing.ts');
  const expected = [
    { role: 'admin', re: /isAdminRole\(r\)\)\s*return\s*"\/command-centre"/, landing: '/command-centre' },
    { role: 'leading hand', re: /isLeadingHandRole\(r\)\)\s*return\s*"\/lh"/, landing: '/lh' },
    { role: 'field', re: /isFieldRole\(r\)\)\s*return\s*"\/phil\/my-day"/, landing: '/phil/my-day' },
    { role: 'client', re: /isClientRole\(r\)\)\s*return\s*"\/client"/, landing: '/client' },
  ];
  for (const e of expected) {
    if (!e.re.test(src)) {
      fail('landingFor() does not map ' + e.role + ' -> ' + e.landing,
        'docs/route-ownership.md §10 is the source of truth for role landings. ' +
        (e.role === 'field'
          ? 'Field workers must land on /phil/my-day (the Phil home), not /v2/phil (placeholder).'
          : 'Update the contract and this guard together if the landing intentionally changed.'));
    }
  }
}

// ── 7. Deprecated "Site Office" product name in active legacy UI ──────
// The nav-label check above covers the modern surfaces' controlled
// vocabulary. The recurring field-readiness leak is the *legacy* static
// surface (public/*.html + the shared admin shell): it is production today
// (route-ownership §6) and still rendered the deprecated "Site Office"
// product name. Scan the curated active, user-facing surfaces and fail if
// it reappears. Two senses are intentionally NOT flagged:
//   - the deprecated localStorage key prefix `buhl-site-office-*`, kept so
//     existing prefs aren't orphaned (the modern app cleans it up in
//     src/app/v2/login/login-form.tsx) — spared via the lookbehind;
//   - the electrical sense of "switchboard" is never matched here at all
//     (this check is "Site Office" only; the Switchboard product-name ban
//     stays scoped to nav labels + the operations.html data-sec check).
const ACTIVE_USER_FACING_SURFACES = [
  'public/login.html',
  'public/phil.html',
  'public/lh-home.html',
  'public/admin/_shell.js',
];
const SITE_OFFICE_RE = /(?<!buhl-)\bsite[ -]?office\b/i;
for (const rel of ACTIVE_USER_FACING_SURFACES) {
  if (!exists(rel)) continue; // legacy surfaces; not in REQUIRED_SOURCES
  read(rel).split(/\r?\n/).forEach((line, idx) => {
    if (SITE_OFFICE_RE.test(line)) {
      fail(rel + ':' + (idx + 1) + ' uses the deprecated product name "Site Office"',
        'The active surfaces are BuhlOS (office) and Phil (field). "Site Office" is a ' +
        'deprecated product name and must not appear in production UI — replace office-app ' +
        'references with "BuhlOS". (The `buhl-site-office-*` localStorage key is exempt.) ' +
        'See docs/route-ownership.md §7 / §9.');
    }
  });
}

// The deprecated /dev/site-office surface can't be renamed/removed in a
// naming PR (route-ownership §12 step 5), so it must be visibly
// quarantined: it must carry a DEPRECATED marker so anyone who lands on it
// sees the old name is not current.
const DEV_SITE_OFFICE = 'public/dev/site-office/components.html';
if (exists(DEV_SITE_OFFICE) && !/deprecated/i.test(read(DEV_SITE_OFFICE))) {
  fail(DEV_SITE_OFFICE + ' is the deprecated "Site Office" dev surface but has no DEPRECATED marker',
    'It cannot be renamed/removed here (route-ownership §12), so it must be visibly ' +
    'quarantined with a deprecation banner until the cleanup PR removes it.');
}

// ── Execute ──────────────────────────────────────────────────────────
console.log(DIM + 'check-route-ownership · ' + failures.length + ' issue' +
  (failures.length === 1 ? '' : 's') + RST);
console.log('');

if (failures.length) {
  for (const f of failures) {
    console.log(RED + 'FAIL ' + RST + f.msg);
    if (f.detail) console.log('     ' + YEL + f.detail + RST);
  }
  console.log('');
  console.log(RED + 'Route ownership contract violated.' + RST);
  console.log(DIM + 'See docs/route-ownership.md.' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'modern nav + landing match the route ownership contract.');
process.exit(0);
