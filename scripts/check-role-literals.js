#!/usr/bin/env node
// CI guard (#156): no literal role-string comparisons in api/.
//
// Literal checks (`user.role === 'admin'`, `role !== 'tradie'`) recur as tier
// bugs: #114 (electricians invisible to missing-hours), #123 (office/boss saw
// blank hours boards). Every role check goes through the api/_lib/auth.js
// predicates (isAdminRole / isFieldRole / isLeadingHandRole / isStaffRole /
// isClientRole). src/ is enforced by ESLint (no-restricted-syntax) — this
// script covers api/, which .eslintrc.json ignores by design.
//
// Intentional literals carry a same-line or previous-line comment:
//   // role-literal-ok: <reason>

const fs = require('fs');
const path = require('path');

const PATTERN = /\.role\s*[!=]=+\s*['"][a-zA-Z_-]+['"]/;
const ALLOW = 'role-literal-ok:';
const failures = [];

function stripComments(line) {
  // good enough for this codebase: cut line comments; ignore block comments
  // by also treating lines starting with * or /* as prose.
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  const cut = line.indexOf('//');
  return cut === -1 ? line : line.slice(0, cut);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) check(full);
  }
}

function check(file) {
  const rel = path.relative(path.join(__dirname, '..'), file);
  if (rel === path.join('api', '_lib', 'auth.js')) return; // the definitions
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!PATTERN.test(stripComments(line))) return;
    const allowed = line.includes(ALLOW) || (i > 0 && lines[i - 1].includes(ALLOW));
    if (!allowed) failures.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
}

walk(path.join(__dirname, '..', 'api'));

if (failures.length) {
  console.error('✗ literal role comparisons found (use the api/_lib/auth.js predicates):\n');
  for (const f of failures) console.error('  ' + f);
  console.error('\nIf a literal is genuinely intentional, add `// role-literal-ok: <reason>` on or above the line.');
  process.exit(1);
}
console.log('✓ no unapproved literal role comparisons in api/');
