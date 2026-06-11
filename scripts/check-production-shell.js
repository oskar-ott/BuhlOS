#!/usr/bin/env node
// Static check: the production routing surface is the modern app — no
// prototype, no legacy shell, no root rewrite into static HTML.
//
// Why: on 2026-05-20 a prototype branch was deployed to buhlos.com via
// `vercel deploy --prod`, replacing the real build with the legacy
// "Birdwood IV3232" horizontal-tab page. Later, stale rewrites and a
// caching service worker kept resurrecting old layouts after deploys.
// The legacy-interface cutover removed the static estate entirely; this
// script asserts the deployable tree keeps that shape.
//
// Rules (post-cutover):
//   1. NO deployable file may contain "Birdwood IV3232" (the prototype
//      marker that once replaced production).
//   2. vercel.json must NOT rewrite or redirect `/` anywhere — the root
//      is owned by src/app/page.tsx (session → landing, else /v2/login).
//   3. vercel.json must redirect /admin/operations AND /admin to
//      /command-centre, and /login to /v2/login (the highest-traffic
//      legacy entries must land on the modern shell).
//   4. The modern shells must exist: src/components/admin/AdminShell.tsx
//      (data-testid="buhlos-admin-shell") and src/components/phil/
//      PhilShell.tsx (data-testid="phil-shell").
//
// Run standalone:  node scripts/check-production-shell.js
// Run via npm:     npm run check:production-shell
// Auto-runs on:    npm run predeploy / predeploy:preview + CI

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const RST = '\x1b[0m';

const failures = [];
function fail(msg, detail) { failures.push({ msg, detail: detail || '' }); }
function read(rel) { return fs.readFileSync(path.join(REPO, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(REPO, rel)); }

// ── 1. Prototype marker ban in directly-served files ──────────────────
// "Birdwood IV3232" is ALSO the real job's name, so it legitimately appears
// in data/fixtures/tests. The prototype regression vector is a directly
// served static page — scan public/ only.
function walk(dirRel) {
  const out = [];
  if (!exists(dirRel)) return out;
  for (const entry of fs.readdirSync(path.join(REPO, dirRel), { withFileTypes: true })) {
    const rel = dirRel + '/' + entry.name;
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}
for (const rel of walk('public')) {
  if (/\.(png|svg|ico|jpg|jpeg|webp|woff2?)$/i.test(rel)) continue;
  if (/Birdwood IV3232/.test(read(rel))) {
    fail(rel + ' contains the legacy prototype marker "Birdwood IV3232"',
      'That prototype must never ship again as a static page.');
  }
}

// ── 2 + 3. vercel.json routing shape ──────────────────────────────────
if (!exists('vercel.json')) {
  fail('vercel.json missing');
} else {
  let cfg = null;
  try { cfg = JSON.parse(read('vercel.json')); }
  catch (e) { fail('vercel.json is not valid JSON', String(e && e.message)); }
  if (cfg) {
    for (const r of cfg.rewrites || []) {
      if (r.source === '/' || r.source === '/(.*)') {
        fail('vercel.json rewrites `/` → ' + r.destination,
          'The root belongs to src/app/page.tsx (session-aware landing). ' +
          'Rewriting `/` into static HTML is the legacy-login regression.');
      }
    }
    for (const r of cfg.redirects || []) {
      if (r.source === '/') {
        fail('vercel.json redirects `/` → ' + r.destination,
          'The root belongs to src/app/page.tsx; do not redirect it at the edge.');
      }
    }
    const redirect = new Map((cfg.redirects || []).map((r) => [r.source, r.destination]));
    const mustRedirect = [
      ['/admin/operations', '/command-centre'],
      ['/admin', '/command-centre'],
      ['/login', '/v2/login'],
    ];
    for (const [src, dest] of mustRedirect) {
      if (redirect.get(src) !== dest) {
        fail('vercel.json must redirect ' + src + ' → ' + dest +
          ' (got ' + (redirect.get(src) || 'nothing') + ')',
          'Admins and crews still hold these URLs (bookmarks, installed PWAs, ' +
          'muscle memory) — they must land on the modern shell.');
      }
    }
  }
}

// ── 4. Modern shells exist with their markers ─────────────────────────
const SHELLS = [
  { rel: 'src/components/admin/AdminShell.tsx', marker: 'buhlos-admin-shell' },
  { rel: 'src/components/phil/PhilShell.tsx', marker: 'phil-shell' },
];
for (const s of SHELLS) {
  if (!exists(s.rel)) {
    fail(s.rel + ' missing', 'The modern shell component must exist.');
  } else if (!read(s.rel).includes(s.marker)) {
    fail(s.rel + ' lost its data-testid marker "' + s.marker + '"',
      'Smokes and shell checks key off this marker.');
  }
}

// ── Execute ──────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) {
    console.log(RED + 'FAIL ' + RST + f.msg);
    if (f.detail) console.log('     ' + YEL + f.detail + RST);
  }
  console.log('');
  console.log(RED + 'Production shell contract violated.' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'production routing is modern-only (root owned by Next, legacy entries redirect, shells intact).');
process.exit(0);
