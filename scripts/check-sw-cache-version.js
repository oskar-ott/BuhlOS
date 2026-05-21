#!/usr/bin/env node
// Static check: if the admin shell changed, public/sw.js's CACHE_VERSION
// must change too. Otherwise clients on the old SW keep serving stale
// _shell.js / _shell.css out of cache (stale-while-revalidate is the
// default in sw.js), and the deploy looks broken to existing users
// even though production is serving the right HTML.
//
// This already burned us once. PR #234 fixed `blank /admin/operations`
// in operations.html + _shell.js but forgot to bump CACHE_VERSION;
// clients with the v2 SW kept rendering blank until a follow-up bumped
// to v3.
//
// Rule: any change to the following files vs origin/main MUST be paired
// with a CACHE_VERSION change in public/sw.js:
//   - public/admin/_shell.js
//   - public/admin/_shell.css
//   - public/admin/*.html
//   - public/components/*.js
//   - public/theme.css
//
// Run standalone:  node scripts/check-sw-cache-version.js
// Run via npm:     npm run check:sw-cache-version
// Auto-runs on:    npm run predeploy
//
// Exits 0 if either (a) no shell files changed, (b) shell files changed
// AND CACHE_VERSION changed. Exits 1 if shell files changed but
// CACHE_VERSION didn't.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

const SHELL_GLOBS = [
  'public/admin/_shell.js',
  'public/admin/_shell.css',
  'public/theme.css',
];
const SHELL_DIRS = [
  'public/admin/',     // any *.html under here
  'public/components/', // any *.js under here
];

function tryExec(cmd) {
  try { return execSync(cmd, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
  catch (e) { return null; }
}

// Get the baseline (origin/main, or first parent of HEAD if main isn't
// accessible — useful for local-only repos). We diff HEAD against the
// baseline to find what changed.
let baseline = tryExec('git rev-parse --verify origin/main 2>/dev/null');
if (!baseline) baseline = tryExec('git rev-parse --verify HEAD~1');
if (!baseline) {
  console.log(YEL + 'WARN ' + RST + 'no baseline (no origin/main, no HEAD~1) — skipping SW cache check.');
  console.log(DIM + '     This is normal on the first commit. Add the check back as the repo grows.' + RST);
  process.exit(0);
}

// Files changed between baseline and the working tree (committed + staged
// + unstaged). Use diff --name-only HEAD plus diff --name-only baseline..HEAD
// then union both sets.
const diffWorking = tryExec(`git diff --name-only ${baseline}`) || '';
const diffStaged = tryExec(`git diff --name-only --cached ${baseline}`) || '';
const changedSet = new Set();
for (const line of (diffWorking + '\n' + diffStaged).split(/\r?\n/)) {
  if (line) changedSet.add(line);
}

// Decide if any shell-impacting file changed.
const changedShellFiles = [];
for (const f of changedSet) {
  if (SHELL_GLOBS.includes(f)) { changedShellFiles.push(f); continue; }
  for (const d of SHELL_DIRS) {
    if (f.startsWith(d)) {
      // Only count .html under admin/ and .js under components/, etc.
      if (d === 'public/admin/' && !f.endsWith('.html')) continue;
      if (d === 'public/components/' && !f.endsWith('.js')) continue;
      changedShellFiles.push(f);
      break;
    }
  }
}

if (changedShellFiles.length === 0) {
  console.log(GRN + 'OK   ' + RST + 'no admin shell files changed vs ' +
    DIM + baseline.slice(0, 7) + RST + ' — CACHE_VERSION bump not required.');
  process.exit(0);
}

// Shell changed — CACHE_VERSION must have changed too. Read the version
// from sw.js at the baseline and the working tree, compare.
function extractCacheVersion(src) {
  const m = src.match(/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

const swCurrent = fs.readFileSync(path.join(REPO, 'public/sw.js'), 'utf8');
const versionCurrent = extractCacheVersion(swCurrent);
if (!versionCurrent) {
  console.log(RED + 'FAIL ' + RST + 'cannot find CACHE_VERSION in public/sw.js');
  process.exit(1);
}

const swBaseline = tryExec(`git show ${baseline}:public/sw.js`);
const versionBaseline = swBaseline ? extractCacheVersion(swBaseline) : null;

if (versionBaseline && versionCurrent === versionBaseline) {
  console.log(RED + 'FAIL ' + RST + 'admin shell changed but CACHE_VERSION did not.');
  console.log('');
  console.log('     changed files:');
  for (const f of changedShellFiles) console.log('       ' + YEL + f + RST);
  console.log('');
  console.log('     ' + DIM + 'baseline:' + RST + ' CACHE_VERSION = ' + DIM + versionBaseline + RST);
  console.log('     ' + DIM + 'current: ' + RST + ' CACHE_VERSION = ' + DIM + versionCurrent + RST);
  console.log('');
  console.log(RED + 'Refusing to deploy.' + RST);
  console.log(DIM + 'Bump CACHE_VERSION in public/sw.js (e.g. ' +
    versionCurrent.replace(/(\d+)$/, (m) => String(parseInt(m, 10) + 1)) +
    ') so existing clients get fresh shell assets after deploy.' + RST);
  console.log(DIM + 'See docs/regressions/admin-operations-blank.md for context.' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'admin shell changed AND CACHE_VERSION bumped (' +
  DIM + (versionBaseline || '(new)') + ' → ' + versionCurrent + RST + ').');
process.exit(0);
