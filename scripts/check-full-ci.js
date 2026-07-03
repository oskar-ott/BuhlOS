#!/usr/bin/env node
'use strict';

// Canonical local CI-parity gate — run this before opening or updating a PR.
//
// WHY THIS EXISTS
//   `npm run check` only runs typecheck + lint + test:unit. The CI "check" job
//   (.github/workflows/ci.yml) runs a much larger guard set — build, the smoke
//   discovery list, and ~11 route/shell/manifest/quarantine guards. PRs have
//   merged red TWICE because a guard that only runs in CI was missed locally
//   (backup-manifest on #436, legacy-quarantine on #438). This script mirrors
//   the CI check job so "green locally" means "green in CI".
//
// CONTRACT
//   - STEPS is the source of truth and MUST stay a superset of every `npm run`
//     the CI check job invokes. A drift-guard test
//     (src/domains/platform/check-full-ci.test.ts) parses ci.yml and fails if
//     CI gains a guard that isn't listed here — so this list can't silently
//     fall behind CI.
//   - Each step shells out to the EXISTING npm alias; no command logic is
//     duplicated here, only the ordering.
//   - Fails HARD on the first failing guard (non-zero exit, no continue).
//
//   This is NOT `check:full` (that one additionally runs the browser e2e suite
//   via test:e2e, which needs a server + browsers and is not part of the CI
//   check job). This script == the CI check job, runnable on a laptop.

const { spawnSync } = require('node:child_process');

// Mirrors the steps of the `check` job in .github/workflows/ci.yml, in order.
// Keep this aligned with that workflow — the drift-guard test enforces it.
const STEPS = [
  'typecheck',
  'lint',
  'test:unit',
  'check:smoke-list',
  'build',
  'check:admin-shell',
  'check:sw-cache-version',
  'check:production-shell',
  'check:route-ownership',
  'check:shell-contract',
  'check:legacy-quarantine',
  'check:backup-manifest',
  'check:role-literals',
  'check:flag-expiry',
  'check:read-flags-protected',
  'check:model-ids',
  'smoke:admin-routes',
];

const GRN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run() {
  const total = STEPS.length;
  for (let i = 0; i < total; i++) {
    const script = STEPS[i];
    const label = `[${i + 1}/${total}] npm run ${script}`;
    process.stdout.write(`${DIM}── ${label} ──${RST}\n`);
    const started = process.hrtime.bigint();
    const res = spawnSync(npm, ['run', script], { stdio: 'inherit' });
    const secs = Number(process.hrtime.bigint() - started) / 1e9;

    if (res.error) {
      process.stdout.write(
        `${RED}✗ ${label} could not start: ${res.error.message}${RST}\n`,
      );
      return 1;
    }
    if (res.status !== 0) {
      process.stdout.write(
        `\n${RED}✗ FAILED at step ${i + 1}/${total}: \`npm run ${script}\` ` +
          `(exit ${res.status}).${RST}\n` +
          `${DIM}  Fix this guard and re-run \`npm run check:full-ci\`. ` +
          `The CI check job runs the same set; this is what it will flag.${RST}\n`,
      );
      return res.status || 1;
    }
    process.stdout.write(`${GRN}✓ ${script}${RST} ${DIM}(${secs.toFixed(1)}s)${RST}\n\n`);
  }
  process.stdout.write(
    `${GRN}✓ all ${total} CI guards passed — this matches the CI check job.${RST}\n`,
  );
  return 0;
}

module.exports = { STEPS };

if (require.main === module) {
  process.exit(run());
}
