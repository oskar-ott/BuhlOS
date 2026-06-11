#!/usr/bin/env node
// Static check: the legacy admin shell stays deleted.
//
// History: this script used to assert every public/admin/*.html called
// SHELL.boot() (the legacy shell's boot contract — see git history for the
// blank-page regressions that motivated it). The legacy-interface cutover
// deleted the whole public/admin suite; the failure mode this script now
// guards is the opposite one — somebody resurrecting the old shell.
//
// The modern admin shell is src/components/admin/AdminShell.tsx and its
// per-page rendering contract is enforced by scripts/check-shell-contract.js.
// The broader legacy quarantine lives in scripts/check-legacy-quarantine.js;
// this script stays (same npm name, same predeploy/CI slot) as the focused
// tripwire for the admin-shell shape.
//
// Run standalone:    node scripts/check-admin-shell.js
// Run via npm:       npm run check:admin-shell
// Auto-runs on:      npm run predeploy / predeploy:preview + CI

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const RST = '\x1b[0m';

const offenders = [];
for (const rel of ['public/admin', 'public/admin.html']) {
  if (fs.existsSync(path.join(REPO, rel))) offenders.push(rel);
}

if (offenders.length) {
  for (const rel of offenders) {
    console.log(RED + 'FAIL ' + RST + rel + ' exists — the legacy admin shell was deleted in the legacy-interface cutover.');
  }
  console.log('');
  console.log(RED + 'Legacy admin shell must stay deleted.' + RST +
    ' Old /admin/* URLs redirect to modern routes (vercel.json); the admin UI is src/components/admin/AdminShell.tsx.');
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'no legacy admin shell present (public/admin stays deleted).');
process.exit(0);
