#!/usr/bin/env node
// CI guard (#378): no pinned-with-an-expiry Claude model ids in api/ or src/.
//
// Dated model ids carry retirement dates: the pinned claude-sonnet-4-20250514
// would have broken field tag-OCR on 2026-06-15, and claude-3-5-sonnet-latest
// belonged to a family retired 2025-10-28 (quote ai-review silently failing).
// Model ids live in env-configurable constants with a BARE current alias as
// the default (the PLANS_AI_MODEL pattern in api/plans.js).
//
// Flags, in .js/.ts files under api/, src/ and scripts/:
//   - dated ids:            claude-<anything>-YYYYMMDD
//   - retired 3.x family:   claude-3-...
//
// Intentional occurrences carry a same-line or previous-line comment:
//   // model-id-ok: <reason>

const fs = require('fs');
const path = require('path');

const PATTERNS = [
  { re: /claude-[a-z0-9.-]*-20\d{6}/, why: 'dated model id (has a retirement date)' },
  { re: /claude-3[-.]/, why: 'retired claude-3.x family' },
];
const ALLOW = 'model-id-ok:';
const ROOTS = ['api', 'src', 'scripts'];
const SELF = path.join('scripts', 'check-model-ids.js');
const failures = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(p);
    } else if (/\.(js|ts|tsx)$/.test(entry.name)) {
      if (p === SELF) continue; // the guard's own pattern table
      checkFile(p);
    }
  }
}

function checkFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { re, why } of PATTERNS) {
      if (!re.test(line)) continue;
      const prev = i > 0 ? lines[i - 1] : '';
      if (line.includes(ALLOW) || prev.includes(ALLOW)) continue;
      failures.push(`${file}:${i + 1} — ${why}\n    ${line.trim()}`);
    }
  });
}

for (const root of ROOTS) {
  if (fs.existsSync(root)) walk(root);
}

if (failures.length) {
  console.error('✗ pinned/retired Claude model ids found (use an env-configurable bare alias, see api/plans.js PLANS_AI_MODEL):\n');
  for (const f of failures) console.error('  ' + f);
  console.error(`\n  Intentional? Add a comment: // ${ALLOW} <reason>`);
  process.exit(1);
}
console.log('✓ no dated or retired Claude model ids in api/, src/, scripts/');
