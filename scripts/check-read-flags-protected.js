#!/usr/bin/env node
// CI guard (RLS-03, #152): the Supabase READ-cutover flags must stay dark and
// protected before an operator deliberately, gate-by-gate, enables them.
//
// A `supabase_read_*` flag serves PG-backed reads over data that may be
// un-backfilled or RLS-denied. Enabling one prematurely (a stray registry edit,
// a fat-fingered owner toggle) would serve wrong/empty reads. Two things keep it
// safe and this guard machine-checks BOTH:
//   1. DEFAULT DARK — every supabase_read_* flag defaults false (dark-by-default;
//      env/flags.json is the only way on, deliberately, per-environment — see
//      docs/architecture/supabase-read-enablement-runbook.md). killSwitch is
//      forbidden here (that would default it ON).
//   2. PROTECTED — isProtectedFlag(key) is true, so the owner console renders it
//      read-only and the owner write route rejects toggling it (api/owner.js).
//      Protection is expressed by isProtectedFlag (the SAME marker the owner
//      data-plane flags use), NOT a new registry field.
//
// Wired into the CI check job + scripts/check-full-ci.js exactly like the other
// check:* guards. Rollout procedure (how these get turned on for real):
// docs/architecture/supabase-read-enablement-runbook.md.
const { listFlags, isProtectedFlag } = require('../api/_lib/feature-flags');

const READ_PREFIX = 'supabase_read_';
const readFlags = listFlags().filter((f) => f.key.startsWith(READ_PREFIX));
const failures = [];

// Sanity: the guard must actually be checking flags (a rename of the prefix
// must not silently make this a no-op).
if (readFlags.length === 0) {
  failures.push(
    `no ${READ_PREFIX}* flags found in the registry — the read-cutover flags were ` +
      `renamed or removed; update READ_PREFIX in ${require('path').basename(__filename)}`,
  );
}

for (const f of readFlags) {
  if (f.default !== false) {
    failures.push(`${f.key}: default is ${f.default} — read-cutover flags must default DARK (false)`);
  }
  if (f.killSwitch) {
    failures.push(`${f.key}: killSwitch:true would default it ON — read-cutover flags are launch-gates, never kill-switches`);
  }
  if (!isProtectedFlag(f.key)) {
    failures.push(`${f.key}: not protected — isProtectedFlag must be true so the owner UI can't toggle it (api/owner.js)`);
  }
}

if (failures.length) {
  console.error('✗ supabase read-cutover flag guard failed (RLS-03):\n');
  for (const msg of failures) console.error('  ' + msg);
  console.error(
    '\nRead-cutover flags stay dark + protected until an operator enables them ' +
      'per docs/architecture/supabase-read-enablement-runbook.md.',
  );
  process.exit(1);
}
console.log(`✓ all ${readFlags.length} supabase_read_* flags are dark by default and protected`);
