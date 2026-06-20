#!/usr/bin/env node
// Static check: any change to public/sw.js must bump its SW_VERSION
// literal.
//
// History: the pre-cutover service worker precached the legacy admin
// shell, and shipping shell changes without a CACHE_VERSION bump left
// devices replaying stale layouts (the "blank /admin/operations" saga —
// see git history). The legacy-interface cutover made v9 push-only; v11
// (#135 Layer 2) then re-introduced a NETWORK-FIRST offline read cache for
// /phil/* pages + /_next/static assets (version-scoped, dropped on activate).
// Because the cache is network-first, a normal page/app deploy is always
// served live and does NOT need a bump; this check only fires when
// public/sw.js ITSELF changes. The bump rule then does two jobs: a visible
// version literal makes fleet rollout auditable (confirm from any device
// which worker it runs), and the diff reviewer is forced to acknowledge
// they're touching the push + offline-cache path every installed phone
// depends on.
//
// Rule: public/sw.js differs from origin/main ⇒ the SW_VERSION line must
// differ too.
//
// Run standalone:  node scripts/check-sw-cache-version.js
// Run via npm:     npm run check:sw-cache-version
// Auto-runs on:    npm run predeploy / predeploy:preview + CI

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

const SW = 'public/sw.js';
const VERSION_RE = /const SW_VERSION = '([^']+)'/;

function gitShow(ref, rel) {
  try {
    return execSync(`git show ${ref}:${rel}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const current = fs.existsSync(path.join(REPO, SW))
  ? fs.readFileSync(path.join(REPO, SW), 'utf8')
  : null;

if (current === null) {
  console.log(RED + 'FAIL ' + RST + SW + ' is missing — existing PushSubscriptions are registered against /sw.js.');
  process.exit(1);
}

const base = gitShow('origin/main', SW) ?? gitShow('main', SW);
if (base === null) {
  console.log(DIM + 'check-sw-cache-version · no origin/main baseline (fresh clone?) — skipping diff check.' + RST);
  process.exit(0);
}

const curVer = (current.match(VERSION_RE) || [])[1];
if (!curVer) {
  console.log(RED + 'FAIL ' + RST + SW + " has no `const SW_VERSION = '...'` literal.");
  console.log('     ' + YEL + 'The version literal is the fleet-rollout audit handle — keep it.' + RST);
  process.exit(1);
}

if (base === current) {
  console.log(GRN + 'OK   ' + RST + 'sw.js unchanged vs origin/main (' + DIM + curVer + RST + ').');
  process.exit(0);
}

const baseVer = (base.match(VERSION_RE) || (base.match(/const CACHE_VERSION = '([^']+)'/) || []))[1];
if (baseVer && baseVer === curVer) {
  console.log(RED + 'FAIL ' + RST + 'sw.js changed but SW_VERSION did not (' + curVer + ').');
  console.log('     ' + YEL + 'Bump SW_VERSION whenever sw.js behaviour changes so the fleet rollout is auditable.' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'sw.js changed AND SW_VERSION bumped (' + DIM + (baseVer || '?') + ' → ' + curVer + RST + ').');
process.exit(0);
