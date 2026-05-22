# 06 · Deployment audit

`buhlos.com` has been wrong on **2026-05-20** and **2026-05-22** (today). Both incidents were direct `vercel deploy --prod` from a feature branch, replacing a correct main-derived build with a prototype branch's content. The current deploy contract has guards but they are bypassable and have been bypassed.

This document audits the deploy surface and proposes a strict policy.

---

## Current deployment story

### Package scripts (`package.json`)

```json
{
  "engines": { "node": "24.x" },
  "scripts": {
    "check:admin-shell":       "node scripts/check-admin-shell.js",
    "check:sw-cache-version":  "node scripts/check-sw-cache-version.js",
    "check:production-shell":  "node scripts/check-production-shell.js",
    "check:prod-branch":       "node scripts/check-prod-branch.js",
    "smoke:admin-routes":      "node scripts/smoke-admin-routes.js",
    "predeploy":               "npm run check:admin-shell && npm run check:sw-cache-version && npm run check:production-shell && npm run smoke:admin-routes",
    "predeploy:prod":          "npm run check:prod-branch && npm run check:admin-shell && npm run check:sw-cache-version && npm run check:production-shell && npm run smoke:admin-routes",
    "predeploy:preview":       "npm run check:admin-shell && npm run check:sw-cache-version && npm run check:production-shell && npm run smoke:admin-routes",
    "deploy:prod":             "vercel deploy --prod --yes",
    "deploy:preview":          "vercel deploy --yes"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    "@vercel/blob":      "^0.24.0",
    "bcryptjs":          "^2.4.3",
    "cookie":            "^0.6.0",
    "web-push":          "^3.6.7"
  }
}
```

### Pre-deploy guards

| Script                                          | Purpose                                                                                                | Bypass possible?                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `scripts/check-admin-shell.js`                  | Every `public/admin/*.html` file must call `SHELL.boot()` or have its own `boot()`.                    | No (static check; trivial to add).                                                |
| `scripts/check-sw-cache-version.js`             | If `_shell.js`/`_shell.css`/`theme.css`/`public/admin/*.html` changed, `CACHE_VERSION` must bump.       | No.                                                                               |
| `scripts/check-production-shell.js`             | Production HTML must contain BuhlOS Command Centre markers; must NOT contain `Birdwood IV3232` finger­print. | No.                                                                               |
| `scripts/smoke-admin-routes.js`                 | vercel.json + login + admin/index + operations + _shell.js wiring intact end-to-end.                   | No.                                                                               |
| `scripts/check-prod-branch.js`                  | HEAD === origin/main on `predeploy:prod`.                                                              | **YES — `GUARD_OVERRIDE=YES-I-KNOW` skips the check entirely.** Bypass logs in CI but does not block. |

### Vercel config (`vercel.json`)

- **51 rewrites** across admin, buhlos mirror, phil, my-day, lh, client, legacy, root.
- **7 cron jobs** scheduled (see [01-current-route-map.md](01-current-route-map.md) cron section).
- **No `regions` setting** (deploys to default region).
- **No `cleanUrls` / `trailingSlash`** (Vercel default).
- **No headers section** (no CSP, no HSTS configured at the framework level — Vercel applies its own defaults).

### Environment variables referenced

| Variable                  | Used in                                  | Required?                            |
| ------------------------- | ---------------------------------------- | ------------------------------------ |
| `SESSION_SECRET`          | `api/_lib/auth.js`                       | **YES** — throws if missing or < 16 chars. |
| `BLOB_READ_WRITE_TOKEN`   | `api/_lib/blob.js`                       | **YES** — every API call needs it.    |
| `VAPID_PUBLIC_KEY`        | `api/_lib/push.js`, `public/sw.js`       | Optional — push notifications fail silently without it. |
| `VAPID_PRIVATE_KEY`       | `api/_lib/push.js`                       | Optional — same.                      |
| `VAPID_CONTACT`           | `api/_lib/push.js`                       | Optional — same.                      |
| `ANTHROPIC_API_KEY`       | not directly referenced in JS yet         | Unused at the surface; `@anthropic-ai/sdk` is in deps but not wired. |

### Branch / deployment assumptions

- **Production target:** `main` branch → `buhlos.com` (Vercel-GitHub integration).
- **Preview targets:** every PR gets a preview URL via Vercel.
- **Direct deploys allowed:** any developer with `vercel` CLI access can `vercel deploy --prod` from any branch unless `predeploy:prod` runs (which only happens via `npm run deploy:prod`).
- **No CI enforcement:** the pre-deploy checks are *local-machine* hooks. A developer can run `vercel deploy --prod --yes` directly and skip `npm run` entirely.

This is the **root cause of both production outages**. The `vercel` CLI accepts a `--prod` flag from any branch; there is no Vercel-side gate.

---

## Build output assumptions

The current deploy has **no build step**. Vercel:
1. Treats `public/*` as static files (zero-config).
2. Treats `api/*.js` as serverless functions (one file = one route).
3. Applies `vercel.json` rewrites.

There is no `next build`, no bundler, no TypeScript compilation, no asset hashing.

In the rebuild this changes:
- `next build` produces a hashed JS bundle.
- Existing `public/*.html` files remain for legacy routes.
- Existing `api/*.js` files remain as Vercel serverless functions alongside Next.js's own functions.
- The rewrite layer in `vercel.json` shrinks dramatically — Next.js owns most routing.

---

## Static files used as app surfaces (problem)

Today, every customer-facing route ultimately resolves to one of these static HTML files:

| Static file                         | Size  | Role                                                      |
| ----------------------------------- | ----- | --------------------------------------------------------- |
| `public/login.html`                 | 49KB  | Public login page                                          |
| `public/admin.html`                 | 436KB | Legacy admin (`/admin-legacy`)                            |
| `public/admin/operations.html`      | 162KB | BuhlOS Command Centre SPA                                  |
| `public/admin/job.html`             | 282KB | Admin per-job (largest non-`admin.html` admin file)        |
| `public/admin/jobs.html`            | 36KB  | Admin jobs list                                            |
| `public/project.html`               | 482KB | Legacy per-job view (`/jobs/:id`)                          |
| `public/phil.html`                  | 60KB  | Phil mobile app                                            |
| `public/my-day.html`                | 98KB  | Legacy tradie home                                         |
| `public/lh-home.html`               | 53KB  | Leading-Hand home                                          |
| `public/client.html`                | 21KB  | Client portal                                              |

Each of these contains inline `<style>` and `<script>` blocks. Code splitting is non-existent. Every visitor downloads a fully-inlined page.

**In the rebuild:** none of these are "primary app surfaces". All become React components inside Next.js routes. Static HTML is quarantined under `/legacy/*` for one cycle and then deleted.

---

## Risks that could cause production to differ from main

| Risk                                                                           | Likelihood | Mitigation today                                              | Mitigation needed                                       |
| ------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| Direct `vercel deploy --prod` from feature branch                              | **HAPPENED ×2** | `check-prod-branch.js` — bypassable with env var      | Disable in Vercel project settings (auto-deploy only)   |
| `GUARD_OVERRIDE=YES-I-KNOW` used for emergency revert and not unset            | Medium     | Verbose log line                                              | Remove the override entirely; emergency reverts go via `vercel promote` instead |
| Vercel production alias pinned by previous direct deploy                       | High       | `vercel promote <main-deploy>` manually                       | Lock the alias to "auto-promote from main" in Vercel UI |
| Wrong Vercel project selected (e.g. deploy to a sandbox project URL)            | Medium     | None                                                          | `.vercel/project.json` committed; verify in `predeploy` |
| Stale Blob data referenced by new build                                        | Low        | Blob is shared between preview + prod                         | Acceptable for current scale                             |
| Cron jobs firing against wrong build                                           | Low        | Crons read whatever shape exists in Blob                      | Inventory + freeze before changing shapes                |

---

## Risks that could cause blank pages after login

The blank-page regression has happened **6 times** per `docs/regressions/admin-operations-blank.md`. The architecture has accreted 7 layers of defence, listed in `_shell.js` and the regression doc.

| Layer | Defence                                                  | Catches                                                        |
| ----- | -------------------------------------------------------- | -------------------------------------------------------------- |
| 1     | Convention: every `_shell.js` page ends with `SHELL.boot()` | Easy-to-eyeball requirement.                                |
| 2     | `check-admin-shell.js` (static)                          | Missing `SHELL.boot()` call.                                   |
| 3     | `smoke-admin-routes.js` (static)                         | Broken rewrite chain or missing role redirect.                 |
| 4     | `_shell.js` auto-boot fallback on DOMContentLoaded       | Page forgot `SHELL.boot()` at runtime.                         |
| 5     | `_shell.js` 5-second blank-shell detector                | Page never mounted `#app`.                                     |
| 6     | `safeBoot` outer try/catch around `boot()`               | Any throw in boot.                                              |
| 7     | Per-page render try/catch + visible error fallback        | Any throw in `PAGE.render()`.                                  |
| 8     | `dismissSplash()` in `finally{}` (operations.html)        | Throw after splash up.                                          |
| 9     | `showBootError()` for unknown role                        | Role gate mismatch.                                             |
| 10    | `check-production-shell.js` (static)                      | Wrong build's HTML (no BuhlOS marker, Birdwood fingerprint).   |
| 11    | `check-prod-branch.js`                                    | Feature-branch deploy to prod.                                  |

**Carry forward into the rebuild:**
- Error boundaries at the route level (Next.js native).
- Middleware redirects for unauthenticated → `/login` and wrong-role → role landing.
- Static pre-build checks that the rebuild's role gate covers every role we have users in.
- Vercel-side enforcement of "deploy from main only".

---

## Hardcoded production URLs

Grep for `buhlos.com` / `buhlapp.xyz` in the codebase finds:
- `docs/deploy-checklist.md` (correct — documentation).
- `docs/regressions/admin-operations-blank.md` (correct — documentation).
- `package.json` (none).
- `vercel.json` (none — Vercel-managed).
- `public/*.html` — manifest start_url uses relative paths; no hardcoded hostnames.
- `public/sw.js` — uses `self.location.origin`.

No hardcoded production URLs in app code. Good.

---

## Preview vs production confusion

- Preview deploys use the same Blob (`BLOB_READ_WRITE_TOKEN`) as production. Writing from a preview affects production data.
- Preview deploys use the same `SESSION_SECRET`. A session cookie from prod works on preview.
- Preview deploys use the same VAPID keys — push notifications from preview reach real users.

**Risk:** an engineer testing a destructive change on a preview deploy is acting on real prod data.

**Recommendation for rebuild:** separate Blob tokens per environment (preview vs prod). Optionally separate `SESSION_SECRET` so prod cookies are not accepted on preview. Vercel supports per-environment env vars.

---

## Strict recommended deployment policy

Effective from the rebuild branch. To be enforced by both local guard and Vercel project settings.

### Rules

1. **`main` is production.**
   - The only path to `buhlos.com` is via the Vercel-GitHub auto-deploy from `main`.
   - Direct `vercel deploy --prod` is **forbidden**.
   - The `deploy:prod` npm script is removed entirely from `package.json` in the rebuild branch.

2. **Feature branches are preview-only.**
   - Every PR auto-creates a preview URL.
   - The preview URL is the only place engineers verify their work pre-merge.
   - `vercel deploy --yes` (preview) is allowed for ad-hoc previews but not encouraged — PR-driven previews are the norm.

3. **No `vercel deploy --prod` from any local branch — full stop.**
   - The `GUARD_OVERRIDE=YES-I-KNOW` escape hatch is removed.
   - Emergency reverts use `vercel promote <previous-deploy-url>` exclusively (rollback path, not redeploy).

4. **Every production deploy must be verified within 5 minutes.**
   - The deploy-checklist (rebuilt) lists the five critical routes (`/`, `/login`, `/admin`, `/lh`, `/phil`) and what each must show.
   - A second human eyeballs the prod URL after the deploy lands.

5. **Deployment metadata must match latest main commit.**
   - The Vercel dashboard shows the deployed commit SHA — verify it matches `git rev-parse origin/main`.
   - `check-production-shell.js` evolves to also check the SHA fingerprint, not just text fingerprints.

6. **Rollback path is documented in `docs/runbooks/rollback.md`.**
   - Step 1: `vercel promote <previous-prod-deploy-url>` (or use dashboard "Promote to production").
   - Step 2: revert the merge commit on `main` so the next auto-deploy is correct.
   - Step 3: investigate, fix, re-merge.

7. **Preview Blob isolation (preferred but not blocking).**
   - Separate `BLOB_READ_WRITE_TOKEN_PREVIEW` for non-prod environments.
   - If single-token is unavoidable, every preview deploy banner says "PREVIEW — writes affect production data".

### Enforcement layers

| Layer                       | Enforced by                                   | Bypassable?                                            |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Local: branch must be main  | `predeploy:prod` (current)                    | Yes (env override) — **REMOVE in rebuild**             |
| Local: blocked `deploy:prod`| Script removed from `package.json` in rebuild | No (you'd have to add it back)                         |
| Vercel: deploy access       | Project settings — restrict to GitHub auto-deploy | Vercel-side; only repo admins                       |
| Vercel: production alias     | Locked to auto-promote from `main`            | Vercel-side; only repo admins                       |
| Repo: branch protection on main | GitHub branch protection rules           | Yes (admin push) — recommended setting: no admin push |
| CI: lint + typecheck + build | GitHub Actions on PR + on push to main       | No (gates merge, gates deploy)                        |

### Rebuild deploy script (target shape)

```json
{
  "scripts": {
    "dev":          "next dev",
    "build":        "next build",
    "lint":         "next lint",
    "typecheck":    "tsc --noEmit",
    "test":         "vitest run",
    "verify":       "npm run typecheck && npm run lint && npm run build && npm run test",
    "deploy:preview": "vercel deploy --yes"
  }
}
```

**Note:** `deploy:prod` is intentionally absent. Production deploys happen only via GitHub merge to `main`.

---

## What changes vs the current setup

| Item                                  | Current                                 | Rebuild target                                                                 |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| Production deploy path                | `npm run deploy:prod` OR GitHub auto    | GitHub auto-deploy from main, only.                                            |
| Preview deploy path                   | `npm run deploy:preview` OR auto on PR  | Auto on PR (preferred); `npm run deploy:preview` retained for ad-hoc.          |
| `vercel deploy --prod`                | Allowed (with bypassable guard)         | **Disallowed.** Script removed; no human invokes it.                           |
| `GUARD_OVERRIDE=YES-I-KNOW`           | Allowed                                 | **Removed.**                                                                    |
| Build step                            | None (static files)                     | `next build`.                                                                  |
| TypeScript compilation                | None                                    | `tsc --noEmit` in `predeploy`.                                                  |
| Tests                                 | None (only static-string checks)         | Vitest + Playwright route smokes (initially small).                            |
| Service worker shell cache            | `buhl-shell-v7` with manual bump        | Drop shell caching; Next.js handles asset hashing/caching.                     |
| Vercel rewrites                       | 51 rewrites in `vercel.json`            | Next.js owns routing. `vercel.json` shrinks to `crons` + maybe headers.        |
| Blob token isolation                  | Shared between preview + prod           | Preferred: separate tokens per env.                                            |
| Cron jobs                             | 7 crons in `vercel.json`                | Carried forward; endpoints rebuilt later.                                      |

---

## Pre-rebuild action items (do these BEFORE the rebuild PR)

1. **Lock the Vercel production alias** to auto-promote from `main` only (Vercel project settings).
2. **Disable manual production deploys** in Vercel project settings (if available — see "Production overrides" / "GitHub Auto-deploy").
3. **Add GitHub branch protection on `main`**:
   - Require PR review (1 reviewer minimum).
   - Require status checks to pass.
   - Forbid force push.
   - Restrict who can push directly (only admins, and only for emergency).
4. **Document the rollback runbook** as `docs/runbooks/rollback.md`.
5. **Audit who has Vercel deploy access** — anyone who shouldn't, remove.

These four actions take less than an hour and would have prevented both production outages.
