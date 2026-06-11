#!/usr/bin/env node
// Smoke test (static): post-login admin routing must lead to a working
// /command-centre.
//
// Why: "logged-in admin sees a blank admin page" has happened repeatedly
// in this product's history — a prototype deployed over production, a
// shell page losing its boot call, a service worker caching a stale
// shell. The legacy chain (login.html → /admin/operations → SHELL.boot)
// died in the legacy-interface cutover; the modern chain this script
// locks is:
//
//   1. vercel.json redirects the legacy admin entries (/admin,
//      /admin/operations, /overview) → /command-centre, and /login →
//      /v2/login. No rewrite may shadow them.
//   2. landingFor() lands admin roles on /command-centre (the same
//      function drives the login form, the root page and middleware).
//   3. src/middleware.ts gates /command-centre behind the admin surface.
//   4. The /command-centre page exists and renders inside <AdminShell>.
//
// This is a static smoke — no browser, no network. The live-deployment
// redirect matrix runs separately via npm run smoke:legacy-redirects.
//
// Run standalone:  node scripts/smoke-admin-routes.js
// Run via npm:     npm run smoke:admin-routes
// Auto-runs on:    npm run predeploy / predeploy:preview + CI

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const RST = '\x1b[0m';

const failures = [];
function fail(msg, detail) { failures.push({ msg, detail: detail || '' }); }
function read(rel) { return fs.readFileSync(path.join(REPO, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(REPO, rel)); }

// ── 1. Edge redirects for the admin entries ───────────────────────────
if (!exists('vercel.json')) {
  fail('vercel.json missing');
} else {
  let cfg = null;
  try { cfg = JSON.parse(read('vercel.json')); }
  catch (e) { fail('vercel.json is not valid JSON', String(e && e.message)); }
  if (cfg) {
    const redirect = new Map((cfg.redirects || []).map((r) => [r.source, r.destination]));
    for (const [src, dest] of [
      ['/admin', '/command-centre'],
      ['/admin/operations', '/command-centre'],
      ['/overview', '/command-centre'],
      ['/login', '/v2/login'],
    ]) {
      if (redirect.get(src) !== dest) {
        fail('vercel.json must redirect ' + src + ' → ' + dest +
          ' (got ' + (redirect.get(src) || 'nothing') + ')');
      }
    }
    const rewriteSources = new Set((cfg.rewrites || []).map((r) => r.source));
    for (const src of ['/admin', '/admin/operations', '/login', '/overview']) {
      if (rewriteSources.has(src)) {
        fail('vercel.json also REWRITES ' + src + ' — rewrites win over the redirect chain',
          'Legacy admin entries must be redirects only.');
      }
    }
  }
}

// ── 2. landingFor(admin) → /command-centre ────────────────────────────
if (!exists('src/lib/auth/landing.ts')) {
  fail('src/lib/auth/landing.ts missing');
} else if (!/isAdminRole\(r\)\)\s*return\s*"\/command-centre"/.test(read('src/lib/auth/landing.ts'))) {
  fail('landingFor() no longer lands admin on /command-centre',
    'The login form, root page and middleware all use this map.');
}

// ── 3. Middleware gates /command-centre ───────────────────────────────
if (!exists('src/middleware.ts')) {
  fail('src/middleware.ts missing');
} else {
  const mw = read('src/middleware.ts');
  if (!/["']\/command-centre["']\s*,\s*surface:\s*["']admin["']/.test(mw)) {
    fail('src/middleware.ts no longer gates /command-centre behind the admin surface',
      'An ungated command centre leaks the admin shell to field/clients.');
  }
}

// ── 4. The command-centre page renders inside AdminShell ──────────────
const PAGE = 'src/app/(admin)/command-centre/page.tsx';
if (!exists(PAGE)) {
  fail(PAGE + ' missing', 'The canonical admin entry must exist.');
} else {
  const page = read(PAGE);
  if (!/<AdminShell\b/.test(page)) {
    fail(PAGE + ' does not render <AdminShell>',
      'The admin entry must mount the modern shell (scripts/check-shell-contract.js).');
  }
}

// ── Execute ──────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) {
    console.log(RED + 'FAIL ' + RST + f.msg);
    if (f.detail) console.log('     ' + YEL + f.detail + RST);
  }
  console.log('');
  console.log(RED + 'Admin routing chain broken.' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'admin chain intact: legacy entries redirect → /command-centre, admin lands there, gated, renders AdminShell.');
process.exit(0);
