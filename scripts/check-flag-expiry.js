#!/usr/bin/env node
// CI guard (#155): feature flags are temporary. Once a flag's declared
// expiry passes, the build fails until it's cleaned up (delete the flag and
// its dead branch) or consciously extended in the registry.
const { expiredFlags } = require('../api/_lib/feature-flags');

const expired = expiredFlags();
if (expired.length) {
  console.error('✗ expired feature flags — clean up or consciously extend:\n');
  for (const f of expired) {
    console.error(`  ${f.key} (expired ${f.expires}) — ${f.description}`);
  }
  process.exit(1);
}
console.log('✓ no expired feature flags');
