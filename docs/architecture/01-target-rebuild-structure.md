# 01 · Target rebuild structure

The clean app structure for the rebuild. Next.js App Router, TypeScript, Tailwind, route groups, shared types, domain folders, backend-ready typed fixtures, Vercel deployment.

This document is the blueprint Claude Code should follow when generating the first set of files in the rebuild branch.

---

## Stack

| Layer            | Choice                                                  | Why                                                                         |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Framework         | Next.js 15+ App Router                                  | Server components, native routing, edge middleware for auth gates.          |
| Language          | TypeScript (strict)                                     | Catch shape drift the current repo can't.                                   |
| Styling           | Tailwind CSS v3+ with custom design tokens              | Replaces 100KB+ inline `<style>` blocks; tokens for brand consistency.       |
| State management  | React Server Components + React Query (TanStack)        | Server-rendered admin; client-side caching for Phil; no global state lib.    |
| Form handling     | React Hook Form + Zod resolvers                         | Typed forms with shared validators.                                          |
| Validation        | Zod                                                     | Same schemas client + server.                                                |
| Date              | `date-fns` (small, tree-shakeable)                       | Replaces ad-hoc date string handling.                                       |
| Icons             | `lucide-react` (or keep inline SVGs in shared component) | Consistent icon set; avoid the 22-component web-component sprawl.            |
| Testing           | Vitest (unit) + Playwright (E2E)                         | Fast unit + cross-browser E2E for the hours loop.                            |
| Backend (Phase 1) | Existing `api/*.js` Vercel serverless functions          | Don't touch the working backend until UI rebuild lands.                      |
| Backend (Phase 2) | Postgres + Prisma OR Postgres + Drizzle                  | Replaces Blob when the data model has matured. Decision deferred to Phase 2. |
| Auth (transition) | Existing HMAC cookie via `api/_lib/auth.js`              | Wrapped in TS client. Migration path to Auth.js later if needed.             |
| Deployment        | Vercel (existing project)                                 | Already paid for; no migration risk.                                        |

---

## Folder structure

The new code lives entirely under `src/`. The old `public/` and `api/` stay in place during transition.

```
src/
├── app/                              # Next.js App Router routes
│   ├── layout.tsx                    # Root layout (font, theme provider, error boundary)
│   ├── page.tsx                      # Public landing — redirects to /login or role landing
│   ├── login/
│   │   ├── page.tsx                  # /login — Server Component
│   │   ├── login-form.tsx            # Client Component (form)
│   │   └── actions.ts                # Server Action that posts to /api/auth?action=login
│   ├── install/
│   │   └── page.tsx                  # /install — PWA install instructions
│   ├── (admin)/                      # Route group — admin surface
│   │   ├── layout.tsx                # AdminShell (sidebar + topbar)
│   │   ├── command-centre/page.tsx   # /command-centre — replaces /admin/operations
│   │   ├── jobs/
│   │   │   ├── page.tsx              # /jobs — list
│   │   │   ├── new/page.tsx          # /jobs/new — Job Builder
│   │   │   └── [jobId]/
│   │   │       ├── page.tsx          # /jobs/:id — detail
│   │   │       ├── stages/page.tsx   # /jobs/:id/stages
│   │   │       └── areas/[areaId]/page.tsx
│   │   ├── hours/
│   │   │   ├── page.tsx              # /hours — overview
│   │   │   └── approvals/page.tsx    # /hours/approvals — review queue
│   │   ├── gear/
│   │   │   ├── page.tsx              # /gear — register
│   │   │   └── [assetId]/page.tsx    # /gear/:id — detail + assignment history
│   │   ├── materials/page.tsx        # /materials — PARK (UNDER CONSTRUCTION until Phase D+)
│   │   ├── itp/page.tsx              # /itp — PARK
│   │   ├── plans/page.tsx            # /plans — PARK
│   │   ├── rfis/page.tsx             # /rfis — NEW domain
│   │   ├── snags/page.tsx            # /snags — defects
│   │   ├── reports/page.tsx          # /reports — PARK
│   │   ├── settings/page.tsx         # /settings — admin-only
│   │   ├── people/page.tsx           # /people — admin-only
│   │   ├── support/page.tsx          # /support — admin-only
│   │   ├── activity/page.tsx         # /activity — audit log view
│   │   └── lh/page.tsx               # /lh — leading-hand home (if LH stays in admin route group)
│   ├── (phil)/                       # Route group — Phil mobile
│   │   ├── layout.tsx                # PhilShell (bottom tab nav)
│   │   ├── phil/
│   │   │   ├── page.tsx              # /phil — defaults to my-day
│   │   │   ├── my-day/page.tsx       # /phil/my-day
│   │   │   ├── hours/page.tsx        # /phil/hours
│   │   │   ├── gear/page.tsx         # /phil/gear
│   │   │   ├── jobs/
│   │   │   │   ├── page.tsx          # /phil/jobs
│   │   │   │   └── [jobId]/
│   │   │   │       ├── page.tsx      # /phil/jobs/:id
│   │   │   │       ├── tasks/[taskId]/page.tsx
│   │   │   │       └── itps/page.tsx
│   │   │   ├── snags/
│   │   │   │   ├── page.tsx          # /phil/snags — mine
│   │   │   │   └── raise/page.tsx    # /phil/snags/raise
│   │   │   ├── rfis/
│   │   │   │   ├── page.tsx
│   │   │   │   └── raise/page.tsx
│   │   │   └── me/page.tsx           # /phil/me — profile/sign out
│   ├── (client)/                     # Route group — Client portal
│   │   ├── layout.tsx
│   │   └── client/page.tsx           # /client — per-job read-only
│   └── api/                          # NEW Next.js API routes (gradual)
│       └── (none initially — keep existing api/*.js working)
│
├── components/                       # All React components, organised by surface
│   ├── ui/                           # Generic primitives (Button, Card, Pill, Modal)
│   │   ├── Button.tsx
│   │   ├── Card.tsx
│   │   ├── Pill.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── Modal.tsx
│   │   ├── EmptyState.tsx
│   │   ├── UnderConstructionPanel.tsx    # The standard UC placeholder
│   │   ├── DemoModeBanner.tsx            # Visible banner when fixtures are loaded
│   │   ├── CommandPalette.tsx
│   │   └── ...
│   ├── admin/                        # Admin-shell-specific
│   │   ├── AdminShell.tsx            # Sidebar + topbar layout (replaces _shell.js)
│   │   ├── AdminSidebar.tsx
│   │   ├── AdminTopbar.tsx
│   │   ├── KpiTile.tsx
│   │   ├── JobHeader.tsx
│   │   └── ...
│   ├── phil/                         # Phil-mobile-specific
│   │   ├── PhilShell.tsx             # Bottom-tab nav layout
│   │   ├── PhilTabBar.tsx
│   │   ├── PhilHeader.tsx
│   │   ├── LogHoursSheet.tsx         # The 7h 36m standard-day sheet
│   │   ├── SnagRaiseSheet.tsx
│   │   └── ...
│   └── shared/                       # Used by both surfaces
│       ├── JobStatusPill.tsx
│       ├── HoursDisplay.tsx
│       └── ...
│
├── domains/                          # Business logic — one folder per entity domain
│   ├── jobs/
│   │   ├── types.ts                  # type Job, JobStage, JobArea, JobTask
│   │   ├── schema.ts                 # Zod validators
│   │   ├── fixtures.ts               # Typed mock data (replaces window.BUHLOS_MOCK.jobs)
│   │   ├── client.ts                 # Typed API client (calls /api/jobs)
│   │   ├── service.ts                # Pure business logic (no React imports)
│   │   └── jobs.test.ts
│   ├── timesheets/
│   │   ├── types.ts                  # type TimesheetEntry, TimesheetApproval
│   │   ├── schema.ts
│   │   ├── fixtures.ts
│   │   ├── client.ts                 # POST /api/time-entries, etc.
│   │   ├── service.ts                # Standard-day = 7.6h logic, validation helpers
│   │   └── timesheets.test.ts
│   ├── workers/                      # WorkerProfile / Role
│   ├── gear/                         # GearAsset / GearAssignment / GearScan
│   ├── evidence/                     # Evidence + Photo
│   ├── rfis/                         # NEW — RFI domain
│   ├── itp/                          # ITPTemplate / ITPCheckpoint / ITPCompletion
│   ├── plans/                        # PlanDocument / PlanRevision / PlanAcknowledgement
│   ├── snags/                        # Defect (Snag)
│   ├── materials/                    # MaterialItem / MaterialRequest
│   ├── variations/                   # Variation
│   ├── alerts/                       # Alert (cross-cutting)
│   ├── audit-log/                    # AuditLog (cross-cutting, immutable)
│   └── organisation/                 # Organisation / single tenant for now
│
├── lib/                              # Cross-cutting, framework-y code
│   ├── auth/
│   │   ├── session.ts                # Wraps api/_lib/auth.js HMAC cookie reads
│   │   ├── current-user.ts           # getCurrentUser() typed
│   │   ├── landing.ts                # The one landingFor() function
│   │   ├── roles.ts                  # type Role + ROLE_TO_SURFACE map
│   │   ├── permissions.ts            # Role → Permission[] table
│   │   └── middleware.ts             # Next.js middleware that gates routes
│   ├── db/                           # Currently empty — placeholder for Phase 2 Postgres
│   ├── storage/
│   │   └── blob.ts                   # Typed wrapper over api/_lib/blob.js
│   ├── validation/
│   │   └── zod-helpers.ts            # Custom Zod refinements (nanoid, date strings)
│   ├── env.ts                        # Validated env vars (Zod schema)
│   ├── http.ts                       # Typed fetch wrapper for API calls
│   ├── flags.ts                      # Feature flags + DEMO MODE toggle
│   └── cn.ts                         # Tailwind class concatenation helper
│
├── styles/
│   ├── tokens.css                    # Brand tokens (--accent-yellow, --brand-navy, etc.)
│   └── globals.css                   # Tailwind directives + small global resets
│
├── types/                            # Truly global types (rare)
│   └── index.ts
│
└── middleware.ts                     # Next.js middleware (gates routes; calls lib/auth/middleware.ts)
```

### What also lives in the repo

```
public/                               # static assets only — favicons, manifest, images
├── icon-192.png
├── icon-512.png
├── icon.svg
├── BUHL_LOGO.png
├── manifest.json                     # start_url: '/phil/my-day' (changes from /my-day)
└── sw.js                             # service worker (push only — no shell cache)

api/                                  # existing serverless functions (kept during transition)
├── _lib/
└── *.js                              # 89 endpoints (unchanged in Phase 1)

scripts/                              # one-off scripts
└── migrations/historical/            # migrate-birdwood.js etc. live here

docs/                                 # all docs
├── architecture/
├── product/
├── rebuild-audit/
├── regressions/
├── runbooks/                         # NEW — rollback.md, on-call.md, etc.
└── deploy-checklist.md
```

### Legacy quarantine

```
public/_legacy/                       # everything from old public/* moves here during cutover
├── admin/...
├── components/...
├── *.html
└── *.js
```

Routes still pointing at legacy files are rewritten under `/legacy/*`. Once the new app fully owns a feature, the legacy file is deleted.

---

## Why each section exists, and what must never live there

### `src/app/`

**Purpose:** Next.js routes. Each `page.tsx` is a thin composition of components from `src/components/` and calls to domain services in `src/domains/`.

**Must never live here:**
- Business logic. Pages don't do calculations; they call domain functions.
- Data shapes. Pages don't define types; they import from `src/domains/*/types.ts`.
- API endpoints. Those live in `src/app/api/` (and during transition, the existing `api/*.js` at the repo root).
- Stylesheets. Pages don't define styles; they use Tailwind utilities and components.
- Mock data. Pages don't seed fixtures; they import from `src/domains/*/fixtures.ts`.

### `src/components/`

**Purpose:** All React components, organised by which surface uses them. `ui/` for primitives shared by everything; `admin/` for admin-shell-specific; `phil/` for Phil-mobile-specific; `shared/` for genuinely cross-surface.

**Must never live here:**
- Business logic. Components are presentational; they call into domain services.
- API client code. That's in `src/domains/<domain>/client.ts`.
- Routes. Routes are in `src/app/`.
- Mock data.

### `src/domains/`

**Purpose:** Per-entity domain code. Types, schemas, fixtures, API clients, pure business logic. This is where the *product* lives. The folder structure mirrors the entity list in [03-data-model-audit.md](../rebuild-audit/03-data-model-audit.md).

**Must never live here:**
- React components. Domain code is framework-agnostic.
- DOM access. No `window`, no `document`, no `location`.
- Direct API responses without parsing. Every response from `api/*` is parsed via the domain's Zod schema before becoming a value.
- UI strings (where avoidable). Domain code returns data, not labels.

### `src/lib/`

**Purpose:** Cross-cutting framework code — auth wrappers, env validation, HTTP helpers, middleware. The "glue" between Next.js / Vercel and the domain code.

**Must never live here:**
- Domain-specific code (it goes to `src/domains/<domain>/`).
- React components.
- Page-level concerns.

### `src/styles/`

**Purpose:** Global CSS — Tailwind directives, design tokens, the small handful of global resets.

**Must never live here:**
- Component-specific styles. Use Tailwind utilities directly in the component.
- Page-specific styles. Same.

### `public/`

**Purpose:** Static assets only — favicons, PWA icons, manifest, optional images. The service worker (for push notifications, no longer for shell caching).

**Must never live here:**
- HTML files that are primary app surfaces. (Repeated from [00-rebuild-non-negotiables.md](00-rebuild-non-negotiables.md) — this is the most common temptation.)
- Inline scripts that run app logic.
- Mock data files.

### `api/`

**Purpose:** Existing Vercel serverless functions, kept untouched during Phase 1 of the rebuild. As features come online in the new app, their backends may eventually migrate to `src/app/api/`, but Phase 1 reuses the existing endpoints verbatim.

**Must never:**
- Receive new endpoints unless they're hard to express in Next.js (e.g. legacy cron-targeted paths).
- Accept full-document writes in new endpoints (existing ones are tolerated).

---

## Route → file mapping (canonical)

| URL                              | File                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `/`                              | `src/app/page.tsx` (redirects per role)                       |
| `/login`                         | `src/app/login/page.tsx`                                      |
| `/install`                       | `src/app/install/page.tsx`                                    |
| `/command-centre`                | `src/app/(admin)/command-centre/page.tsx`                     |
| `/jobs`                          | `src/app/(admin)/jobs/page.tsx`                               |
| `/jobs/new`                      | `src/app/(admin)/jobs/new/page.tsx`                           |
| `/jobs/:jobId`                   | `src/app/(admin)/jobs/[jobId]/page.tsx`                       |
| `/hours`                         | `src/app/(admin)/hours/page.tsx`                              |
| `/hours/approvals`               | `src/app/(admin)/hours/approvals/page.tsx`                    |
| `/gear`                          | `src/app/(admin)/gear/page.tsx`                               |
| `/people`                        | `src/app/(admin)/people/page.tsx`                             |
| `/itp`                           | `src/app/(admin)/itp/page.tsx`                                |
| `/plans`                         | `src/app/(admin)/plans/page.tsx`                              |
| `/materials`                     | `src/app/(admin)/materials/page.tsx`                          |
| `/rfis`                          | `src/app/(admin)/rfis/page.tsx`                               |
| `/snags`                         | `src/app/(admin)/snags/page.tsx`                              |
| `/reports`                       | `src/app/(admin)/reports/page.tsx`                            |
| `/settings`                      | `src/app/(admin)/settings/page.tsx`                           |
| `/support`                       | `src/app/(admin)/support/page.tsx`                            |
| `/activity`                      | `src/app/(admin)/activity/page.tsx`                           |
| `/lh`                            | `src/app/(admin)/lh/page.tsx`                                 |
| `/phil`                          | `src/app/(phil)/phil/page.tsx`                                |
| `/phil/my-day`                   | `src/app/(phil)/phil/my-day/page.tsx`                         |
| `/phil/hours`                    | `src/app/(phil)/phil/hours/page.tsx`                          |
| `/phil/gear`                     | `src/app/(phil)/phil/gear/page.tsx`                           |
| `/phil/jobs`                     | `src/app/(phil)/phil/jobs/page.tsx`                           |
| `/phil/jobs/:jobId`              | `src/app/(phil)/phil/jobs/[jobId]/page.tsx`                   |
| `/phil/snags/raise`              | `src/app/(phil)/phil/snags/raise/page.tsx`                    |
| `/phil/me`                       | `src/app/(phil)/phil/me/page.tsx`                             |
| `/client`                        | `src/app/(client)/client/page.tsx`                            |

### Removed in rebuild

- `/admin` (replaced by `/command-centre` — Next.js group lets us drop the `/admin` prefix).
- `/admin/*` (every old admin sub-route moves up one level).
- `/buhlos/*` mirror routes (deleted).
- `/jobs/:id` legacy (deleted; `/jobs/:id` now belongs to the admin route group).
- `/my-day`, `/my-gear`, `/phil-hours` (replaced by `/phil/*`).
- `/admin-legacy` (deleted).
- `/overview`, `/approvals` bare aliases (deleted).
- `/dev/*` (deleted).

### Kept reachable via `/legacy/*`

During cutover, the old static HTML stays reachable under a `/legacy/*` prefix in case we need to verify something or roll a slice back. After one release cycle, the `/legacy/*` rewrites are deleted along with the files.

---

## State management approach

| Need                                         | Tool                                      |
| -------------------------------------------- | ----------------------------------------- |
| Server-rendered data (initial page paint)    | React Server Components → `fetch` in `page.tsx` |
| Client-side data (interactive)               | React Query (`@tanstack/react-query`)     |
| Form state                                   | React Hook Form                           |
| Form validation                              | Zod resolvers                             |
| Cross-component state (rare)                 | React Context                             |
| Persistent client preferences                | localStorage with one namespace `buhlos.*` (legacy `buhl-site-office-*` deleted on boot) |
| Service worker push                          | `public/sw.js` (no shell caching)         |
| URL state (filters, tabs)                    | URL search params + `useSearchParams()`   |

**No global state library** (no Redux, no Zustand, no Jotai). The rebuild is small enough that React Query handles the data layer and React Context handles the rest.

---

## Backend evolution

**Phase 1:** Reuse existing `api/*.js`. New TypeScript clients in `src/domains/*/client.ts` call these.

**Phase 2 (deferred):** Migrate API endpoints to `src/app/api/*` in Next.js. This lets us run them as Edge Functions and apply shared middleware. The Blob storage continues unchanged.

**Phase 3 (further deferred):** Migrate from Vercel Blob to Postgres (likely with Drizzle for TS-first ergonomics). At this point the schemas in `src/domains/*/schema.ts` become the source of truth for both API and DB.

The rebuild never blocks on Phase 2 or 3.

---

## Tooling and CI

- **`tsc --noEmit`** in pre-commit hook (Husky or lefthook).
- **`eslint`** + **`@typescript-eslint/strict`** ruleset.
- **`prettier`** with project config; auto-format on commit.
- **`vitest`** for unit tests.
- **`playwright`** for E2E tests (hours loop is the reference suite).
- **GitHub Actions** workflows:
  - `pr.yml` — lint + typecheck + test + build on every PR.
  - `main.yml` — same plus a deploy gate (must be green before Vercel auto-deploys).

CI is the canonical gate. Local pre-deploy guards stay as defence-in-depth but are not the primary enforcement.

---

## Cross-references

- Rules of the road: [00-rebuild-non-negotiables.md](00-rebuild-non-negotiables.md)
- The first loops to build: [../product/00-core-operational-loops.md](../product/00-core-operational-loops.md)
- The MVP phases: [../product/01-mvp-rebuild-scope.md](../product/01-mvp-rebuild-scope.md)
- What survives from the current repo: [../rebuild-audit/07-salvage-map.md](../rebuild-audit/07-salvage-map.md)
- Data shapes that flow through: [../rebuild-audit/03-data-model-audit.md](../rebuild-audit/03-data-model-audit.md)
