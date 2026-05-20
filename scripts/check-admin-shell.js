#!/usr/bin/env node
// Static check: every public/admin/*.html must explicitly call SHELL.boot().
//
// Why: the BuhlOS admin shell only mounts when the page script calls
// SHELL.boot(). If a page rewrite drops the call (as PR #35 did to
// operations.html), the page renders blank because the shell skeleton
// (#app, #side, #topbar, #page) is never inserted into the DOM and
// PAGE.render() is never invoked. _shell.js carries a DOMContentLoaded
// auto-boot fallback, but we still want an explicit `SHELL.boot()` in
// every page as the readable convention — and a predeploy check
// guarantees no admin page ever ships without it.
//
// Run standalone:    node scripts/check-admin-shell.js
// Run via npm:       npm run check:admin-shell
// Auto-runs on:      npm run deploy:prod  (via predeploy:prod)
//
// Exit codes: 0 = all pages OK, 1 = at least one page missing the call.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ADMIN_DIR = path.join(REPO, 'public', 'admin');

const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

// The shell entry — /admin → /admin/index.html — is a tiny redirect page,
// not a shell-driven view. It doesn't (and shouldn't) include _shell.js or
// call SHELL.boot(). All other admin pages must.
const EXEMPT = new Set(['index.html']);

let files;
try {
  files = fs.readdirSync(ADMIN_DIR).filter(f => f.endsWith('.html'));
} catch (e) {
  console.error(RED + 'FAIL ' + RST + 'cannot read ' + ADMIN_DIR + ': ' + e.message);
  process.exit(1);
}

const failures = [];
const exempted = [];
const ok = [];

for (const file of files) {
  if (EXEMPT.has(file)) { exempted.push(file); continue; }
  const full = path.join(ADMIN_DIR, file);
  const src = fs.readFileSync(full, 'utf8');

  // Must include _shell.js
  if (!/\/admin\/_shell\.js/.test(src)) {
    failures.push({ file, reason: 'does not link /admin/_shell.js' });
    continue;
  }
  // Must define window.PAGE
  if (!/window\.PAGE\s*=/.test(src)) {
    failures.push({ file, reason: 'does not define window.PAGE' });
    continue;
  }
  // Must explicitly call SHELL.boot() — the trailing call that PR #35 dropped.
  // Match in code only, not inside comments (`SHELL.boot already pre-fetched`
  // appears as a comment in operations.html so we look for the call form).
  if (!/^\s*SHELL\.boot\s*\(\s*\)\s*;?\s*$/m.test(src)) {
    failures.push({
      file,
      reason: 'does not call SHELL.boot() — page will render blank. ' +
              'Add `SHELL.boot();` as the last statement of the page script.',
    });
    continue;
  }
  ok.push(file);
}

console.log(DIM + 'check-admin-shell · ' + files.length + ' files · ' +
  ok.length + ' ok · ' + exempted.length + ' exempt · ' +
  failures.length + ' failing' + RST);

if (exempted.length) {
  console.log('  ' + DIM + 'exempt: ' + exempted.join(', ') + RST);
}

if (failures.length) {
  console.log('');
  for (const f of failures) {
    console.log(RED + 'FAIL ' + RST + 'public/admin/' + f.file);
    console.log('     ' + YEL + f.reason + RST);
  }
  console.log('');
  console.log(RED + 'Refusing to deploy ' + failures.length + ' broken admin page' +
    (failures.length === 1 ? '' : 's') + '.' + RST);
  console.log(DIM + 'Fix each page by appending `SHELL.boot();` to the page script ' +
    'and re-run this check.' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'every admin page calls SHELL.boot().');
process.exit(0);
