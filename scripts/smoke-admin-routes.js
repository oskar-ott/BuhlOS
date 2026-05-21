#!/usr/bin/env node
// Smoke test: post-login routing must lead to a working /admin/operations.
//
// Why: this exact regression has happened multiple times — once when a
// prototype branch was deployed to prod (PR #4f69fcd: predeploy guard), once
// when a page rewrite dropped the SHELL.boot() call (PR #35), once when a
// service worker cached a stale shell (PR #228). Each time, the symptom was
// the same: a logged-in admin sees /admin/operations blank.
//
// This script statically checks every link in that chain so a broken chain
// fails the build, not production:
//
//   1. vercel.json must rewrite /admin/operations → /admin/operations.html.
//   2. vercel.json must rewrite /admin → /admin/index.html (the redirect).
//   3. public/login.html must redirect admin → /admin/operations.
//   4. public/admin/index.html must redirect admin → /admin/operations.
//   5. public/admin/operations.html must define window.PAGE + call SHELL.boot()
//      + render visible content (heading, loading state, error fallback).
//   6. public/admin/_shell.js must expose SHELL.boot AND have an auto-boot
//      fallback (in case any single page forgets the explicit call).
//
// This is a static smoke test — no browser needed. It runs in CI / predeploy
// and catches the dead-link / dead-redirect / dead-render shape before a
// deploy ships blank.
//
// Run standalone:  node scripts/smoke-admin-routes.js
// Run via npm:     npm run smoke:admin-routes
// Auto-runs on:    npm run deploy:prod  (via predeploy:prod)

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}
function readJSON(rel) {
  return JSON.parse(read(rel));
}

// ── 1. vercel.json rewrites ──────────────────────────────────────────
check('vercel.json rewrites /admin/operations → /admin/operations.html', () => {
  const v = readJSON('vercel.json');
  const rw = (v.rewrites || []).find(r => r.source === '/admin/operations');
  if (!rw) throw new Error('no rewrite for /admin/operations');
  if (rw.destination !== '/admin/operations.html') {
    throw new Error('destination is "' + rw.destination + '" not /admin/operations.html');
  }
});

check('vercel.json rewrites /admin → /admin/index.html', () => {
  const v = readJSON('vercel.json');
  const rw = (v.rewrites || []).find(r => r.source === '/admin');
  if (!rw) throw new Error('no rewrite for /admin');
  if (rw.destination !== '/admin/index.html') {
    throw new Error('destination is "' + rw.destination + '" not /admin/index.html');
  }
});

check('vercel.json does NOT rewrite / → /jobs.html (legacy prototype fingerprint)', () => {
  const v = readJSON('vercel.json');
  const rw = (v.rewrites || []).find(r => r.source === '/');
  if (rw && rw.destination === '/jobs.html') {
    throw new Error('root rewrite points at /jobs.html — that is the legacy prototype root');
  }
});

// ── 2. login.html must redirect admin to /admin/operations ───────────
check('login.html redirects admin role to /admin/operations', () => {
  const src = read('public/login.html');
  // Two valid shapes:
  //   old: `if (role === 'admin') return '/admin/operations'`
  //   new: `if ([...,'admin',...].includes(r)) return '/admin/operations'`
  // Either must show admin → /admin/operations in the landing map.
  const oldShape = /role\s*===\s*['"]admin['"][^]*?['"]\/admin\/operations['"]/.test(src);
  const newShape = /['"]admin['"][^]*?\.includes\([^)]*\)\)\s*return\s*['"]\/admin\/operations['"]/.test(src);
  if (!oldShape && !newShape) {
    throw new Error('login.html admin → /admin/operations redirect not found');
  }
});

// ── 3. /admin entry redirects admin to /admin/operations ─────────────
check('admin/index.html redirects admin role to /admin/operations', () => {
  const src = read('public/admin/index.html');
  if (!src.includes('/admin/operations')) {
    throw new Error('admin/index.html does not reference /admin/operations');
  }
  if (!/location\.(replace|href)\s*\(\s*['"]\/admin\/operations['"]/.test(src)) {
    throw new Error('admin/index.html does not call location.replace("/admin/operations")');
  }
});

// ── 4. operations.html — BuhlOS Command Centre SPA ──────────────────
// As of the post-d9b8d74 integration, operations.html is a standalone
// SPA (BuhlOS Command Centre), not a site-office multi-page using
// /admin/_shell.js. Checks now match the SPA shape.
check('admin/operations.html is the BuhlOS Command Centre shell', () => {
  const src = read('public/admin/operations.html');
  if (!/<title>\s*BuhlOS\s*[—-]\s*Command Centre\s*<\/title>/i.test(src)) {
    throw new Error('title is not "BuhlOS — Command Centre" — shell may be wrong');
  }
  if (!/class=["']brand-mark["']/.test(src)) {
    throw new Error('BL brand mark missing from shell');
  }
});

check('admin/operations.html defines its own async boot() and calls it', () => {
  const src = read('public/admin/operations.html');
  if (!/async\s+function\s+boot\s*\(/.test(src)) {
    throw new Error('async function boot() is not defined');
  }
  if (!/^\s*boot\s*\(\s*\)\s*;?\s*$/m.test(src)) {
    throw new Error('boot(); call missing — page will render blank');
  }
});

check('admin/operations.html boot() is wrapped in try/catch/finally', () => {
  const src = read('public/admin/operations.html');
  if (!/async\s+function\s+boot\s*\(\s*\)\s*\{[^]*?try\s*\{[^]*?catch[^]*?finally/i.test(src)) {
    throw new Error('boot() lacks the outer try/catch/finally — a throw would leave the splash up');
  }
});

check('admin/operations.html has splash element + dismissSplash + showBootError', () => {
  const src = read('public/admin/operations.html');
  if (!/id=["']splash["']/.test(src)) throw new Error('no #splash element');
  if (!/function\s+dismissSplash/.test(src)) throw new Error('no dismissSplash() helper');
  if (!/function\s+showBootError/.test(src)) {
    throw new Error('no showBootError() — boot failure would leave page blank');
  }
});

check('admin/operations.html has splash watchdog (12s safety timer)', () => {
  const src = read('public/admin/operations.html');
  if (!/_splashWatchdog/.test(src)) {
    throw new Error('no _splashWatchdog — splash could hang forever if boot stalls');
  }
});

check('admin/operations.html accepts expanded admin-capable roles', () => {
  const src = read('public/admin/operations.html');
  // The role gate must NOT be the old `role !== 'admin'` hard-only check;
  // it must use the expanded ADMIN_ROLES list so boss/owner/manager/etc.
  // can land in the command centre too.
  if (!/ADMIN_ROLES\s*=\s*\[/.test(src)) {
    throw new Error('ADMIN_ROLES allowlist missing — only "admin" can sign in');
  }
  if (!/boss/.test(src) || !/manager/.test(src) || !/office/.test(src)) {
    throw new Error('ADMIN_ROLES does not include boss / manager / office');
  }
});

check('admin/operations.html routes leadingHand to /lh, not /jobs', () => {
  const src = read('public/admin/operations.html');
  if (!/LEADING_HAND_ROLES/.test(src)) {
    throw new Error('LEADING_HAND_ROLES not defined — leading hands may infinite-redirect');
  }
  if (!/['"]\/lh['"]/.test(src)) {
    throw new Error('No /lh redirect for leading hands');
  }
});

// ── 5. shell guardrails ──────────────────────────────────────────────
check('_shell.js exposes SHELL.boot via window.SHELL', () => {
  const src = read('public/admin/_shell.js');
  if (!/window\.SHELL\s*=/.test(src)) throw new Error('does not assign window.SHELL');
  if (!/boot:\s*safeBoot/.test(src))  throw new Error('window.SHELL.boot is not wired to safeBoot');
});

check('_shell.js has DOMContentLoaded auto-boot fallback', () => {
  const src = read('public/admin/_shell.js');
  if (!/_autoBootIfMissing|auto-boot/i.test(src)) {
    throw new Error('no auto-boot fallback — a future page that forgets SHELL.boot() will be blank');
  }
});

check('_shell.js has blank-shell detector (last-line recovery)', () => {
  const src = read('public/admin/_shell.js');
  if (!/_checkBlankShell|blank-shell|blank shell/i.test(src)) {
    throw new Error('no blank-shell detector — silent blank pages still possible');
  }
});

check('safeBoot wraps boot() with a top-level try/catch', () => {
  const src = read('public/admin/_shell.js');
  if (!/async function safeBoot\s*\(\s*\)\s*\{[^]*?try\s*\{[^]*?boot\s*\(/.test(src)) {
    throw new Error('safeBoot does not try/catch boot() — uncaught throws will leave page blank');
  }
});

// ── 6. /api/auth endpoint exists ─────────────────────────────────────
check('api/auth.js endpoint exists (login depends on it)', () => {
  const p = path.join(REPO, 'api', 'auth.js');
  if (!fs.existsSync(p)) throw new Error('api/auth.js missing — login + boot will break');
});

// ── Execute ──────────────────────────────────────────────────────────
const failures = [];
const passed = [];
for (const { name, fn } of checks) {
  try {
    fn();
    passed.push(name);
  } catch (e) {
    failures.push({ name, error: e.message });
  }
}

console.log(DIM + 'smoke-admin-routes · ' + checks.length + ' checks · ' +
  passed.length + ' pass · ' + failures.length + ' fail' + RST);
console.log('');

for (const name of passed) {
  console.log(GRN + 'PASS ' + RST + name);
}
if (failures.length) {
  console.log('');
  for (const f of failures) {
    console.log(RED + 'FAIL ' + RST + f.name);
    console.log('     ' + YEL + f.error + RST);
  }
  console.log('');
  console.log(RED + 'Refusing to deploy: ' + failures.length + ' route check' +
    (failures.length === 1 ? '' : 's') + ' failed.' + RST);
  console.log(DIM + 'See docs/regressions/admin-operations-blank.md for context.' + RST);
  process.exit(1);
}

console.log('');
console.log(GRN + 'OK   ' + RST + '/admin/operations route chain is intact.');
process.exit(0);
