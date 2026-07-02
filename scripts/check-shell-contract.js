#!/usr/bin/env node
// Static guard: every modern route renders its INTENDED shell — and never the
// other surface's shell.
//
// Why: the new BuhlOS admin and Phil surfaces apply their shell chrome
// PER-PAGE (each page.tsx wraps its body in <AdminShell> or <PhilShell>, or
// delegates to a co-located screen component that does). The route-group
// layouts (src/app/(admin)/layout.tsx, src/app/phil/layout.tsx) are deliberate
// pass-throughs. That convention is flexible but unguarded: a new admin page
// can forget <AdminShell> and render a chromeless blank, or a Phil page can
// import the wrong shell and show a tradie the desktop admin sidebar. Both have
// a history on the legacy surface (docs/regressions/admin-operations-blank.md);
// this freezes the modern-surface equivalent.
//
// What it asserts (all static, no network, no build):
//   A. Cross-shell prohibition — no file under an admin route subtree imports
//      the Phil shell, and no file under a Phil route subtree imports the admin
//      shell. (A BuhlOS route can never render the Phil shell, and vice versa.)
//   B. Shell presence — every page.tsx under a route subtree reaches its own
//      surface's shell (in the page or a co-located component it imports),
//      unless it is on the explicit "renders no surface shell" allowlist
//      (sign-in, public invite, full-screen onboarding). No silent blanks.
//   C. Marker stability — the shell components still exist and still carry the
//      data-testid markers (buhlos-admin-shell / phil-shell) and nav chrome the
//      Playwright auth-routing smoke and this contract rely on.
//
// Contract: docs/route-ownership.md §2 (surfaces), §4–§8 (per-route shell), §9
// (navigation). When a route intentionally changes surface, update the DOMAINS
// / SHELL_EXEMPT below AND docs/route-ownership.md in the same PR.
//
// Run standalone:  node scripts/check-shell-contract.js
// Run via npm:     npm run check:shell-contract
// Auto-runs on:    npm run predeploy / predeploy:preview

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

const failures = [];
function fail(msg, detail) { failures.push({ msg, detail: detail || '' }); }
function exists(rel) { return fs.existsSync(path.join(REPO, rel)); }
function read(rel) { return fs.readFileSync(path.join(REPO, rel), 'utf8'); }

// ── Contract: route subtree → intended surface shell ─────────────────
const DOMAINS = [
  { name: 'BuhlOS admin', shell: 'admin', roots: ['src/app/(admin)', 'src/app/v2/jobs', 'src/app/v2/quotes'] },
  { name: 'Phil', shell: 'phil', roots: ['src/app/phil', 'src/app/v2/phil'] },
];
const OTHER = { admin: 'phil', phil: 'admin' };
const SHELL_LABEL = { admin: 'AdminShell', phil: 'PhilShell' };

// A file "imports" a shell if it pulls in the canonical component module. Used
// for the precise cross-shell prohibition (Check A).
const SHELL_IMPORT = {
  admin: /@\/components\/admin\/AdminShell/,
  phil: /@\/components\/phil\/PhilShell/,
};
// A file "renders" a shell only if the JSX tag is present. The positive
// presence check must not treat an import as enough: an import-only page can
// still return chromeless content.
const SHELL_RENDER = {
  admin: /<AdminShell[\s/>]/,
  phil: /<PhilShell[\s/>]/,
};

// Pages that intentionally render NO surface shell (bespoke full-screen / public
// chrome). They are STILL subject to the cross-shell prohibition by location.
// Keep this list tight and reasoned — it is the only escape hatch from Check B.
const SHELL_EXEMPT = new Map([
  ['src/app/v2/login/page.tsx', 'bespoke sign-in surface — route-ownership §4 (shell: none)'],
  ['src/app/phil/invite/[token]/page.tsx', 'public worker invite, own chrome — route-ownership §5'],
  ['src/app/phil/onboarding/page.tsx', 'full-screen onboarding tour with its own layout'],
  // #286: the compliance pack is a PRINT DOCUMENT (browser print → Save as
  // PDF → sent to the builder) — admin chrome would print onto an external
  // deliverable. Session-gated like the rest of /v2; no shell by design.
  ['src/app/v2/jobs/[jobId]/itps/pack/page.tsx', 'printable compliance pack — print document, deliberately chromeless (route-ownership §8.1)'],
  // #372: a progress claim print view is a PRINT DOCUMENT sent to the builder
  // (browser print → Save as PDF → keyed into Payapps) — admin chrome would
  // print onto an external deliverable. Session-gated like the rest of /v2.
  ['src/app/v2/jobs/[jobId]/claims/[claimId]/print/page.tsx', 'printable progress claim — print document, deliberately chromeless (route-ownership §8.1)'],
]);

// ── helpers ──────────────────────────────────────────────────────────
function walk(absDir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(abs);
  }
  return out;
}

function rel(abs) { return path.relative(REPO, abs); }

// Resolve a relative import ('./x', '../x') to a real source file, if any.
function resolveRelative(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  const candidates = [
    base + '.tsx', base + '.ts',
    path.join(base, 'index.tsx'), path.join(base, 'index.ts'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// The transitive closure of a page's co-located source: the page plus every
// file it reaches through RELATIVE imports (co-located screen/client
// components like ./EmployeesScreen). Shells are imported via "@/components/…",
// which is detected by string match — we never need to open the shell module
// itself, so following relative imports is enough to see a delegated shell.
const RELATIVE_FROM = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g;
function colocatedClosure(pageAbs) {
  const visited = new Set();
  const queue = [pageAbs];
  const files = [];
  while (queue.length) {
    const f = queue.shift();
    if (visited.has(f)) continue;
    visited.add(f);
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    files.push({ abs: f, src });
    RELATIVE_FROM.lastIndex = 0;
    let m;
    while ((m = RELATIVE_FROM.exec(src))) {
      const resolved = resolveRelative(f, m[1]);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return files;
}

// ── A. Cross-shell prohibition ───────────────────────────────────────
for (const domain of DOMAINS) {
  const otherShell = OTHER[domain.shell];
  for (const root of domain.roots) {
    if (!exists(root)) {
      fail('shell domain root missing: ' + root,
        'docs/route-ownership.md maps ' + root + ' to the ' + domain.name +
        ' shell. If the surface moved, update DOMAINS and the contract together.');
      continue;
    }
    for (const abs of walk(path.join(REPO, root))) {
      const src = fs.readFileSync(abs, 'utf8');
      if (SHELL_IMPORT[otherShell].test(src)) {
        fail(domain.name + ' route imports the wrong shell: ' + rel(abs),
          'A ' + domain.name + ' route must never import ' + SHELL_LABEL[otherShell] +
          '. This is exactly the "wrong UI in the wrong place" failure the route ' +
          'ownership contract exists to prevent. See docs/route-ownership.md §2.');
      }
    }
  }
}

// ── B. Shell presence (no silent blanks) ─────────────────────────────
for (const domain of DOMAINS) {
  for (const root of domain.roots) {
    if (!exists(root)) continue; // already reported in A
    const pages = walk(path.join(REPO, root)).filter((f) => path.basename(f) === 'page.tsx');
    for (const pageAbs of pages) {
      const pageRel = rel(pageAbs);
      if (SHELL_EXEMPT.has(pageRel)) continue;
      const closure = colocatedClosure(pageAbs);
      const renders = closure.some(({ src }) => SHELL_RENDER[domain.shell].test(src));
      if (!renders) {
        fail(domain.name + ' route renders no ' + SHELL_LABEL[domain.shell] + ': ' + pageRel,
          'This page (and the co-located components it imports) never reaches ' +
          SHELL_LABEL[domain.shell] + ' — it would render without the ' + domain.name +
          ' shell (blank / chromeless). Wrap the page body in <' + SHELL_LABEL[domain.shell] +
          '> or delegate to a co-located screen that does. If this page intentionally ' +
          'renders no surface shell, add it to SHELL_EXEMPT with a reason and document ' +
          'it in docs/route-ownership.md.');
      }
    }
  }
}

// ── C. Marker stability ──────────────────────────────────────────────
// The shell components must keep the markers the Playwright smoke + this
// contract depend on. A silent rename would make the runtime smoke assert a
// marker that no longer exists.
const SHELL_COMPONENTS = [
  {
    file: 'src/components/admin/AdminShell.tsx',
    testid: 'buhlos-admin-shell',
    chrome: [/AdminSidebar/, /AdminTopbar/],
    chromeLabel: 'AdminSidebar + AdminTopbar',
  },
  {
    file: 'src/components/phil/PhilShell.tsx',
    testid: 'phil-shell',
    chrome: [/PhilHeader/, /PhilTabBar/],
    chromeLabel: 'PhilHeader + PhilTabBar',
  },
];
for (const c of SHELL_COMPONENTS) {
  if (!exists(c.file)) {
    fail('shell component missing: ' + c.file,
      'The per-page shell contract depends on this component existing.');
    continue;
  }
  const src = read(c.file);
  if (!new RegExp('data-testid=["\']' + c.testid + '["\']').test(src)) {
    fail(c.file + ' is missing its data-testid="' + c.testid + '" marker',
      'tests/playwright/smoke/auth-routing.spec.ts and check-shell-contract.js ' +
      'both assert this marker. Renaming it silently breaks the shell smoke.');
  }
  for (const re of c.chrome) {
    if (!re.test(src)) {
      fail(c.file + ' no longer composes its nav chrome (' + c.chromeLabel + ')',
        'The shell must render its navigation chrome so routes do not lose their nav.');
    }
  }
}

// ── Execute ──────────────────────────────────────────────────────────
console.log(DIM + 'check-shell-contract · ' + failures.length + ' issue' +
  (failures.length === 1 ? '' : 's') + RST);
console.log('');

if (failures.length) {
  for (const f of failures) {
    console.log(RED + 'FAIL ' + RST + f.msg);
    if (f.detail) console.log('     ' + YEL + f.detail + RST);
  }
  console.log('');
  console.log(RED + 'Shell contract violated.' + RST);
  console.log(DIM + 'See docs/route-ownership.md §2 (surfaces) and §8 (per-route shell).' + RST);
  process.exit(1);
}

console.log(GRN + 'OK   ' + RST + 'every modern route renders its intended shell; no cross-shell imports.');
process.exit(0);
