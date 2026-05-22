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

  // Three valid architectures:
  //
  //   A. site-office multi-page shell: links /admin/_shell.js, defines
  //      window.PAGE, ends with SHELL.boot(). Most admin pages use this.
  //
  //   B. standalone SPA shell (e.g. the BuhlOS Command Centre at
  //      operations.html): doesn't link _shell.js, has its own
  //      `async function boot()` and ends with `boot();`. Must still
  //      explicitly call boot() so the page can't go blank from a
  //      forgotten call.
  //
  //   C. redirect shim into the SPA — has both <meta http-equiv="refresh">
  //      AND a canonical link pointing at /admin/operations#section.
  //      Several per-page admin tools (job-builder, itp, plans, variations,
  //      reports) are kept as redirect shims so the canonical
  //      implementation lives in one place (the SPA).
  //
  // Any of the three is OK. What we refuse is the silent-blank shape:
  // a page that loads scripts but never actually boots its renderer
  // AND isn't a redirect.
  const usesSiteOfficeShell = /\/admin\/_shell\.js/.test(src);
  const definesWindowPage   = /window\.PAGE\s*=/.test(src);
  const callsShellBoot      = /^\s*SHELL\.boot\s*\(\s*\)\s*;?\s*$/m.test(src);
  const definesOwnBoot      = /async\s+function\s+boot\s*\(/.test(src);
  const callsOwnBoot        = /^\s*boot\s*\(\s*\)\s*;?\s*$/m.test(src);
  const hasMetaRefresh      = /<meta[^>]+http-equiv=["']?refresh["']?/i.test(src);
  const hasSpaCanonical     = /<link[^>]+rel=["']?canonical["']?[^>]+href=["']\/admin\/operations#/i.test(src);

  if (hasMetaRefresh && hasSpaCanonical) {
    // Pattern C — redirect shim. Nothing else required.
    ok.push(file);
    continue;
  }

  if (usesSiteOfficeShell) {
    // Pattern A — site-office shell.
    if (!definesWindowPage) {
      failures.push({ file, reason: 'links /admin/_shell.js but does not define window.PAGE' });
      continue;
    }
    if (!callsShellBoot) {
      failures.push({
        file,
        reason: 'does not call SHELL.boot() — page will render blank. ' +
                'Add `SHELL.boot();` as the last statement of the page script.',
      });
      continue;
    }
  } else if (definesOwnBoot) {
    // Pattern B — standalone SPA. Must call its own boot().
    if (!callsOwnBoot) {
      failures.push({
        file,
        reason: 'defines async function boot() but does not call boot() — page will render blank. ' +
                'Add `boot();` as the last statement of the page script.',
      });
      continue;
    }
  } else {
    failures.push({
      file,
      reason: 'page neither links /admin/_shell.js nor defines its own async boot() — ' +
              'no shell will mount. Use one of the two supported patterns.',
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
