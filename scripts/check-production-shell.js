#!/usr/bin/env node
// Static check: the production build must serve the BuhlOS admin shell,
// not the legacy Birdwood prototype.
//
// Why: on 2026-05-20 a prototype branch (claude/infallible-galileo-b45de3,
// commit d55529c) was deployed to buhlos.com via `vercel deploy --prod`,
// replacing the real build with the legacy Birdwood IV3232 horizontal-
// tab page. PR #4f69fcd added a branch-ancestry guard; this script
// adds the *content* check: even if the branch ancestry is right, the
// files about to be deployed must contain the BuhlOS shell, not the
// prototype.
//
// Rules:
//   1. public/index.html must NOT exist, OR if it exists it must NOT
//      contain "Birdwood IV3232" (the legacy prototype title).
//   2. public/admin/operations.html must exist and contain the BuhlOS
//      Command Centre shell markers (title "BuhlOS — Command Centre",
//      the "BL" brand mark, and the splash element). These prove it's
//      the new shell and not the site-office shell that was at this
//      path before the merge.
//   3. vercel.json must rewrite `/` → `/login.html` (no Birdwood root).
//   4. vercel.json must rewrite `/admin/operations` → `/admin/operations.html`.
//   5. NO root-level deployable HTML file may contain "Birdwood IV3232"
//      (catches the prototype-shape regression at a different layer
//      than the predeploy-prod-guard).
//
// Run standalone:  node scripts/check-production-shell.js
// Run via npm:     npm run check:production-shell
// Auto-runs on:    npm run predeploy / predeploy:prod

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

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}
function readJSON(rel) { return JSON.parse(read(rel)); }
function exists(rel) { return fs.existsSync(path.join(REPO, rel)); }

// ── 1. public/index.html absent (or not Birdwood) ──────────────────
if (exists('public/index.html')) {
  const src = read('public/index.html');
  if (/Birdwood IV3232/i.test(src)) {
    fail('public/index.html contains "Birdwood IV3232"',
      'This is the legacy prototype root that overwrites buhlos.com/ with the wrong UI. ' +
      'Either delete the file or rename it (it was renamed to public/project.html in 41e2194).');
  }
}

// ── 2. operations.html has BuhlOS shell markers ─────────────────────
if (!exists('public/admin/operations.html')) {
  fail('public/admin/operations.html missing',
    'The BuhlOS Command Centre shell file is required for /admin/operations.');
} else {
  const ops = read('public/admin/operations.html');
  if (!/BuhlOS\s*[—-]\s*Command Centre/i.test(ops)) {
    fail('public/admin/operations.html missing BuhlOS Command Centre title',
      'The page does not contain the "BuhlOS — Command Centre" title marker. ' +
      'It may be the old site-office shell — check that the BuhlOS shell was kept post-merge.');
  }
  if (!/id=["']splash["']/.test(ops)) {
    fail('public/admin/operations.html missing splash element',
      'The BuhlOS shell expects a #splash overlay that the boot dismisses. ' +
      'Without it the splash watchdog has nothing to dismiss.');
  }
  if (!/class=["']brand-mark["']/.test(ops)) {
    fail('public/admin/operations.html missing BL brand mark',
      'The BuhlOS shell renders a .brand-mark element with the BL identity. ' +
      'Its absence usually means the shell was replaced with something else.');
  }
  if (!/showBootError/.test(ops)) {
    fail('public/admin/operations.html missing showBootError defence',
      'The shell should define showBootError() so any boot failure surfaces a visible recovery panel ' +
      'instead of leaving the splash up. See docs/regressions/admin-operations-blank.md.');
  }
}

// ── 3. vercel.json: / → /login.html ─────────────────────────────────
let vercel;
try { vercel = readJSON('vercel.json'); } catch (e) {
  fail('vercel.json missing or unparseable', e.message);
}
if (vercel) {
  const rootRewrite = (vercel.rewrites || []).find(r => r.source === '/');
  if (!rootRewrite) {
    fail('vercel.json has no rewrite for "/"',
      'Without it, Vercel falls back to serving public/index.html for the root URL — ' +
      'which is exactly how the legacy Birdwood page leaked to production.');
  } else if (rootRewrite.destination !== '/login.html') {
    fail('vercel.json "/" rewrite destination is wrong',
      'Expected /login.html, got "' + rootRewrite.destination + '". ' +
      'Anything else risks serving the wrong page at buhlos.com/.');
  }

  const opsRewrite = (vercel.rewrites || []).find(r => r.source === '/admin/operations');
  if (!opsRewrite || opsRewrite.destination !== '/admin/operations.html') {
    fail('vercel.json /admin/operations rewrite missing or wrong',
      'Expected /admin/operations → /admin/operations.html.');
  }
}

// ── 4. No deployable file at the repo root contains "Birdwood IV3232" ──
// (catches the prototype-fingerprint that gets through if someone
//  reintroduces an index.html at root.)
const rootFiles = ['index.html', 'jobs.html', 'login.html', 'phil.html', 'buhlos.html'];
for (const f of rootFiles) {
  if (exists(f)) {
    const src = read(f);
    if (/Birdwood IV3232/i.test(src)) {
      fail('root file ' + f + ' contains "Birdwood IV3232"',
        'A deployable file at the repo root carries the legacy prototype title. ' +
        'Deployment from this state would serve the wrong UI at buhlos.com/. ' +
        'See docs/regressions/admin-operations-blank.md.');
    }
  }
}

// ── Execute ─────────────────────────────────────────────────────────
console.log(DIM + 'check-production-shell · ' + failures.length + ' issue' +
  (failures.length === 1 ? '' : 's') + RST);
console.log('');

if (failures.length) {
  for (const f of failures) {
    console.log(RED + 'FAIL ' + RST + f.msg);
    if (f.detail) console.log('     ' + YEL + f.detail + RST);
  }
  console.log('');
  console.log(RED + 'Refusing to deploy — production shell is not in the expected shape.' + RST);
  console.log(DIM + 'See docs/regressions/admin-operations-blank.md for context.' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'production shell contains the BuhlOS Command Centre, no Birdwood IV3232.');
process.exit(0);
