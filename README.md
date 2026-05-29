# Birdwood / BuhlOS

The BuhlOS operating layer plus its two surfaces:

- **BuhlOS Admin** — desktop/admin "Command Centre" for boss, admin staff, PMs, estimators.
- **Phil** — field/mobile worker app for tradies, apprentices, labourers, electricians.

> Naming reference: see [`docs/architecture/00-rebuild-non-negotiables.md`](docs/architecture/00-rebuild-non-negotiables.md). "Switchboard" and "Site Office" are deprecated product names and must not appear in any new code or surface.

---

## Where things live

This repo is mid-migration. Two surfaces co-exist:

| Layer | Location | Authoritative for |
| --- | --- | --- |
| **Legacy app** | `public/*.html`, `public/admin/*.html`, `api/*.js` | Every production user-facing surface (logged in users land here today). |
| **New app shell (Phase A)** | `src/app/**`, `src/components/**`, `src/lib/**` | Parallel test surfaces: `/command-centre`, `/v2/login`, `/v2/phil`. Nothing in production routes through this code yet. |
| **Vercel routing** | `vercel.json` | Owns canonical URLs (`/`, `/login`, `/admin/*`, `/phil`, `/my-day`, ...). Untouched by Phase A. |
| **Docs** | `docs/` | Audit, architecture, product scope, runbooks. |

The Phase A scaffold is **additive**: it occupies routes that `vercel.json` does not rewrite. See [`docs/rebuild-audit/08-next-claude-code-prompt.md`](docs/rebuild-audit/08-next-claude-code-prompt.md) for the full Phase A brief and [`docs/product/01-mvp-rebuild-scope.md`](docs/product/01-mvp-rebuild-scope.md) for the wider rebuild roadmap.

Which URL belongs to which surface — canonical, transitional, or legacy — and the rules nav must follow are the **route ownership contract** in [`docs/route-ownership.md`](docs/route-ownership.md) (enforced by `npm run check:route-ownership`). The legacy-only production URL inventory is [`docs/rebuild-audit/01-current-route-map.md`](docs/rebuild-audit/01-current-route-map.md).

---

## Quickstart

```bash
npm install
npm run dev
```

Then open:

| URL | What you see |
| --- | --- |
| http://localhost:3000/v2/login | New Phase A sign-in form. Posts to the existing `/api/auth?action=login`. |
| http://localhost:3000/command-centre | New BuhlOS Admin shell (sidebar + topbar, placeholder content). Gated to admin roles. |
| http://localhost:3000/v2/phil | New Phil shell (header + bottom tab bar). Gated to field roles. |
| http://localhost:3000/admin/operations | Legacy admin Command Centre — unchanged. |
| http://localhost:3000/my-day | Legacy Phil home — unchanged. |

In `dev`, `vercel.json` rewrites do not apply, so `/` falls through to `src/app/page.tsx` (which redirects you to `/v2/login`). In production, `/` is still rewritten to `public/login.html` by `vercel.json`.

You need `SESSION_SECRET` (≥16 chars) in `.env.local` for auth-aware routes to render without throwing.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server. |
| `npm run build` | Next.js production build. |
| `npm run start` | Serve the production build. |
| `npm run lint` | `next lint` with custom rules (no `alert`, no inline styles, no deprecated naming). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test` | Vitest unit tests. |
| `npm run test:e2e` | Playwright Phase A acceptance tests. Run `npx playwright install` once first. |
| `npm run check:admin-shell` | Legacy guard (kept). |
| `npm run check:sw-cache-version` | Legacy guard (kept). |
| `npm run check:production-shell` | Legacy guard (kept). |
| `npm run smoke:admin-routes` | Legacy guard (kept). |

**Removed in Phase A:** `deploy:prod` and `predeploy:prod`. Direct production deploys from local CLIs are no longer supported — production happens via merge to `main` and Vercel's automatic redeploy. Rollbacks use `vercel promote <previous-deploy>` (see [`docs/rebuild-audit/06-deployment-audit.md`](docs/rebuild-audit/06-deployment-audit.md)).

`deploy:preview` is kept for ad-hoc preview deploys; it does not promote.

---

## Project structure (Phase A)

```
src/
├── app/                              Next.js routes
│   ├── layout.tsx                    Root — Inter fonts, DemoModeBanner
│   ├── page.tsx                      `/` (dev only — redirects per role)
│   ├── error.tsx                     Global error boundary
│   ├── not-found.tsx                 404
│   ├── v2/login/                     New login (parallel to public/login.html)
│   ├── v2/phil/                      New Phil shell (parallel to public/phil.html)
│   └── (admin)/command-centre/       New admin shell (replaces /admin/operations later)
├── components/
│   ├── ui/                           Button, Card, Pill, EmptyState, Modal,
│   │                                 UnderConstructionPanel, DemoModeBanner, StatusBadge
│   ├── admin/                        AdminShell, AdminSidebar, AdminTopbar
│   └── phil/                         PhilShell, PhilTabBar, PhilHeader
├── lib/
│   ├── auth/                         landing, roles, session, current-user, permissions
│   ├── storage/                      migrate-local-storage (clears "buhl-site-office-*")
│   ├── env.ts                        Zod-validated env
│   ├── flags.ts                      Feature flags + DEMO MODE
│   ├── http.ts                       Typed fetch wrapper
│   └── cn.ts                         tailwind-merge helper
├── middleware.ts                     Route gating (/command-centre, /v2/phil)
├── styles/
│   ├── tokens.css                    Brand colours + density tokens
│   └── globals.css                   Tailwind directives + .uc-tape pattern
└── types/index.ts                    Global type helpers
```

Domain folders (`src/domains/<entity>/`) are added when their first feature lands in Phase B+; see [`docs/architecture/01-target-rebuild-structure.md`](docs/architecture/01-target-rebuild-structure.md).

---

## What Phase A doesn't do

- No Phil hours logging. That's Phase B, with `/api/time-entries` already in place.
- No admin features beyond the empty Command Centre placeholder.
- No `/admin` or `/login` cutover — both still served by the legacy surface.
- No `vercel.json` edits.
- No production deploys.

If you reach for any of those, stop and re-read [`docs/rebuild-audit/08-next-claude-code-prompt.md`](docs/rebuild-audit/08-next-claude-code-prompt.md).
