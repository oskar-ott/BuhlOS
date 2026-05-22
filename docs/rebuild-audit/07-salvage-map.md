# 07 · Salvage map

Every meaningful file, route, feature, and pattern in the repo — categorised KEEP / REBUILD / DISCARD. Specific, not generic.

---

## KEEP — carry forward with minimal changes

### Backend code (`api/_lib/*`)

| File                          | Why keep                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `api/_lib/auth.js`            | HMAC session, role helpers, `canWrite` / `canManageJob`. Wrap in TS, don't rewrite. |
| `api/_lib/blob.js`            | `readBlob` / `writeBlob` / `setNoCache`. Tiny, correct, used everywhere.        |
| `api/_lib/validation.js`      | `nanoid()`, `validateAreaGroups()`, `validateTasks()`. Shape validators.        |
| `api/_lib/activity.js`        | Activity log helpers. Becomes the seed of the AuditLog domain.                  |
| `api/_lib/job-audit.js`       | Job-level audit helpers. Same.                                                  |
| `api/_lib/job-tasks.js`       | Task helpers. Same.                                                              |
| `api/_lib/time-entries.js`    | Timesheet helpers — the only production-quality domain code. Reference for new ones. |
| `api/_lib/push.js`            | Web Push helpers. Used by cron.                                                  |

### Backend endpoints (`api/*.js`) — high-quality, in-use

| Endpoint                                | Notes                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `api/auth.js`                            | Login, logout, me, change-password. Add `signin`/`signout` aliases to support Phil during transition. |
| `api/users.js`                           | User CRUD. ~14KB; complete and used.                                                    |
| `api/jobs.js`                            | Jobs CRUD. 29KB — large but in-use.                                                     |
| `api/data.js`                            | Per-job tasks/snags/notes blob. **Full-document write is a known concurrency risk.**    |
| `api/hours.js` + `api/time-entries*.js`  | The hours pipeline. The reference loop for the rebuild.                                  |
| `api/snags-all.js`, `api/snag-quick-raise.js`, `api/snag-quick-close.js` | Snag flow.                                                       |
| `api/photos.js`                          | Photo upload (base64). Add size limits later.                                            |
| `api/crew.js`                            | Crew assign/unassign. Small and correct.                                                 |
| `api/assets.js`                          | Gear/asset register.                                                                     |
| `api/notifications.js`                   | Web Push delivery, daily reminders. Cron-driven.                                         |
| `api/access-requests.js`, `api/password-resets.js` | Support inbox.                                                            |
| `api/activity.js`, `api/user-activity.js` | Activity stream.                                                                        |
| `api/today-pulse.js`, `api/admin-stats.js` | Dashboard rollups.                                                                     |
| `api/job-audit.js`, `api/job-areas.js`, `api/job-glance.js`, `api/job-quick-actions.js`, `api/job-timeline.js`, `api/job-templates.js`, `api/job-itps.js`, `api/job-draft.js`, `api/job-circuits.js` | All in-use. |

### Config and env

| Item                                  | Why keep                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `SESSION_SECRET` env var               | Existing cookies remain valid.                                                  |
| `BLOB_READ_WRITE_TOKEN` env var        | All real data lives here.                                                       |
| `VAPID_*` env vars                     | Push notifications.                                                              |
| Vercel project + domain (`buhlos.com`) | Customers know this URL.                                                         |
| `vercel.json` `crons` section          | 7 scheduled endpoints — keep all (rebuild later).                                |

### Docs and runbooks

| Item                                              | Why keep                                                  |
| ------------------------------------------------- | --------------------------------------------------------- |
| `OVERVIEW.md`                                      | Stale in parts but the data shapes section is reusable.   |
| `docs/regressions/admin-operations-blank.md`       | Institutional memory. Link from rebuild docs.             |
| `docs/deploy-checklist.md`                         | Salvage the strict rules; rewrite surface bits.            |

### Brand assets

| Item                          | Why keep                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `public/BUHL_LOGO.png`        | bühl brand mark.                                                                |
| `public/icon-*.png`, `icon.svg` | PWA icons. Per [[project_phil_logo_v3]] the Phil logo is the V3 plug-style.    |
| `public/logo.png`             | Same as BUHL_LOGO (likely a duplicate; keep one).                                |
| Token: `#ffcc00` yellow accent | Brand colour. Carry forward as `--accent-yellow` in Tailwind config.            |
| Token: `#0d1f35` navy header   | Brand colour. Carry as `--brand-navy`.                                           |
| Inter + Inter Tight typography  | Carry forward.                                                                  |

### Patterns worth keeping

| Pattern                                                                            | Where it lives now                          | Why keep                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| HMAC-signed JSON-payload session cookie                                            | `api/_lib/auth.js`                          | Stateless, no DB needed.                            |
| `readBlob(key, fallback)` / `writeBlob(key, data)` pattern                         | `api/_lib/blob.js`                          | Simple, correct, hard to misuse.                    |
| Three-state task values (`not_started` / `in_progress` / `complete`)               | `api/_lib/validation.js`                    | Domain-correct.                                     |
| Standard-day = 7h 36m (decimal 7.6) one-tap timesheet button                       | `phil.html`, `phil-hours.html`, `my-day.html` | Per [[project_buhlos_phil_hours_pipeline]]. Carry forward. |
| `setNoCache(res)` on every API response                                            | `api/_lib/blob.js`                          | Avoids stale-API risk.                              |
| `?action=` query-param dispatch on a single endpoint                                | `api/auth.js`, `api/users.js`               | Simple. Optional pattern; can stay.                 |
| Per-page sidebar count fan-out + sessionStorage cache (15s TTL)                    | `_shell.js`                                 | The mechanism is fine; the architecture above it is what's wrong. |
| Bcrypt 4-digit PIN for tradies                                                     | `api/auth.js`                               | Field-realistic.                                     |
| Independent-reviewer rule for ITP (`itp_review_self`)                              | `operations.html` (partial)                 | Domain-correct compliance pattern.                  |
| Audit-log-after-action approach                                                    | `api/_lib/activity.js`                      | Carry forward into AuditLog.                        |

---

## REBUILD — ideas/features worth keeping, implementation replaced

### Admin surface

| What                                          | Current implementation                                | New implementation                                                  |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Command Centre (admin home)                   | `public/admin/operations.html` (3,246 lines)          | `src/app/(admin)/command-centre/page.tsx`                            |
| Jobs list + detail                            | `public/admin/jobs.html` + `public/admin/job.html`    | `src/app/(admin)/jobs/page.tsx` + `src/app/(admin)/jobs/[id]/page.tsx` |
| Hours admin view                              | `public/admin/hours.html` + `approvals.html`          | `src/app/(admin)/hours/page.tsx` + `approvals/page.tsx`               |
| Crew / People                                 | `public/admin/crew.html`                              | `src/app/(admin)/people/page.tsx`                                    |
| Snags                                          | `public/admin/snags.html`                             | `src/app/(admin)/snags/page.tsx`                                     |
| Assets                                         | `public/admin/assets.html`                            | `src/app/(admin)/gear/page.tsx`                                      |
| Activity                                       | `public/admin/activity.html`                          | `src/app/(admin)/activity/page.tsx`                                  |
| Support inbox                                  | `public/admin/support.html`                           | `src/app/(admin)/support/page.tsx`                                   |
| Settings                                       | `public/admin/settings.html`                          | `src/app/(admin)/settings/page.tsx`                                  |
| Admin shell (sidebar + topbar + content)       | `public/admin/_shell.js` + `_shell.css`               | `src/components/admin/AdminShell.tsx` + Tailwind                     |

### Phil surface

| What                                          | Current implementation                                | New implementation                                                  |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Phil home / My Day                            | `public/phil.html#renderToday` + `public/my-day.html` | `src/app/(phil)/phil/my-day/page.tsx`                                |
| Phil Hours capture                            | `phil-hours.html` + `log-hours-sheet.js`              | `src/app/(phil)/phil/hours/page.tsx`                                 |
| Phil Gear                                     | `my-gear.html` + `phil.html#renderGear`               | `src/app/(phil)/phil/gear/page.tsx`                                  |
| Phil Jobs                                     | `phil.html#renderJobs`                                | `src/app/(phil)/phil/jobs/page.tsx`                                  |
| Phil Per-job view                             | `phil.html#openJob`                                   | `src/app/(phil)/phil/jobs/[id]/page.tsx`                             |
| Phil snag raise                               | `phil.html#saveSnag` (TODO) + `my-day.html`           | `src/app/(phil)/phil/snags/raise/page.tsx`                           |
| Phil More / Profile                           | `phil.html#renderMore`                                | `src/app/(phil)/phil/me/page.tsx`                                    |
| Phil shell (bottom-tab nav)                   | `phil.html` inline                                    | `src/components/phil/PhilShell.tsx`                                  |

### Leading-Hand surface

| What                                          | Current implementation                                | New implementation                                                  |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| LH home (field control)                       | `public/lh-home.html`                                 | `src/app/(admin)/lh/page.tsx` (LH is admin-with-restrictions in target). Could alternatively become a Phil mode. Decided in rebuild. |

### Client portal

| What                                          | Current implementation                                | New implementation                                                  |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Per-job client view                           | `public/client.html`                                  | `src/app/(client)/client/page.tsx`                                  |

### Public

| What                                          | Current implementation                                | New implementation                                                  |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Login                                          | `public/login.html`                                   | `src/app/login/page.tsx`                                            |
| PWA install instructions                       | `public/install.html` + `install-prompt.js`           | `src/app/install/page.tsx`                                          |

### Shared UI

| What                                          | Current implementation                                | New implementation                                                  |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Theme tokens                                   | `public/theme.css`, `public/css/buhlos*.css`          | `tailwind.config.ts` + `src/styles/tokens.css`                       |
| Component primitives                          | `public/components/*.js` (22 web components)          | `src/components/ui/*` (React + Tailwind)                             |
| Command palette                               | `public/components/cmd-palette.js`                    | `src/components/ui/CommandPalette.tsx`                               |
| Empty state                                    | `public/components/empty-state.js`                    | `src/components/ui/EmptyState.tsx`                                   |
| Progress bar                                   | `public/components/progress-bar.js`                   | `src/components/ui/ProgressBar.tsx`                                  |
| Status pills, role pills, badges               | `public/components/*-pill.js`, `seg-status.js`        | `src/components/ui/Pill.tsx`, `StatusBadge.tsx`                      |
| Job header card                                | `public/components/job-header.js`                     | `src/components/admin/JobHeader.tsx`                                 |
| Snag button                                    | `public/components/snag-button.js`                    | `src/components/phil/SnagButton.tsx`                                 |
| Inbox stack / pulse strip / queue              | Various in `public/components/`                       | `src/components/admin/*`                                             |

### Patterns to rebuild

| Pattern                                        | Why rebuild                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Inline `<script>` blocks per page              | Replace with React components in `src/`.                                     |
| Inline `<style>` blocks per page               | Replace with Tailwind utilities + a single tokens file.                      |
| `window.PAGE = { id, title, render }` global   | Replace with Next.js routing + per-route metadata.                            |
| `SHELL.boot()` trailing call                   | Not needed in Next.js — replaced by route mounting.                          |
| `window.BUHLOS_MOCK` global fallback           | Replace with typed fixtures + an explicit DEMO MODE flag.                    |
| `_shell.js` cross-page sessionStorage cache     | Replace with React Query / SWR cache.                                        |
| Two timesheet formats (legacy + new)            | New format only. Legacy is a read-only migration source.                     |
| Full-document blob writes for tasks/snags/notes | Replace with patch endpoints (PATCH per task / PATCH per snag).               |
| Web components in `public/components/`          | Replace with React components.                                                |
| `document.body.innerHTML = '...'` overlays     | Replace with proper modal components.                                         |

---

## DISCARD — should not be carried forward at all

### Legacy primary surfaces

| File / route                              | Size  | Why discard                                                              |
| ----------------------------------------- | ----- | ------------------------------------------------------------------------ |
| `public/admin.html`                       | 436KB | Legacy admin. Reachable at `/admin-legacy`. No traffic. Delete after cutover. |
| `public/project.html`                     | 482KB | Legacy per-job page. Reachable at `/jobs/:id`. Delete after cutover.     |
| `public/my-day.html`                      | 98KB  | Legacy tradie home. Phil replaces it. Delete once `/phil/my-day` is canonical. |
| `public/my-gear.html`                     | 16KB  | Legacy gear page. Phil replaces it.                                       |
| `public/phil-hours.html`                  | 14KB  | Legacy standalone hours page. Phil replaces it.                           |
| `public/lh-home.html`                     | 53KB  | If LH becomes an admin mode, this entire file goes.                       |

### Dev / playground surfaces

| File / route                              | Why discard                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `public/dev/site-office/components.html`  | Uses deprecated naming `site-office`. Per [[project_buhlos_phil_naming]] this is a hard violation. |
| `public/dev/site-office/`                 | Whole folder.                                                             |
| `public/dev/components/index.html`        | Component playground. Replace with Storybook or similar — or just delete. |
| `public/dev/components/`                  | Whole folder.                                                             |

### Duplicated and legacy routes

| Route                                     | Why discard                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `/buhlos/*` (22 routes)                   | Mirror of `/admin/*`. No traffic justifies it.                            |
| `/jobs`                                   | Alias for `/admin/jobs`. Confusing.                                       |
| `/jobs/:jobId`                            | Points at legacy `project.html`. Replaced by `/admin/jobs/:id`.            |
| `/jobs/:jobId/log-hours`                   | Same.                                                                     |
| `/admin-legacy`                           | Pointer at legacy admin file.                                              |
| `/overview`                               | Alias for `/admin/operations`.                                            |
| `/approvals`                              | Bare alias for `/admin/approvals`.                                        |
| `/dev/site-office`                        | Deprecated naming.                                                        |
| `/dev/site-office/components`             | Deprecated naming.                                                        |
| `/dev/components`                         | Internal — should never have been in `vercel.json`.                       |

### localStorage / sessionStorage keys

| Key                                       | Why discard                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `buhl-site-office-tweaks`                 | Deprecated "site-office" naming on every admin device.                    |
| `buhl.admin.sidebar.v1`                   | Side-effect of `_shell.js` architecture. Replaced by client-side query cache. |

### Service worker concerns

| Item                                      | Why                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `STATIC_SHELL` cache list in `sw.js`      | Caches `_shell.css`/`_shell.js`/`theme.css`. None of these exist in the rebuild. Drop the cache layer. |
| `CACHE_VERSION = 'buhl-shell-v7'` versioning | Same — no shell to cache.                                              |

### Mock-data globals

| Item                                      | Why                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `window.BUHLOS_MOCK`                      | Invisible fallback to mock data. Replace with explicit DEMO MODE + fixtures. |
| Phil's inline `MOCK_JOBS`, `MOCK_AREAS`, `MOCK_TASKS`, `MOCK_HOURS`, `TODAY_TASKS`, `GEAR_TYPES` | Same. |

### Inline patterns

| Pattern                                                           | Why                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `// TODO: POST to /api/snags (not yet built)` in Phil             | The endpoint IS built (`api/snag-quick-raise.js`). Drop the TODO; wire the call. |
| `alert('Plan upload — FEATURE UNDER CONSTRUCTION...')`            | Replace with proper `UnderConstructionPanel` component.                   |
| `alert('Job creation lives in the legacy admin while Job Builder is under construction')` | Same. |
| `// TODO` comments referencing endpoints that already exist       | Sweep and remove.                                                          |

### Code-comment naming violations

These need a one-time sweep before or during the rebuild PR:

- `_shell.js:1-4` header says "BuhlOS site office — shared shell JS"
- `_shell.js:24` `TWEAK_KEY = 'buhl-site-office-tweaks'`
- `_shell.js:587-593` brand block shows "bühl admin · site office"
- `login.html:14, 71, 741, 744` "site-office" / "Site Office" comments and class names
- `sw.js:34-35` comment "replacing the site-office shell"
- `phil.html:1548-1549` user-visible "Site Office portal" + "Go to Site Office" button
- `phil.html:1009` `'Install DB-G switchboard'` — this is fine (it's an electrical switchboard, not the deprecated app name)
- `admin.html:2494` `MAT_CATEGORIES` includes `'Switchboard / DB'` — fine (equipment category)
- `project.html:2980` `FITOFF = [..., 'Switchboard Fit-Off', ...]` — fine (electrical task)

The pattern is: "Switchboard" the equipment category stays; "Switchboard" the deprecated product name goes; "Site Office" goes everywhere.

### Misc

| Item                                      | Why                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `migrate-birdwood.js`, `migrate.js`, `recover-birdwood-roughin.js`, `seed-birdwood-checklist.js`, `unify-birdwood-stages.js` (in repo root) | Old one-off migration scripts. Move to `scripts/migrations/` or delete entirely. |
| `package.json#scripts.deploy:prod`        | Removed — see [06-deployment-audit.md](06-deployment-audit.md).            |
| `package.json#scripts.predeploy:prod` env var bypass | Removed.                                                          |

---

## Specific file-level salvage table

| File / area                                       | Verdict                  | Notes                                                                    |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `package.json`                                    | 🟢 KEEP (extend)         | Add Next.js / React / TS / Tailwind deps. Remove `deploy:prod`.            |
| `vercel.json`                                     | 🔵 REBUILD (mostly)      | Most rewrites disappear. Keep `crons`.                                    |
| `OVERVIEW.md`                                     | 🔵 REBUILD               | Stale. Replace with new rebuild docs.                                     |
| `migrate-*.js`, `recover-*.js`, `seed-*.js`, `unify-*.js` | 🔴 DISCARD or 🟡 ARCHIVE | Move to `scripts/migrations/historical/` or delete.                |
| `api/_lib/auth.js`                                | 🟢 KEEP                   | Wrap, don't rewrite.                                                       |
| `api/_lib/blob.js`                                | 🟢 KEEP                   | Same.                                                                     |
| `api/_lib/validation.js`                          | 🟢 KEEP                   | Same.                                                                     |
| `api/_lib/{activity,job-audit,job-tasks,push,time-entries}.js` | 🟢 KEEP    | Same.                                                                     |
| `api/auth.js`                                     | 🟢 KEEP                   | Add `signin`/`signout` aliases or fix Phil's calls.                       |
| `api/jobs.js`, `api/users.js`, `api/data.js`, etc. | 🟢 KEEP (refactor later) | Use as-is; refactor when domain code in `src/` matures.                  |
| `api/quotes.js` (71KB)                            | 🟡 PARK                   | Big and not on the critical path for MVP rebuild.                         |
| `api/suppliers.js`, `api/materials-list.js`       | 🟡 PARK                   | Same.                                                                     |
| `public/login.html`                               | 🔵 REBUILD                | Replaced by `src/app/login/page.tsx`. Comment naming cleanup until then. |
| `public/admin.html`                               | 🔴 DISCARD                | Legacy admin. Reachable at `/admin-legacy`.                               |
| `public/admin/operations.html`                    | 🔵 REBUILD                | Re-implement as `src/app/(admin)/command-centre/`.                         |
| `public/admin/<x>.html` (24 pages)                | 🔵 REBUILD                | Each becomes a Next.js route.                                              |
| `public/admin/_shell.{js,css}`                    | 🔵 REBUILD                | Replaced by `AdminShell.tsx` + Tailwind.                                  |
| `public/admin/admin-data.js`                      | 🔵 REBUILD                | Move into typed `src/domains/*/fixtures.ts`.                              |
| `public/admin/index.html`                         | 🔵 REBUILD                | Replaced by Next.js middleware redirect.                                  |
| `public/phil.html`                                | 🔵 REBUILD                | Replaced by `src/app/(phil)/phil/*`.                                       |
| `public/my-day.html`                              | 🔴 DISCARD                | Legacy.                                                                   |
| `public/my-gear.html`                             | 🔴 DISCARD                | Legacy.                                                                   |
| `public/phil-hours.html`                          | 🔴 DISCARD                | Legacy.                                                                   |
| `public/lh-home.html`                             | 🔴 DISCARD                | Becomes part of Admin shell or Phil shell — file deleted either way.      |
| `public/client.html`                              | 🔵 REBUILD                | Replaced by `src/app/(client)/client/page.tsx`.                            |
| `public/project.html`                             | 🔴 DISCARD                | Legacy per-job view.                                                       |
| `public/log-hours-sheet.js`                       | 🔵 REBUILD                | Replaced by `src/components/phil/LogHoursSheet.tsx`.                      |
| `public/components/*.js` (22 files)               | 🔵 REBUILD                | All become React components.                                              |
| `public/lib/approvals-badge.js`, `compliments.js` | 🔵 REBUILD                | Same.                                                                     |
| `public/css/buhlos.css`, `buhlos-admin.css`       | 🔵 REBUILD                | Tokens move to Tailwind config.                                            |
| `public/theme.css`                                | 🔵 REBUILD                | Same.                                                                     |
| `public/manifest.json`                            | 🔵 REBUILD                | `start_url` changes from `/my-day` to `/phil/my-day`.                     |
| `public/install.html`, `install-prompt.js`        | 🔵 REBUILD                | Becomes Next.js route + component.                                         |
| `public/sw.js`                                    | 🔵 REBUILD                | Keep push handling, drop shell cache.                                      |
| `public/dev/site-office/components.html`          | 🔴 DISCARD                | Deprecated naming.                                                         |
| `public/dev/components/index.html`                | 🔴 DISCARD                | Component playground replaced by proper tooling.                          |
| `public/BUHL_LOGO.png`, `logo.png`, `icon-*.png`, `icon.svg` | 🟢 KEEP        | Brand assets.                                                              |
| `scripts/check-admin-shell.js`                    | 🔴 DISCARD                | Concept gone (no SHELL.boot in Next.js).                                   |
| `scripts/check-sw-cache-version.js`               | 🔴 DISCARD                | Same.                                                                     |
| `scripts/check-production-shell.js`               | 🔵 REBUILD                | Concept (block wrong-build fingerprint) survives; check changes.          |
| `scripts/check-prod-branch.js`                    | 🔵 REBUILD                | Concept survives but GUARD_OVERRIDE escape goes.                          |
| `scripts/smoke-admin-routes.js`                   | 🔵 REBUILD                | Concept survives — Next.js route smoke tests replace it.                  |
| `scripts/make-icons.js`                           | 🟢 KEEP                   | Build-time icon generator.                                                |
| `scripts/migrate-hours.js`, `reset-pin.js`         | 🟡 ARCHIVE                | Move to `scripts/migrations/historical/`.                                 |
| `docs/deploy-checklist.md`                        | 🔵 REBUILD                | Rewrite for the rebuild's deploy story.                                    |
| `docs/regressions/admin-operations-blank.md`      | 🟢 KEEP                   | Carry forward as institutional memory.                                    |

---

## Cross-references

- Per-feature recommendations: [02-current-feature-inventory.md](02-current-feature-inventory.md)
- Route-level recommendations: [01-current-route-map.md](01-current-route-map.md)
- Data-layer recommendations: [03-data-model-audit.md](03-data-model-audit.md)
- Engineering rules that apply during the rebuild: [../architecture/00-rebuild-non-negotiables.md](../architecture/00-rebuild-non-negotiables.md)
