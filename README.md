# BuhlOS

The operating layer for a small electrical / construction business — one place to run jobs, hours, gear, quotes, site capture, and compliance. Two surfaces share one Next.js codebase and one backend:

- **BuhlOS** — the desktop **admin / office** interface (the "Command Centre"): for the boss, admin staff, PMs, estimators. Jobs, the job builder, quoting, hours + approvals, gear, employees, reports, ITPs/checks, material requests, notifications.
- **Phil** — the **mobile / on-site field** app: for tradies, apprentices, labourers, electricians. My Day, job home, photo capture, hours, gear, ITP recording, leave, onboarding.

Production is live at **https://buhlos.com** (repo/package name: `birdwood-iv3232`).

> **Naming:** use **BuhlOS** (admin/office) and **Phil** (field/mobile). **"Switchboard" and "Site Office" are deprecated** product names — do not introduce them in new code or UI (enforced by `npm run check:legacy-quarantine` and lint). See [`docs/architecture/00-rebuild-non-negotiables.md`](docs/architecture/00-rebuild-non-negotiables.md).

## Governance

Phil (the field app) is governed by a ratified constitution. Field-surface work derives from [the constitutional package](docs/phil-constitution.md) (law → [governance](docs/phil-governance.md) → [architecture](docs/phil-architecture.md) → [field validation](docs/phil-field-validation.md) → [roadmap](docs/phil-implementation-roadmap.md)). **Agents/sessions start at [CLAUDE.md](CLAUDE.md).**

---

## Architecture

A single **Next.js (App Router)** application plus **Vercel serverless functions** for the API, deployed on Vercel. The modern app **is production** — there is no separate legacy front-end anymore.

| Area | Location | What it is |
| --- | --- | --- |
| **App (UI)** | `src/app/**` | All rendered surfaces (admin + field). |
| **Admin (BuhlOS)** | `src/app/(admin)/**`, `src/app/v2/**` | Command Centre, jobs (`/v2/jobs`) + job builder, quotes (`/v2/quotes`), hours + approvals + weekly, gear, employees, reports, ITP templates, material requests, observations, defects, notification settings, login (`/v2/login`). |
| **Field (Phil)** | `src/app/phil/**` | My Day, jobs + job home (capture, ITPs, plans, tags), hours, gear, leave, onboarding, invite. |
| **Domain logic** | `src/domains/<entity>/**` | ~30 domains (jobs, quoting, timesheets, time-entries, evidence, snags, itp, gear, workforce, analytics, audit-log, platform, …) — pure logic + typed clients + tests. |
| **Shared** | `src/components/**`, `src/lib/**`, `src/middleware.ts` | UI primitives, admin/phil shells, auth/session/roles, env (`src/lib/env.ts`), feature flags; middleware gates routes by role. |
| **Backend API** | `api/**.js` | ~100 Vercel serverless functions (data in Vercel Blob; shared helpers in `api/_lib/`). |
| **Static** | `public/` | **`client.html` only** (the client portal) plus brand assets, icons, `manifest.json`, `sw.js` (push-only service worker), CSS. |
| **Routing / redirects** | `vercel.json` | `framework: nextjs`; rewrites `/client`; a **redirect matrix maps every legacy URL** (`/login`, `/admin/*`, `/phil`, `/my-day`, …) to its modern route (307). |
| **Docs** | `docs/` | Architecture, product scope, runbooks, per-feature docs, audit pack. |

> **Post-cutover:** the old static estate (`public/*.html`, `public/admin/*.html`, the flat legacy front-end) was **deleted** in the legacy cutover. Old URLs now **307-redirect** to the Next.js routes via `vercel.json` — never re-add legacy HTML pages, and never remove redirect entries. See [`docs/legacy-cutover.md`](docs/legacy-cutover.md) and the route-ownership contract [`docs/route-ownership.md`](docs/route-ownership.md) (enforced by `npm run check:route-ownership`).

---

## Local development

```bash
npm install
npm run dev          # Next.js dev server on http://localhost:3000
```

Create `.env.local`. The env schema is Zod-validated in [`src/lib/env.ts`](src/lib/env.ts) (there is no `.env.example`):

| Var | Required? | For |
| --- | --- | --- |
| `SESSION_SECRET` | **Required** (≥16 chars) | Auth / session — auth-aware routes throw without it |
| `BLOB_READ_WRITE_TOKEN` | Optional | Vercel Blob data store (data is degraded/empty locally without it) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Optional | Web-push notifications |
| `RESEND_API_KEY` / `EMAIL_FROM` | Optional | Outbound email (invites, etc.) |
| `APP_BASE_URL` | Optional | Absolute links in emails / notifications |

Entry points once running:

| URL | Surface |
| --- | --- |
| `/v2/login` | Sign-in (office email + password, or worker name + PIN) |
| `/command-centre` | BuhlOS admin home (admin/office roles) |
| `/v2/jobs` | Admin jobs + job builder |
| `/phil/my-day` | Phil field home (field roles) |

> Many routes need an authenticated session and live data (Blob), and some `api/*.js` functions only run on Vercel — not under `next dev`. Verify authenticated / server behavior on a Vercel **preview** deploy, not just localhost.

---

## Testing & checks

> **Before opening or updating a PR, run `npm run check:full-ci`.** It mirrors the CI `check` job (typecheck, lint, unit/mocked-Blob tests, build, smoke discovery, and every route/shell/manifest/quarantine guard) and fails on the first failing guard. `npm run check` is the fast inner loop only — **not** CI parity.

| Command | What it does |
| --- | --- |
| `npm run check:full-ci` | **Run before every PR.** Full local CI-parity gate; kept in sync with `.github/workflows/ci.yml` by a drift-guard test. |
| `npm run check` | Fast inner loop: `typecheck` + `lint` + `test:unit`. Not CI parity. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | `next lint` with custom rules (no `alert`, no inline styles, no deprecated naming). |
| `npm run test` / `npm run test:unit` | Vitest unit / mocked-Blob tests (`test:watch` for watch mode). |
| `npm run test:e2e` | Playwright e2e (run `npx playwright install` once first). |
| `npm run test:smoke` | Playwright smoke specs. |
| `npm run build` | Next.js production build. |
| Guard scripts (`check:*`, `smoke:*`) | `route-ownership`, `shell-contract`, `production-shell`, `legacy-quarantine`, `prod-branch`, `backup-manifest`, `role-literals`, `model-ids`, `sw-cache-version`, `admin-shell`, `smoke:legacy-redirects`, … (most also run in the `predeploy` chain). |

> A local `tsc --noEmit` may flag one Next.js typed-route error in `src/app/v2/jobs/[jobId]/itps/page.tsx` — Next typed routes need a `next build` to generate `.next/types/` first, so standalone `tsc` false-flags it. CI runs the build, so it stays green there.

---

## Production & deploy rules

- **Production = `main` only.** Vercel's Git integration auto-deploys `main` to `buhlos.com`. Do not change the production branch.
- **Ship via PR → CI green → squash-merge to `main`.** The merge triggers the production deploy; there is no manual prod step.
- **No manual production deploys from a branch/worktree.** `scripts/check-prod-branch.js` (`npm run check:prod-branch`) refuses a `--prod` deploy unless `HEAD === origin/main` — it exists because a prototype branch was once deployed over production. Don't bypass it (`GUARD_OVERRIDE` is for emergency reverts only).
- `npm run deploy:preview` makes an ad-hoc **preview** (never promotes). `predeploy` / `predeploy:preview` run the shell / route / legacy guards first.
- Rollback: `vercel promote <previous-deployment>`. See [`docs/deploy-checklist.md`](docs/deploy-checklist.md).
- **Do not casually touch:** `vercel.json` (redirect matrix), `src/middleware.ts`, auth/session (`api/_lib/auth.js`, `src/lib/auth/**`), `public/sw.js` (bump its `SW_VERSION` on any change), and the CI guard tests.

---

## Repo hygiene

A 2026-06-13 cleanup consolidated this repo from a sprawl of parallel branches/worktrees back to a single clean line. To keep it that way:

- **One task = one branch**, cut from a clean, up-to-date `main`.
- Open a **PR** → get **CI green** → **squash-merge** → **delete the branch**.
- Avoid extra git worktrees unless you genuinely need parallel checkouts; remove them when done.
- Don't reuse stale branches or resurrect deleted ones — start fresh from `main`.
- No direct commits to `main`, no force-push.

---

## Current state (2026-06-13)

- Local line is fully consolidated: `main = origin/main = production = 7f3d222`, one worktree, clean tree, zero open PRs at consolidation time.
- Branches/worktrees/stashes removed during the cleanup are archived at `~/buhlos-backup/tranche-4-manual-review-preservation-20260613-181941` (outside the repo). Nothing was lost — don't try to "rescue" deleted branches.
- One stash is intentionally retained as an implementation reference for audit-log durability (issue **#355**).
- **PR #450** merged the audit-log durability spec pack ([`docs/audit-log/`](docs/audit-log/)) — the mutation policy matrix for **#355**; the durability *implementation* (blocking vs best-effort append) remains open under #355.
- Remote-branch cleanup (the GitHub remote still carries many old branches) is a **separate, deliberate** task — do not bulk-delete remotes casually.

---

## Deprecated / do-not-use

- **"Switchboard", "Site Office"** — deprecated product names; use **BuhlOS** / **Phil**. They should only appear when referring to historical docs.
- **Legacy static pages** — `public/*.html` / `public/admin/*.html` and root `index.html` / `jobs.html` / `login.html` / `phil.html` were deleted in the cutover. Their old URLs 307-redirect to Next.js routes; do not recreate these files.
- **"Phase A / mid-migration / nothing in production yet"** framing (from earlier in the rebuild) is obsolete — the Next.js app *is* production.
