#!/usr/bin/env node
// Predeploy guard: refuse to deploy --prod from anything other than main.
//
// Why: on 2026-05-20 a worktree branched off a tiny pre-BuhlOS prototype
// (claude/infallible-galileo-b45de3, commit d55529c) was deployed to
// buhlos.com via `vercel deploy --prod`. That deploy replaced the BuhlOS
// build with the legacy Birdwood horizontal-tab page. The whole point of
// the GitHub → Vercel integration is that main is the only source of
// production truth — but `vercel deploy --prod` from a feature branch
// bypasses that. This guard makes the mistake hard to repeat.
//
// Rule: if invoked as predeploy:prod (or PRODUCTION=true), the current
// HEAD must equal origin/main. Anything else (detached HEAD, divergent
// branch, prototype branch) is rejected.
//
// Override: GUARD_OVERRIDE=YES-I-KNOW skips the check for emergency
// reverts. The bypass is verbose so it shows up in CI logs.
//
// Run standalone:  node scripts/check-prod-branch.js
// Run via npm:     npm run check:prod-branch
// Auto-runs on:    npm run predeploy:prod  (NOT predeploy:preview)

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

function tryExec(cmd) {
  try { return execSync(cmd, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
  catch (e) { return null; }
}

if (process.env.GUARD_OVERRIDE === 'YES-I-KNOW') {
  console.log(YEL + 'WARN ' + RST + 'GUARD_OVERRIDE=YES-I-KNOW set — skipping branch-ancestry check.');
  console.log(DIM + '     Only use this for emergency reverts. Bypass is logged in CI.' + RST);
  process.exit(0);
}

// Best-effort fetch so origin/main is current. Failures are warned but
// don't block — local dev without network shouldn't break the check.
tryExec('git fetch origin main --quiet');

const headSha = tryExec('git rev-parse HEAD');
const mainSha = tryExec('git rev-parse origin/main');
const branch  = tryExec('git rev-parse --abbrev-ref HEAD') || '(detached)';

if (!headSha) {
  console.log(RED + 'FAIL ' + RST + 'cannot resolve HEAD');
  process.exit(1);
}
if (!mainSha) {
  console.log(RED + 'FAIL ' + RST + 'cannot resolve origin/main');
  console.log('     ' + YEL + 'Without origin/main, this guard can\'t verify the branch is right.' + RST);
  console.log('     ' + DIM + 'Run `git fetch origin main` and try again, or set GUARD_OVERRIDE=YES-I-KNOW.' + RST);
  process.exit(1);
}

if (headSha !== mainSha) {
  console.log(RED + 'FAIL ' + RST + 'HEAD is not origin/main.');
  console.log('');
  console.log('     branch:        ' + YEL + branch + RST);
  console.log('     HEAD:          ' + DIM + headSha + RST);
  console.log('     origin/main:   ' + DIM + mainSha + RST);
  console.log('');
  console.log(RED + 'Refusing to deploy --prod from a non-main branch.' + RST);
  console.log(DIM + 'Production is served from main only. To ship this branch:' + RST);
  console.log(DIM + '  1. Open a PR against main' + RST);
  console.log(DIM + '  2. Merge it' + RST);
  console.log(DIM + '  3. Vercel auto-deploys from main' + RST);
  console.log(DIM + 'For an emergency revert: GUARD_OVERRIDE=YES-I-KNOW npm run deploy:prod' + RST);
  console.log(DIM + 'See docs/regressions/admin-operations-blank.md for the incident this prevents.' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'HEAD === origin/main (' + DIM + mainSha.slice(0, 7) + RST + ').');
process.exit(0);
