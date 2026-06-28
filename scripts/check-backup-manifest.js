#!/usr/bin/env node
// CI guard (#151): every blob key api/ WRITES must be covered by the backup
// manifest, so a new store can't silently ship un-backed-up.
//
// Extraction is deliberately conservative:
//   writeBlob('literal.json' …)          → the literal key
//   writeBlob(`tmpl/${id}/doc.json` …)   → the static prefix before the first ${
//   writeBlob(IDENT …)                   → resolved from a same-file
//                                          `const IDENT = '…'` / `IDENT = \`…\``
// Anything unresolvable must be listed in KNOWN_DYNAMIC below with the prefix
// it actually writes — a human assertion the guard then checks like any other.

const fs = require('fs');
const path = require('path');
const { isCoveredKey, BACKUP_PREFIX } = require('../api/_lib/backup-manifest');

// file (relative to repo root) → write-key prefixes the guard can't extract.
const KNOWN_DYNAMIC = {
  'api/_lib/audit-log.js': ['audit/'], // keyFor(): audit/<yyyy-mm>.json
  'api/leave.js': ['leave-requests.json'], // KEY imported from _lib/leave.js
  'api/observations.js': ['jobs/'], // variations.storeKey(jobId): jobs/<id>/variations.json (cross-module call; covered by the jobs/ prefix)
  'api/safety-docs.js': ['jobs/'], // docsKey/acksKey(jobId): jobs/<id>/safety-docs.json + safety-acks.json (concat helpers; covered by the jobs/ prefix) (#219)
  'api/certificates.js': ['jobs/'], // certsKey(jobId): jobs/<id>/certificates.json (concat helper; covered by the jobs/ prefix) (#231)
  'api/rfis.js': ['jobs/'], // rfisKey(jobId): jobs/<id>/rfis.json (concat helper; covered by the jobs/ prefix) (#276)
  'api/job-doc-import.js': ['jobs/'], // create-job attaches jobs/<id>/cost-import.json (template key; covered by the jobs/ prefix) (#365)
};

// The backup system itself: blob.js DEFINES writeBlob, backup.js's restore
// writes only manifest-validated canonical paths. Scanning them is circular.
const EXCLUDED_FILES = new Set(['api/_lib/blob.js', 'api/_lib/backup.js']);

const apiDir = path.join(__dirname, '..', 'api');
const failures = [];
const covered = new Set();

function staticPrefix(tmpl) {
  const cut = tmpl.indexOf('${');
  return cut === -1 ? tmpl : tmpl.slice(0, cut);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) checkFile(full);
  }
}

function checkFile(file) {
  const rel = path.relative(path.join(__dirname, '..'), file);
  if (EXCLUDED_FILES.has(rel)) return;
  const src = fs.readFileSync(file, 'utf8');

  // ── Resolve same-file key builders ──────────────────────────────────
  // String/template constants:        const X = 'users.json' / `jobs/${id}/…`
  // Arrow key builders:               const F = (a) => `jobs/${a}/x.json`
  //                                   const F = (a) => 'quotes/' + a + '/x.json'
  // Function-declaration builders:    function f(a) { return `jobs/${a}/x.json` }
  // Object-of-arrow builders:         const KEYS = { a: q => 'quotes/'+q+'/x.json', … }
  const consts = new Map(); // ident → prefix
  const objectBuilders = new Map(); // ident → [prefixes]
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g)) {
    consts.set(m[1], m[2]);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`([^`]+)`/g)) {
    consts.set(m[1], staticPrefix(m[2]));
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*`([^`]+)`/g)) {
    consts.set(m[1], staticPrefix(m[2]));
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*'([^']+)'\s*\+/g)) {
    consts.set(m[1], m[2]);
  }
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[\s\S]{0,200}?return\s+`([^`]+)`/g)) {
    consts.set(m[1], staticPrefix(m[2]));
  }
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[\s\S]{0,200}?return\s+'([^']+)'\s*\+/g)) {
    consts.set(m[1], m[2]);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]*?)\n\}/g)) {
    const prefixes = [];
    for (const a of m[2].matchAll(/[A-Za-z_$][\w$]*\s*:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:'([^']+)'\s*\+|`([^`]+)`)/g)) {
      prefixes.push(a[1] !== undefined ? a[1] : staticPrefix(a[2]));
    }
    if (prefixes.length) objectBuilders.set(m[1], prefixes);
  }
  // Local alias of a builder call: const KEY = dataKey(jobId)
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\(/g)) {
    if (consts.has(m[2]) && !consts.has(m[1])) consts.set(m[1], consts.get(m[2]));
  }

  for (const m of src.matchAll(/writeBlob\(\s*('([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))/g)) {
    const keys = [];
    if (m[2] !== undefined) keys.push(m[2]);
    else if (m[3] !== undefined) keys.push(staticPrefix(m[3]));
    else if (m[4] !== undefined) {
      if (consts.has(m[4])) keys.push(consts.get(m[4]));
      else if (objectBuilders.has(m[4])) keys.push(...objectBuilders.get(m[4]));
      else if ((KNOWN_DYNAMIC[rel] || []).length) continue; // human-asserted below
      else {
        failures.push(`${rel}: writeBlob(${m[4]}) — unresolvable key; add the real prefix to KNOWN_DYNAMIC in ${path.basename(__filename)}`);
        continue;
      }
    }
    for (const key of keys) {
      if (!key || key.startsWith(BACKUP_PREFIX)) continue;
      if (!isCoveredKey(key)) {
        failures.push(`${rel}: writeBlob key "${key}" is not covered by api/_lib/backup-manifest.js`);
      } else {
        covered.add(key);
      }
    }
  }
}

walk(apiDir);

// The human-asserted dynamic prefixes are checked too.
for (const [file, prefixes] of Object.entries(KNOWN_DYNAMIC)) {
  for (const p of prefixes) {
    if (!isCoveredKey(p)) failures.push(`${file}: KNOWN_DYNAMIC prefix "${p}" is not covered by the manifest`);
    else covered.add(p);
  }
}

if (failures.length) {
  console.error('✗ backup-manifest guard failed:\n');
  for (const f of failures) console.error('  ' + f);
  console.error('\nEvery store the app writes must be in api/_lib/backup-manifest.js (or it never gets backed up).');
  process.exit(1);
}
console.log(`✓ backup manifest covers every written store (${covered.size} distinct keys/prefixes checked)`);
