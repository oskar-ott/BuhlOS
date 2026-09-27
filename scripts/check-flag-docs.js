#!/usr/bin/env node
'use strict';

// CI guard: the feature-flag registry, its typed declarations and its
// documentation cannot drift apart.
//
// WHY THIS EXISTS
//   docs/feature-flags.md is the governing doc for flag governance; the Owner
//   Console, the audit trail and every "is X on?" conversation lean on it. In
//   2026-09 it was found to be missing two registry flags (receipt_capture,
//   supabase_source_hours): the registry had grown, the doc had not, and
//   nothing failed. Repository contents are the only part of "production
//   truth" a CI job can check, so at least that part must be exact.
//
// WHAT IT CHECKS (deterministic; no network, no env, no secrets)
//   1. REGISTRY keys (api/_lib/feature-flags.js) == the `FlagKey` union
//      (api/_lib/feature-flags.d.ts), both directions.
//   2. Every REGISTRY key has a row in the flag table of docs/feature-flags.md
//      (section "## The registry")                                → missing
//   3. Every row in that table names a REGISTRY key                → obsolete
//   4. A row's Kind / Target / Expires cells equal the registry's  → mismatched
//
// WHAT IT DOES NOT DO
//   It never reads env vars, flags.json or any runtime state. Those decide the
//   *effective* state of a flag in a deployment, and the repository cannot
//   prove them — see docs/feature-flags.md, "What a flag proves".

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PATHS = {
  registry: path.join(ROOT, 'api/_lib/feature-flags.js'),
  dts: path.join(ROOT, 'api/_lib/feature-flags.d.ts'),
  doc: path.join(ROOT, 'docs/feature-flags.md'),
};

const DOC_SECTION_HEADING = '## The registry';

/**
 * The `FlagKey` string-literal union in feature-flags.d.ts, in declaration
 * order. Line comments inside the union are dropped first so a quoted word in
 * a comment can never count as a key.
 * @param {string} dtsText
 * @returns {string[]}
 */
function parseFlagKeyUnion(dtsText) {
  const start = dtsText.indexOf('export type FlagKey =');
  if (start === -1) throw new Error('feature-flags.d.ts: `export type FlagKey =` not found');
  // Strip line comments BEFORE looking for the terminating `;` — a comment
  // such as `// daily sync; needs SERVERM8_API_KEY` would otherwise end the
  // union early and every later key would be reported as missing.
  const stripped = dtsText
    .slice(start)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const end = stripped.indexOf(';');
  if (end === -1) throw new Error('feature-flags.d.ts: the FlagKey union is not terminated with `;`');
  const body = stripped.slice(0, end);
  const keys = [];
  const re = /"([a-z0-9_]+)"/g;
  let m;
  while ((m = re.exec(body)) !== null) keys.push(m[1]);
  return keys;
}

/**
 * Rows of the flag table in docs/feature-flags.md — only inside the
 * "## The registry" section, so tables elsewhere in the doc are never read as
 * flags. Row shape: `| \`key\` | Kind | Target | Expires | What it gates |`.
 * Only the first three cells after the key are checked; the description may
 * contain anything, including `|`.
 * @param {string} mdText
 * @returns {Array<{ key: string, kind: string, target: string, expires: string, line: number }>}
 */
function parseDocRows(mdText) {
  const lines = mdText.split(/\r?\n/);
  const rows = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      inSection = line.trim() === DOC_SECTION_HEADING;
      continue;
    }
    if (!inSection) continue;
    const m = /^\|\s*`([a-z0-9_]+)`\s*\|(.*)$/.exec(line);
    if (!m) continue;
    const cells = m[2].split('|').map((c) => c.trim());
    rows.push({
      key: m[1],
      kind: cells[0] || '',
      target: cells[1] || '',
      expires: cells[2] || '',
      line: i + 1,
    });
  }
  return rows;
}

/**
 * Pure comparison. Returns one problem per disagreement; empty means the
 * three sources agree.
 * @param {{ registry: Record<string, { target: string, expires: string, killSwitch?: boolean }>,
 *           unionKeys: string[],
 *           rows: ReturnType<typeof parseDocRows> }} input
 * @returns {Array<{ code: string, key: string, detail: string }>}
 */
function compare({ registry, unionKeys, rows }) {
  const problems = [];
  const regKeys = Object.keys(registry);
  const regSet = new Set(regKeys);
  const unionSet = new Set(unionKeys);

  for (const k of regKeys) {
    if (!unionSet.has(k)) problems.push({ code: 'union_missing', key: k, detail: 'in REGISTRY, not in the FlagKey union (api/_lib/feature-flags.d.ts)' });
  }
  for (const k of unionKeys) {
    if (!regSet.has(k)) problems.push({ code: 'union_extra', key: k, detail: 'in the FlagKey union, not in REGISTRY (api/_lib/feature-flags.js)' });
  }

  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.key)) {
      problems.push({ code: 'doc_duplicate_row', key: r.key, detail: `documented twice (lines ${seen.get(r.key)} and ${r.line})` });
      continue;
    }
    seen.set(r.key, r.line);
    const def = registry[r.key];
    if (!def) {
      problems.push({ code: 'doc_obsolete', key: r.key, detail: `documented at docs/feature-flags.md:${r.line}, not in REGISTRY` });
      continue;
    }
    const kind = def.killSwitch ? 'kill-switch' : 'launch-gate';
    if (r.kind !== kind) problems.push({ code: 'doc_kind_mismatch', key: r.key, detail: `doc says "${r.kind}", registry says "${kind}" (docs/feature-flags.md:${r.line})` });
    if (r.target !== def.target) problems.push({ code: 'doc_target_mismatch', key: r.key, detail: `doc says "${r.target}", registry says "${def.target}" (docs/feature-flags.md:${r.line})` });
    if (r.expires !== def.expires) problems.push({ code: 'doc_expires_mismatch', key: r.key, detail: `doc says "${r.expires}", registry says "${def.expires}" (docs/feature-flags.md:${r.line})` });
  }
  for (const k of regKeys) {
    if (!seen.has(k)) problems.push({ code: 'doc_missing', key: k, detail: `in REGISTRY, no row in the docs/feature-flags.md flag table (section "${DOC_SECTION_HEADING}")` });
  }
  return problems;
}

function main() {
  const { REGISTRY } = require(PATHS.registry);
  const unionKeys = parseFlagKeyUnion(fs.readFileSync(PATHS.dts, 'utf8'));
  const rows = parseDocRows(fs.readFileSync(PATHS.doc, 'utf8'));
  const problems = compare({ registry: REGISTRY, unionKeys, rows });
  if (problems.length) {
    console.error('✗ feature-flag registry, typed declarations and docs disagree:\n');
    for (const p of problems) console.error(`  ${p.key}: ${p.code} — ${p.detail}`);
    console.error(
      '\n  Fix all three in the same PR: api/_lib/feature-flags.js (REGISTRY), ' +
        'api/_lib/feature-flags.d.ts (FlagKey), docs/feature-flags.md (the flag table — ' +
        'Kind, Target and Expires must match the registry).',
    );
    return 1;
  }
  console.log(`✓ flag registry, typed declarations and docs agree (${Object.keys(REGISTRY).length} flags)`);
  return 0;
}

module.exports = { parseFlagKeyUnion, parseDocRows, compare, PATHS, DOC_SECTION_HEADING };

if (require.main === module) {
  process.exit(main());
}
