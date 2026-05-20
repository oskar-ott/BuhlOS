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
  // Match the destination map: "if (role === 'admin') return '/admin/operations'"
  if (!/role\s*===\s*['"]admin['"][^]*?['"]\/admin\/operations['"]/.test(src)) {
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

// ── 4. operations.html structure ─────────────────────────────────────
check('admin/operations.html links _shell.js + _shell.css', () => {
  const src = read('public/admin/operations.html');
  if (!/\/admin\/_shell\.js/.test(src))  throw new Error('does not script /admin/_shell.js');
  if (!/\/admin\/_shell\.css/.test(src)) throw new Error('does not link /admin/_shell.css');
});

check('admin/operations.html defines window.PAGE with id=operations and render()', () => {
  const src = read('public/admin/operations.html');
  if (!/window\.PAGE\s*=\s*\{[^]*?id:\s*['"]operations['"]/.test(src)) {
    throw new Error('window.PAGE.id is not "operations"');
  }
  if (!/async\s+render\s*\(/.test(src) && !/render\s*:\s*async/.test(src)) {
    throw new Error('window.PAGE.render is not defined as async');
  }
});

check('admin/operations.html explicitly calls SHELL.boot() — the regression-prone line', () => {
  const src = read('public/admin/operations.html');
  if (!/^\s*SHELL\.boot\s*\(\s*\)\s*;?\s*$/m.test(src)) {
    throw new Error('SHELL.boot(); call is missing — page will render blank');
  }
});

check('admin/operations.html has loading + error states (never goes silently blank)', () => {
  const src = read('public/admin/operations.html');
  if (!/Loading…|Loading\.\.\./i.test(src)) throw new Error('no loading placeholder');
  if (!/Couldn['"]t load|Something went wrong/i.test(src)) {
    throw new Error('no visible error fallback for failed render');
  }
  if (!/try\s*\{[^]*?catch/i.test(src)) {
    throw new Error('no try/catch around render — a throw will leave the page blank');
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
