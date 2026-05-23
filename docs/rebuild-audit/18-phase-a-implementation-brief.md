# 18 · Phase A — implementation brief

> The implementation brief Claude Code must follow when building **Phase A only**. Read [10-product-definition.md], [13-ui-information-architecture.md], [14-technical-architecture-deep-dive.md], [20-agent-rules.md] first. **Do not implement Phase B in this session.**

---

## Goal

Introduce a clean Next.js / TypeScript / Tailwind app shell **alongside** the legacy `public/*.html` + `api/*.js` app **without breaking production** and **without flipping any critical route**.

Phase A is foundation only. No features. No domains beyond the auth shape required to render the shells. The hours loop, gear, evidence, ITP, RFI, materials, variations, reports — none of them — are built in Phase A.

---

## Branch strategy

- Create a new local branch named `phase-a-app-shell`.
- **Branch from main if main contains the audit docs.** If not, branch from the Phase 1B audit head (`phase-1b-rebuild-deep-audit` or its tip commit). The audit docs are required reading; the agent must have them accessible.
- Do not push the branch.
- Do not open a PR (until the user reviews locally).
- Do not deploy.

---

## What Phase A MAY build

### A. Toolchain

- `package.json`:
  - **Add dependencies:** `next ^15`, `react ^19`, `react-dom ^19`, `typescript ^5`, `tailwindcss ^3`, `@tanstack/react-query`, `react-hook-form`, `zod`, `lucide-react`, `date-fns`, `clsx`, `tailwind-merge`.
  - **Add devDependencies:** `@types/react`, `@types/react-dom`, `@types/node`, `eslint`, `eslint-config-next`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `vitest`, `@vitest/ui`, `@playwright/test`, `prettier`, `postcss`, `autoprefixer`.
  - **Add scripts:** `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:watch`, `test:e2e`, `format`, `format:check`.
  - **Remove scripts:** `deploy:prod`, `predeploy:prod`.
  - **Keep scripts:** `check:admin-shell`, `check:sw-cache-version`, `check:production-shell`, `check:prod-branch`, `smoke:admin-routes`, `predeploy`, `predeploy:preview`, `deploy:preview`.
- `tsconfig.json`: strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, paths `@/* → ./src/*`.
- `tailwind.config.ts`: brand tokens (`--accent-yellow #ffcc00`, `--brand-navy #0d1f35`, `--accent-ink #0f172a`) + density tokens (compact/regular/roomy) + content globs over `src/`.
- `postcss.config.cjs`: tailwindcss + autoprefixer.
- `next.config.ts`: `typedRoutes: true`, image remotePatterns for `**.public.blob.vercel-storage.com`. **No rewrites.**
- `.eslintrc.json`: extends `next/core-web-vitals` + `next/typescript`; `no-alert`; `no-restricted-syntax` for inline styles, `/site[-_ ]?office/i` literals, alert/confirm/prompt calls. Ignores `public/`, `api/`, `scripts/`, legacy root scripts.
- `.prettierrc`: 2-space, double-quote, `trailingComma: es5`, `printWidth: 100`.
- `.gitignore`: keep existing lines; add `.next/`, `out/`, `coverage/`, `playwright-report/`, `test-results/`, `*.tsbuildinfo`, `.eslintcache`, `.DS_Store`, `.idea/`, `.vscode/`.
- `vitest.config.ts`: node environment, includes `src/**/*.test.ts`, alias `@`.
- `playwright.config.ts`: chromium project only; `webServer: npm run dev`.
- `next-env.d.ts`: standard Next.js stub.

### B. `src/` scaffold

Folders (every file noted below; empty/placeholder content is fine where the brief says "minimal"):

```
src/
├── app/
│   ├── layout.tsx                       Root layout (Inter + Inter Tight, DemoModeBanner, error boundary)
│   ├── page.tsx                         `/` redirect
│   ├── error.tsx                        Error boundary
│   ├── not-found.tsx                    404
│   ├── v2/login/
│   │   ├── page.tsx                     `/v2/login`
│   │   └── login-form.tsx               Client component, posts /api/auth?action=login
│   ├── v2/phil/
│   │   ├── layout.tsx                   Segment layout
│   │   └── page.tsx                     `/v2/phil` placeholder
│   └── (admin)/
│       ├── layout.tsx                   Route group wrapper
│       └── command-centre/page.tsx      `/command-centre` placeholder
├── components/
│   ├── ui/
│   │   ├── Button.tsx
│   │   ├── Card.tsx
│   │   ├── Pill.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── EmptyState.tsx
│   │   ├── Modal.tsx
│   │   ├── UnderConstructionPanel.tsx
│   │   └── DemoModeBanner.tsx
│   ├── admin/
│   │   ├── AdminShell.tsx
│   │   ├── AdminSidebar.tsx             1 live + 5 UC nav items
│   │   └── AdminTopbar.tsx
│   └── phil/
│       ├── PhilShell.tsx
│       ├── PhilTabBar.tsx               Today + More live; Jobs/Gear/Snag UC
│       └── PhilHeader.tsx
├── lib/
│   ├── auth/
│   │   ├── session.ts                   decode cookie + verifyViaApi()
│   │   ├── current-user.ts              getCurrentUser()
│   │   ├── landing.ts                   landingFor() canonical
│   │   ├── roles.ts                     Role types + ADMIN_ROLES/etc arrays
│   │   ├── permissions.ts               canAccessSurface()
│   │   └── landing.test.ts              Vitest unit tests
│   ├── storage/
│   │   └── migrate-local-storage.ts     One-time boot cleanup of deprecated keys
│   ├── env.ts                           Zod-validated process.env
│   ├── flags.ts                         feature flags + fixtures.isDemoMode()
│   ├── http.ts                          Typed fetch wrapper
│   └── cn.ts                            tailwind-merge + clsx helper
├── middleware.ts                        Gates /command-centre + /v2/phil
├── styles/
│   ├── tokens.css                       Brand tokens
│   └── globals.css                      Tailwind directives + .uc-tape pattern
└── types/
    └── index.ts                         Global type helpers (AsyncResult, Nominal)
```

### C. Routes that MUST render in Phase A

| URL | File | Behaviour |
| --- | --- | --- |
| `/` | `src/app/page.tsx` | Dev-only — `vercel.json` rewrites it in prod. Redirects to `/v2/login` or role landing. |
| `/v2/login` | `src/app/v2/login/page.tsx` | New login form. Already-logged-in users redirect to landing. |
| `/command-centre` | `src/app/(admin)/command-centre/page.tsx` | AdminShell + placeholder. Admin-gated by middleware. |
| `/v2/phil` | `src/app/v2/phil/page.tsx` | PhilShell + placeholder + UC panel for hours. Field-gated by middleware. |

### D. Middleware

- `src/middleware.ts` matches `/command-centre/:path*` and `/v2/phil/:path*`.
- Unauthenticated → redirect to `/v2/login?next=<pathname>`.
- Wrong-role → redirect to landing via `landingFor()`.
- Never gates `/v2/login` or static assets.

### E. Tests

- `src/lib/auth/landing.test.ts` — Vitest covering `landingFor()` for every role + unknown role + `rolePermits()`.
- `tests/phase-a.spec.ts` — Playwright 4 cases:
  1. Unauth `/v2/phil` → `/v2/login`.
  2. `/v2/login` renders form.
  3. Unauth `/command-centre` → `/v2/login`.
  4. DemoModeBanner visible on `/v2/login`.

### F. CI

- `.github/workflows/pr.yml` and `.github/workflows/main.yml`:
  - Setup Node 24.
  - `npm install`.
  - `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`.
  - Run all 4 legacy guards.
  - Env `SESSION_SECRET: ci-placeholder-session-secret-long-enough`.

### G. README

- `README.md` documenting: where new code lives, where legacy lives, quickstart, scripts.
- Do NOT update `OVERVIEW.md` (legacy reference).

---

## What Phase A MUST NOT build

- **No Phil hours loop.** Phase B.
- **No `/api/time-entries` integration.** Phase B.
- **No production `/login` cutover.** Phase C+.
- **No `/admin` cutover.** Phase D.
- **No Xero / payroll integration.** Phase F+.
- **No ITP engine.** Phase E.
- **No RFI engine.** Phase E.
- **No job evidence / photo loop.** Phase D.
- **No gear loop.** Phase C.
- **No reporting / KPIs.** Phase F+.
- **No AI plan interpretation.** Phase F+.

---

## What Phase A MUST NOT touch

- Any file under `public/`.
- Any file under `api/`.
- `vercel.json` (no rewrite edits, no rewrite removals, no rewrite additions).
- Any file under `scripts/`.
- `OVERVIEW.md`.
- Root-level legacy scripts: `migrate-*.js`, `recover-*.js`, `seed-*.js`, `unify-*.js`, `migrate.js`.
- Service worker `public/sw.js`.
- Manifest `public/manifest.json`.
- Any cookie semantics (`buhl_session` cookie name unchanged).

If the agent feels it needs to touch one of these, **stop and ask**.

---

## Success criteria

### Build / test

- `npm install` succeeds (some EBADENGINE warnings tolerated if Node version differs from `24.x`; resolve before merge).
- `npm run typecheck` → zero errors.
- `npm run lint` → zero warnings.
- `npm run test` → all vitest pass.
- `npm run build` → succeeds, prints route table including `/command-centre`, `/v2/login`, `/v2/phil`, `/`, `/_not-found`.
- All four legacy guards pass (`check:admin-shell`, `check:sw-cache-version`, `check:production-shell`, `smoke:admin-routes`).
- Playwright spec runs locally after `npx playwright install chromium` (don't require it to run in this sandbox).

### Runtime

- `npm run dev` boots; the four primary URLs render as described.
- `http://localhost:3000/admin/operations` still serves the legacy SPA unchanged.
- `http://localhost:3000/my-day` still serves the legacy tradie home unchanged.
- `http://localhost:3000/login` still serves the legacy login (vercel.json rewrites it in dev too if `vercel dev` is used; otherwise Next.js shows 404 because we did not mount `/login`).

### Constraints

- No `vercel deploy` invoked.
- `git diff dcac892 -- vercel.json public/ api/ scripts/ migrate-*.js recover-*.js seed-*.js unify-*.js OVERVIEW.md` returns no output.
- No push.
- No `git branch -D` or destructive operations.
- No silent mock data fallback added.
- No deprecated naming in any new file.

---

## Tests to run

```
npm install
npm run typecheck
npm run lint
npm run test
npm run build
npm run check:admin-shell
npm run check:sw-cache-version
npm run check:production-shell
npm run smoke:admin-routes
# Playwright (optional in sandbox; required locally)
npx playwright install chromium
npm run test:e2e
```

---

## Command result documentation

The agent must record exact results in `docs/rebuild-audit/22-phase-1b-command-results.md` (or its successor for Phase A). For each command, capture:

- Command invoked.
- Pass / fail.
- One-line output summary.
- For failures: full output + the fix applied + re-run result.

---

## Branch / commit / deploy posture

- Branch: `phase-a-app-shell`.
- Base: `dcac892` (Phase 1 audit tip) OR Phase 1B audit head if Phase 1B has landed on main.
- Commit: one clean commit "Phase A · Next.js + TypeScript foundation alongside legacy (additive)".
- Push: no.
- PR: not yet.
- Deploy: no.

---

## Exact final response format

After implementation, Claude Code must respond with this structure:

```
## Phase A · complete report

### Branch / base
- Worktree path
- Branch name
- Base commit SHA
- New commit SHA
- Working tree status (clean/dirty)

### Files changed
- Count of new vs modified
- List of new files grouped by area (root config, src/styles, src/lib, src/components, src/app, tests, .github)

### Routes added
- Table: URL → File → Behaviour (live / UC)

### Scripts diff
- Added / Removed / Kept

### Checks run
- Each: command, result, notes

### Failures / blockers
- None, or itemised

### Deferred
- Playwright (note that `npx playwright install` is required locally)
- Anything else

### Confirmations
- No deploy occurred
- No push
- No legacy file touched
- No vercel.json rewrite flipped

### How to verify locally
- Exact commands

### What Phase B will tackle
- One-paragraph summary aligned to [19-phase-b-hours-implementation-brief.md]
```

---

## If main does not contain the audit docs

- Phase 1 + 1B audits live on branches that may not be merged to `main` when Phase A starts.
- The audit prompt says branch from main "after main contains the audit docs".
- **If main does not contain them**, the agent must branch from the Phase 1B audit head (`phase-1b-rebuild-deep-audit`) instead of blindly from main, so the docs are accessible from the working tree.
- In all cases the agent must confirm with the user before branching from anywhere other than main.

---

## Cross-references

- [10-product-definition.md](10-product-definition.md)
- [13-ui-information-architecture.md](13-ui-information-architecture.md)
- [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md)
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md)
- [20-agent-rules.md](20-agent-rules.md)
- [21-rebuild-decision-record.md](21-rebuild-decision-record.md)
- [08-next-claude-code-prompt.md](08-next-claude-code-prompt.md) — the original Phase A prompt (this brief supersedes / refines).
