# 08 · Next Claude Code prompt

The prompt to give Claude Code **after this audit lands**. It instructs Claude Code to start the **clean foundation rebuild** (Phase A only — not the whole product), reading from the audit docs to guide every decision.

Copy the block below verbatim when starting the rebuild session.

---

```text
This is Phase A of the BuhlOS / Phil rebuild.

The Phase 1 audit is complete and lives in:
  docs/rebuild-audit/         00 to 09
  docs/architecture/          00 + 01
  docs/product/               00 + 01

Before you do anything else, read these in order:

  1. docs/rebuild-audit/00-executive-summary.md
  2. docs/architecture/00-rebuild-non-negotiables.md   ← every rule here is binding
  3. docs/architecture/01-target-rebuild-structure.md  ← the folder layout you must follow
  4. docs/product/01-mvp-rebuild-scope.md              ← Phase A scope only; do NOT build B-D
  5. docs/rebuild-audit/07-salvage-map.md              ← what to keep, rebuild, discard
  6. docs/rebuild-audit/06-deployment-audit.md         ← deploy policy you must enforce

Your job in this session is Phase A only — the clean app shell. Nothing more.

────────────────────────────────────────────────────────
Branch strategy
────────────────────────────────────────────────────────

You have authority to:
  - Create a new local branch named: phase-a-app-shell
  - Branch FROM main (after git fetch). Do NOT branch from phase-1-rebuild-audit.
  - The phase-1-rebuild-audit branch is the audit branch and must be merged via PR first
    by the user. If main does not yet contain the audit docs, ask before proceeding.

You must NOT:
  - Push the branch yet
  - Open a PR yet
  - Deploy
  - Run vercel deploy --prod (it is being removed from package.json this phase)
  - Delete any existing file in public/ or api/
  - Touch the legacy admin surfaces
  - Modify api/_lib/auth.js or api/_lib/blob.js or api/_lib/validation.js
  - Rewrite api/*.js endpoints

────────────────────────────────────────────────────────
What to build (Phase A scope — copied from docs/product/01-mvp-rebuild-scope.md §"Phase A")
────────────────────────────────────────────────────────

A. Toolchain
   - Add dependencies to package.json:
       next ^15, react ^19, react-dom ^19, typescript ^5
       tailwindcss ^3, @tanstack/react-query, react-hook-form, zod,
       lucide-react, date-fns, clsx, tailwind-merge
   - Dev deps:
       @types/react, @types/react-dom, @types/node,
       eslint, eslint-config-next, @typescript-eslint/parser,
       @typescript-eslint/eslint-plugin, vitest, @vitest/ui,
       @playwright/test, prettier
   - tsconfig.json: strict, noUncheckedIndexedAccess, noImplicitOverride, paths: { "@/*": ["./src/*"] }
   - tailwind.config.ts: brand tokens from theme.css mapped:
       --accent-yellow: #ffcc00
       --brand-navy:    #0d1f35
       --accent-ink:    #0f172a
       Density tokens: compact / regular / roomy
   - postcss.config.cjs for Tailwind v3
   - next.config.ts: experimental.typedRoutes on, image domains for vercel-storage,
     rewrites for legacy fallback (/legacy/* → /*.html where needed; see below)
   - .eslintrc.json (next/core-web-vitals + custom rules forbidding alert/confirm/inline-style)

B. src/ scaffolding (folders mirror docs/architecture/01-target-rebuild-structure.md)
   Create EVERY file listed in that doc's Phase A scope. Empty placeholders are fine
   where the doc says "minimal".

C. Routes (must render)
   - src/app/layout.tsx       — Inter + Inter Tight, DemoModeBanner, error boundary
   - src/app/page.tsx         — Server component; getCurrentUser() → landingFor(role) redirect
   - src/app/login/page.tsx   — composes LoginForm; reads existing /api/auth?action=me to detect logged-in users
   - src/app/login/login-form.tsx  — client component; POSTs to /api/auth?action=login;
                                     uses the SAME landingFor() function as middleware
   - src/middleware.ts        — verifies session cookie via lib/auth/session.ts;
                                redirects unauthenticated → /login, wrong-role → role landing
   - src/app/(admin)/layout.tsx              — AdminShell wrapper
   - src/app/(admin)/command-centre/page.tsx — "Welcome to BuhlOS Admin. Hours loop coming next."
   - src/app/(phil)/layout.tsx               — PhilShell wrapper
   - src/app/(phil)/phil/page.tsx            — placeholder + DemoModeBanner if fixtures loaded

D. Library code (src/lib)
   - lib/env.ts        — Zod schema for SESSION_SECRET (≥16 chars), BLOB_READ_WRITE_TOKEN, optional VAPID_*
   - lib/auth/session.ts        — typed wrapper that calls the existing api/_lib/auth.js HMAC logic
                                  by invoking /api/auth?action=me OR (if direct import works in middleware)
                                  reading the cookie and verifying inline. Prefer the API call route
                                  for now to avoid duplicating HMAC code.
   - lib/auth/landing.ts        — landingFor(role) — the ONE canonical implementation
   - lib/auth/roles.ts          — type Role + ADMIN_ROLES / FIELD_ROLES / etc. arrays
                                  (lift the values from public/admin/operations.html lines 1541-1545
                                   and public/login.html landingFor)
   - lib/http.ts                — typed fetch wrapper
   - lib/cn.ts                  — tailwind-merge + clsx helper

E. Shared components (src/components/ui)
   - Button.tsx, Card.tsx, Pill.tsx, StatusBadge.tsx, EmptyState.tsx
   - UnderConstructionPanel.tsx — black/yellow tape pattern background, feature name, optional legacy link
   - DemoModeBanner.tsx          — top-of-page banner when fixtures.isDemoMode() is true
   - Modal.tsx (basic)

F. Admin shell (src/components/admin)
   - AdminShell.tsx     — flex layout, sidebar + topbar + page
   - AdminSidebar.tsx   — brand block "BuhlOS / Command Centre", nav items, sign-out at bottom
                          For Phase A: nav shows ONLY "Command centre" (live) + 5 UNDER CONSTRUCTION items
                          (Approvals, Snags, Support, Jobs, Settings)
   - AdminTopbar.tsx    — page title + breadcrumb + (placeholder) user pill

G. Phil shell (src/components/phil)
   - PhilShell.tsx       — full-height flex with content area + bottom tab bar
   - PhilTabBar.tsx      — 5 tabs: Today (live), Jobs (UC), Gear (UC), Snag (UC), More (live)
   - PhilHeader.tsx      — minimal header

H. Tests
   - vitest.config.ts
   - playwright.config.ts (chromium only for Phase A; mobile chrome for Phil specs later)
   - tests/phase-a.spec.ts — three flows:
       1. Unauthenticated GET / → 307 to /login
       2. Admin login (use a known test admin OR mock the /api/auth response if no test data) → /command-centre placeholder visible
       3. Tradie login → /phil placeholder visible

I. Legacy compatibility
   - Existing public/*.html files MUST continue to work via Vercel static serving.
   - vercel.json: KEEP all existing rewrites. They serve legacy. DO NOT delete any rewrite this phase.
   - Manifest start_url stays /my-day for Phase A (changes to /phil/my-day in Phase B).
   - The new Next.js app is ADDITIVE — it occupies routes that don't conflict with existing rewrites.
   - There is NO rewrite for "/command-centre" or "/phil/my-day" in vercel.json yet — Next.js owns them natively.
   - For "/" — Next.js src/app/page.tsx wins because Next.js routing runs after vercel.json
     rewrites only if the rewrite source path doesn't exist as a Next.js route. To be safe:
     keep the vercel.json rewrite `/ → /login.html` for now. Next.js's src/app/page.tsx
     will only fire if you delete that rewrite. Do NOT delete it in Phase A.
   - For "/login" — same logic. The vercel.json rewrite serves login.html.
     Add the new src/app/login/page.tsx but DO NOT route /login to it yet — instead,
     mount the new login at /login2 (or /v2/login) for Phase A so we can test in parallel.
     The phase-A exit criteria explicitly verify BOTH paths work.
   - For "/command-centre" and "/phil" — these are new routes that don't exist in vercel.json,
     so Next.js owns them naturally.

J. package.json scripts
   - Add: "dev": "next dev", "build": "next build", "lint": "next lint",
          "typecheck": "tsc --noEmit", "test": "vitest run",
          "test:e2e": "playwright test"
   - REMOVE: "deploy:prod" entirely. It is no longer supported.
   - REMOVE: "predeploy:prod". (Keep predeploy and predeploy:preview if useful.)
   - REMOVE: "deploy:prod" from package.json scripts entirely.
   - Keep: "check:admin-shell", "check:sw-cache-version", "check:production-shell",
           "smoke:admin-routes" — they still guard the legacy surface during transition.

K. CI
   - .github/workflows/pr.yml — runs typecheck + lint + test + build on every PR.
   - .github/workflows/main.yml — runs same on push to main (Vercel will redeploy after).

L. Documentation
   - Update README.md (or create one) with:
     * "Phase A app shell — see docs/product/01-mvp-rebuild-scope.md"
     * Quickstart: npm install, npm run dev
     * Where the legacy app lives (public/ + api/) and that it's still authoritative for most features
   - Do NOT update OVERVIEW.md (it's the legacy reference; rebuild has its own docs).

────────────────────────────────────────────────────────
Files to AVOID touching this phase
────────────────────────────────────────────────────────

  - All public/*.html files (admin.html, project.html, phil.html, my-day.html, etc.)
  - All public/admin/*.html files
  - All public/components/*.js files
  - All public/css/*.css files
  - public/theme.css
  - public/sw.js
  - public/manifest.json
  - api/*.js (all endpoints)
  - api/_lib/* (especially auth.js, blob.js, validation.js)
  - scripts/check-*.js and smoke-admin-routes.js
  - migrate-*.js, recover-*.js, seed-*.js, unify-*.js at repo root
  - vercel.json (except as noted above for new routes if absolutely required;
    prefer Next.js-native routes that don't collide with existing rewrites)

If you find yourself wanting to touch any of these to make Phase A work, STOP and ask.

────────────────────────────────────────────────────────
Migration from audit findings (specific items)
────────────────────────────────────────────────────────

The audit identified these issues. Phase A addresses some, defers others:

  ADDRESSED IN PHASE A:
   - landingFor() drift — Phase A creates the one canonical lib/auth/landing.ts
   - Deprecated localStorage key — Phase A introduces "buhlos.*" namespace;
     a one-time boot migration deletes "buhl-site-office-tweaks" if present
     (write the migration in src/lib/storage/migrate-local-storage.ts; run on app mount)
   - Tests — Phase A adds the first Vitest + Playwright tests (zero exist today)
   - TypeScript — Phase A is the first TS code in the repo
   - Deploy policy — Phase A removes deploy:prod from package.json
   - Mock-only fallback invisible — Phase A makes DemoModeBanner mandatory at shell level

  DEFERRED to later phases:
   - Phil signin/signout endpoint mismatch — Phase B fixes Phil login (replaced entirely)
   - "Site Office" naming purge — comment cleanup happens per file when the file is touched
   - /buhlos/* mirror routes — removed when Next.js owns the routing surface (Phase F+)
   - Public/admin/*.html files — deleted only after their feature is rebuilt
   - Service worker shell cache — kept until Phase G when SW is rewritten
   - Manifest start_url — flipped to /phil/my-day in Phase B

────────────────────────────────────────────────────────
Tests / build checks
────────────────────────────────────────────────────────

Before declaring Phase A complete, run and pass:

  npm install                         # installs new deps cleanly
  npm run typecheck                   # tsc --noEmit; zero errors
  npm run lint                        # next lint; zero warnings
  npm run test                        # vitest; all tests pass
  npx playwright install              # one-time browser install
  npm run test:e2e                    # phase-a.spec.ts passes
  npm run build                       # next build succeeds, no failures

  npm run check:admin-shell           # legacy guard still passes
  npm run check:sw-cache-version      # ditto
  npm run check:production-shell      # ditto
  npm run smoke:admin-routes          # ditto

The build output of `next build` should show the new routes and no errors.
The legacy surfaces (public/admin/*.html) should remain reachable on dev:
  curl http://localhost:3000/admin/operations  # should still serve the legacy SPA

If any guard fails, FIX it before declaring Phase A done. Do NOT loosen
the guards to make them pass.

────────────────────────────────────────────────────────
Constraints (binding rules)
────────────────────────────────────────────────────────

From docs/architecture/00-rebuild-non-negotiables.md, the following are
non-negotiable for everything you write in this phase:

  1. TypeScript only in src/. No .js files in src/.
  2. No static HTML primary surfaces.
  3. No business logic in pages. Domains carry logic.
  4. No mock-only UI pretending to be functional.
     - When fixtures load, DemoModeBanner is visible.
     - Every "feature coming later" path uses <UnderConstructionPanel />, NEVER alert().
  5. No vercel deploy --prod from local. The script is removed.
  6. No legacy naming in NEW code. "Site Office" / "Switchboard" (as product name) /
     "site-office" in any new identifier, file name, class, comment, or string.
  7. No half-built fake features without UNDER CONSTRUCTION labels.

If you're unsure whether a feature should be live or UC, default to UC.

────────────────────────────────────────────────────────
What success looks like
────────────────────────────────────────────────────────

When Phase A is done:
  - `npm run dev` starts the app on http://localhost:3000.
  - http://localhost:3000/ redirects to /login (unauthed) or /command-centre / /phil (authed).
  - http://localhost:3000/login (or /v2/login if conflict) shows a new login form.
  - http://localhost:3000/command-centre shows AdminShell with the new sidebar.
  - http://localhost:3000/phil shows PhilShell with the new bottom tab bar.
  - http://localhost:3000/admin/operations still shows the legacy Command Centre SPA.
  - http://localhost:3000/my-day still shows the legacy tradie home.
  - All four pre-existing check scripts still pass.
  - The Playwright Phase A spec passes.
  - Nothing in production is touched. The PR (when later opened) is preview-only.

When you're done, write a Phase A summary in the chat saying:
  - Files created (with line counts)
  - Tests passing
  - Build size
  - What's UNDER CONSTRUCTION
  - The exact command the user should run to verify locally
  - What Phase B will tackle

DO NOT push the branch. DO NOT open a PR. DO NOT deploy.
The user will review locally first.
```

---

## Why this prompt looks the way it does

- **No "decide whether to" or "consider"** — the audit already decided. The next session executes.
- **Specific files to create + specific files to AVOID** — no ambiguity about scope.
- **No production touch** — explicit denials on every dangerous verb.
- **Acceptance is verifiable** — every exit criterion is a runnable command or a URL to load.
- **The phrase "do not delete"** appears multiple times because the audit found six recent regressions caused by deletion drift.
- **The phrase "under construction"** appears multiple times to enforce [[feedback_hide_unfinished_features]].
- **Bounded scope** — Phase A only. Phase B is a separate session with its own prompt.

---

## Anti-patterns this prompt avoids

The prompt deliberately:

1. **Does not give Claude Code latitude on architecture.** The structure is decided in [01-target-rebuild-structure.md](../architecture/01-target-rebuild-structure.md); Claude follows it.
2. **Does not let Claude choose the stack.** Next.js + TS + Tailwind is named explicitly.
3. **Does not allow "while we're at it" cleanups.** Out-of-scope tasks (Phil signin fix, /buhlos/* removal, etc.) are listed under "deferred" and Claude is told to skip them.
4. **Does not allow Claude to deploy.** Multiple "DO NOT deploy" lines.
5. **Does not assume the audit branch is on main.** It tells Claude to fetch and branch from main, and to ask if the audit isn't there yet.

---

## How to use this

When ready for Phase A:

1. Merge the `phase-1-rebuild-audit` branch into `main` via PR (the audit doc lives there).
2. Open a new Claude Code session.
3. Paste the block between the triple-backticks above as the user message.
4. Let Claude Code do Phase A.
5. Review locally before pushing.
6. Open the Phase A PR.
7. Verify on the preview URL.
8. Merge to main.
9. Phase A is now in production (placeholder shells reachable; legacy surfaces unchanged).
10. Start Phase B with a similarly-scoped prompt.

The Phase B prompt will be written as Phase A lands.
