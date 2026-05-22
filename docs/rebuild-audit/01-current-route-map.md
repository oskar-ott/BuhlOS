# 01 · Current route map

Every route reachable in production. Source of truth: [vercel.json](../../vercel.json) rewrites + JS-side `location.href` redirects. Each row is verified against the file it references.

**Legend — status:**
- ✅ working — known good, used in current product
- 🟡 unclear — likely works but no smoke test
- ⚠️ duplicate — multiple routes go to the same file
- 🟠 legacy — old surface that should be retired but still reachable
- ❌ broken — known not to work (Phil signin endpoint mismatch, etc.)
- 🚫 deprecated naming — route name uses Switchboard / Site Office / legacy

**Legend — surface:**
- **A** = BuhlOS Admin (desktop / control plane)
- **P** = Phil (mobile / field)
- **L** = Leading Hand (field control)
- **C** = Client portal
- **PUB** = Public / login / install
- **API** = Vercel serverless function
- **DEV** = developer / internal surface
- **LEG** = legacy

---

## Root + login

| Route                       | File                                          | Surface | Status | Notes                                                                                                                                                                |
| --------------------------- | --------------------------------------------- | ------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                         | `public/login.html`                           | PUB     | ✅     | `vercel.json` last rewrite. Root must be the login, not the legacy Birdwood page (per regression doc).                                                                |
| `/login`                    | `public/login.html`                           | PUB     | ✅     | Explicit rewrite. Same file as `/`. The page itself contains the role → landing redirect after a successful POST `/api/auth?action=login`.                            |
| `/login.html`               | `public/login.html`                           | PUB     | ⚠️     | Direct file path. Duplicate of `/login`. Vercel will serve it from `public/` automatically without a rewrite. Should be inaccessible after rebuild.                   |
| `/install`                  | `public/install.html`                         | PUB     | 🟡     | "Add to Home Screen" instructions for the PWA.                                                                                                                        |
| `/manifest.json`            | `public/manifest.json`                        | PUB     | ⚠️     | PWA manifest. `start_url: "/my-day"` — points at the LEGACY tradie home, not `/phil`. Must change to `/phil` in rebuild.                                              |
| `/sw.js`                    | `public/sw.js`                                | PUB     | 🟡     | Service worker. `CACHE_VERSION='buhl-shell-v7'`. Caches admin shell files. Push handling for notifications. Will be retired or rewritten in rebuild.                  |

---

## BuhlOS Admin — `/admin/*`

| Route                                 | File                                          | Surface | Status | Notes                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------- | ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin`                              | `public/admin/index.html`                     | A       | ✅     | Tiny JS-redirect page. Calls `/api/auth?action=me` and redirects per role: admin → `/admin/operations`, leadingHand → `/lh`, tradie → `/my-day`, client → `/client`. |
| `/admin/`                             | `public/admin/index.html`                     | A       | ⚠️     | Trailing-slash alias.                                                                                                                                            |
| `/admin/operations`                   | `public/admin/operations.html`                | A       | ✅     | **The BuhlOS Command Centre SPA** — 3,246 lines, self-contained, own `boot()` (not `SHELL.boot`). The current canonical admin surface. Has its own role gate (`ADMIN_ROLES`). |
| `/admin/approvals`                    | `public/admin/approvals.html`                 | A       | ✅     | Uses `_shell.js` (multi-page shell). Hours approval queue.                                                                                                       |
| `/admin/snags`                        | `public/admin/snags.html`                     | A       | ✅     | Uses `_shell.js`. Snag triage list.                                                                                                                              |
| `/admin/jobs`                         | `public/admin/jobs.html`                      | A       | ✅     | Uses `_shell.js`. Jobs list with row → detail.                                                                                                                   |
| `/admin/jobs/:jobId`                  | `public/admin/job.html`                       | A       | ✅     | Uses `_shell.js`. Per-job admin record (4,769 lines — the largest single page).                                                                                  |
| `/admin/job-builder`                  | `public/admin/job-builder.html`               | A       | 🟡     | Uses `_shell.js`. v1 — partial. Also appears as a section inside `/admin/operations` SPA.                                                                        |
| `/admin/itp`                          | `public/admin/itp.html`                       | A       | 🟡     | Uses `_shell.js`. ITP / QA. v1 — partial.                                                                                                                        |
| `/admin/plans`                        | `public/admin/plans.html`                     | A       | 🟡     | Uses `_shell.js`. Plans & docs. v1 — partial. Upload UC.                                                                                                         |
| `/admin/variations`                   | `public/admin/variations.html`                | A       | 🟡     | Uses `_shell.js`. v1 — partial.                                                                                                                                  |
| `/admin/reports`                      | `public/admin/reports.html`                   | A       | 🟡     | Uses `_shell.js`. Computed metrics + Builder performance.                                                                                                        |
| `/admin/quotes`                       | `public/admin/quotes.html`                    | A       | 🟡     | Uses `_shell.js`. Quote list. Operations SPA marks Quotes as `uc`/`soon`.                                                                                        |
| `/admin/quotes/:quoteId`              | `public/admin/quote.html`                     | A       | 🟡     | Per-quote (1,546 lines).                                                                                                                                         |
| `/admin/hours`                        | `public/admin/hours.html`                     | A       | ✅     | Uses `_shell.js`. Hours & costs view. Part of the only end-to-end loop.                                                                                          |
| `/admin/crew`                         | `public/admin/crew.html`                      | A       | ✅     | Uses `_shell.js`. People / crew management.                                                                                                                      |
| `/admin/suppliers`                    | `public/admin/suppliers.html`                 | A       | 🟡     | Uses `_shell.js`.                                                                                                                                                 |
| `/admin/temps`                        | `public/admin/temps.html`                     | A       | 🟡     | Uses `_shell.js`. Temp boards.                                                                                                                                   |
| `/admin/settings`                     | `public/admin/settings.html`                  | A       | ✅     | Uses `_shell.js`.                                                                                                                                                 |
| `/admin/support`                      | `public/admin/support.html`                   | A       | 🟡     | Uses `_shell.js`. Access requests + password resets.                                                                                                             |
| `/admin/assets`                       | `public/admin/assets.html`                    | A       | 🟡     | Uses `_shell.js`. Gear/tool register.                                                                                                                            |
| `/admin/activity`                     | `public/admin/activity.html`                  | A       | 🟡     | Uses `_shell.js`. Audit-log-like activity stream.                                                                                                                |
| `/admin/materials`                    | `public/admin/materials.html`                 | A       | 🟡     | Uses `_shell.js`.                                                                                                                                                 |
| `/admin/cash`                         | `public/admin/cash.html`                      | A       | 🟡     | Uses `_shell.js`. Cash & margin (admin-only).                                                                                                                    |

**Notable:** Every `/admin/<x>` HTML file ends with `SHELL.boot()` *except* `operations.html` which has its own self-contained `boot()`. This is enforced by `scripts/check-admin-shell.js`.

---

## `/buhlos/*` mirror routes (DUPLICATES of `/admin/*`)

`vercel.json` defines 22 `/buhlos/*` rewrites pointing at the same files as `/admin/*`. There is no functional difference; both URLs hit the same `_shell.js` and the same per-page file.

| Route pattern                       | Destination                            | Surface | Status | Notes                                                                |
| ----------------------------------- | -------------------------------------- | ------- | ------ | ------------------------------------------------------------------- |
| `/buhlos`                           | `/login.html`                          | PUB     | ⚠️     | Alias for `/login`. No product reason.                              |
| `/buhlos/login`                     | `/login.html`                          | PUB     | ⚠️     | Alias for `/login`.                                                  |
| `/buhlos/admin`                     | `/admin/index.html`                    | A       | ⚠️     | Alias for `/admin`.                                                  |
| `/buhlos/admin/operations`          | `/admin/operations.html`               | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/approvals`           | `/admin/approvals.html`                | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/snags`               | `/admin/snags.html`                    | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/jobs`                | `/admin/jobs.html`                     | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/jobs/:jobId`         | `/admin/job.html`                      | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/job-builder`         | `/admin/job-builder.html`              | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/itp`                 | `/admin/itp.html`                      | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/plans`               | `/admin/plans.html`                    | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/variations`          | `/admin/variations.html`               | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/reports`             | `/admin/reports.html`                  | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/quotes`              | `/admin/quotes.html`                   | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/quotes/:quoteId`     | `/admin/quote.html`                    | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/hours`               | `/admin/hours.html`                    | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/crew`                | `/admin/crew.html`                     | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/suppliers`           | `/admin/suppliers.html`                | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/temps`               | `/admin/temps.html`                    | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/settings`            | `/admin/settings.html`                 | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/support`             | `/admin/support.html`                  | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/assets`              | `/admin/assets.html`                   | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/activity`            | `/admin/activity.html`                 | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/materials`           | `/admin/materials.html`                | A       | ⚠️     | Alias.                                                                |
| `/buhlos/admin/cash`                | `/admin/cash.html`                     | A       | ⚠️     | Alias.                                                                |
| `/buhlos/jobs`                      | `/admin/jobs.html`                     | A       | ⚠️     | Alias.                                                                |
| `/buhlos/jobs/:jobId`               | `/admin/job.html`                      | A       | ⚠️     | Alias.                                                                |

**Recommendation:** Discard all `/buhlos/*` routes in rebuild. The canonical product URL is `buhlapp.xyz` (preview) / `buhlos.com` (prod); the `/admin/*` prefix is sufficient.

---

## Phil — `/phil*` + parallel surfaces

| Route                | File                          | Surface | Status                          | Notes                                                                                                                                                            |
| -------------------- | ----------------------------- | ------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/phil`              | `public/phil.html`            | P       | 🟡 mock-only                    | The new Phil mobile app (1,625 lines). Uses **MOCK data** (`const MOCK_JOBS`, `MOCK_AREAS`, `MOCK_TASKS`). Calls `/api/auth?action=signin` and `signout` — **these endpoints do not exist**; `api/auth.js` only handles `login`/`logout`. Login form is broken. |
| `/phil/app`          | `public/phil.html`            | P       | ⚠️                              | Alias.                                                                                                                                                            |
| `/phil/login`        | `public/login.html`           | P       | ⚠️                              | Routes via shared login. No Phil-specific login.                                                                                                                  |
| `/my-day`            | `public/my-day.html`          | P (LEG) | 🟠 legacy                       | LEGACY tradie home (2,179 lines). **Still the manifest `start_url`** and **still the post-login redirect target for tradie role** (login.html `landingFor()`). |
| `/my-gear`           | `public/my-gear.html`         | P (LEG) | 🟠 legacy                       | LEGACY gear page for tradies.                                                                                                                                     |
| `/phil-hours`        | `public/phil-hours.html`      | P (LEG) | 🟠 legacy                       | Standalone hours-logging page. Mentioned by name in title. Phil app should subsume this.                                                                          |
| (file) `/phil.html`  | `public/phil.html`            | P       | ⚠️                              | Direct file path used by `phil.html` itself at signout: `window.location.href = '/phil.html'`. Bypasses `/phil` route. Should be removed in rebuild.              |

**Phil naming summary:** The Phil branding is in place inside `phil.html` (logo SVG, title "Phil", body text). But:
1. The PWA's `start_url` is `/my-day`.
2. Tradies are redirected to `/my-day` on login.
3. The current `phil.html` still says "Site Office portal" / "Go to Site Office" in the client-blocking screen.
4. The Phil login form hits a non-existent endpoint.

Phil is not the worker's actual landing.

---

## Leading Hand — `/lh*`

| Route       | File                  | Surface | Status | Notes                                                                                                          |
| ----------- | --------------------- | ------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `/lh`       | `public/lh-home.html` | L       | 🟡     | Leading Hand home — 1,502 lines. Separate from admin shell and from Phil. "Field Control / Leading Hand Home". |
| `/lh-home`  | `public/lh-home.html` | L       | ⚠️     | Alias for `/lh`.                                                                                               |

**Note:** Leading Hand sits in an awkward middle-ground — neither admin (`_shell.js`) nor Phil (`phil.html`). The rebuild should decide whether LH lives inside Admin (with reduced scope) or Phil (with elevated permissions). Right now it's a third surface.

---

## Client portal — `/client*`

| Route                    | File                | Surface | Status | Notes                                                  |
| ------------------------ | ------------------- | ------- | ------ | ------------------------------------------------------ |
| `/client`                | `public/client.html`| C       | 🟡     | Per-job client read-only view (21KB, single page).      |
| `/client/jobs/:jobId`    | `public/client.html`| C       | 🟡     | Alias — same file reads job from `location.pathname`.  |

---

## Legacy `/jobs*` + `/project*`

| Route                    | File                  | Surface | Status                       | Notes                                                                                                              |
| ------------------------ | --------------------- | ------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/jobs`                  | `/admin/jobs.html`    | A       | ⚠️ duplicate                | Same as `/admin/jobs`. No product reason for the bare-`/jobs` alias.                                              |
| `/jobs/:jobId`           | `/project.html`       | LEG     | 🟠 legacy                   | Routes to the LEGACY `public/project.html` (9,599 lines!) — the old per-job page. `/admin/jobs/:jobId` goes elsewhere. |
| `/jobs/:jobId/log-hours` | `/project.html`       | LEG     | 🟠 legacy                   | Same legacy page. Hours-logging deep-link.                                                                          |
| `/project.html`          | `/project.html`       | LEG     | 🟠 legacy                   | Direct file. The largest single HTML file in the repo.                                                              |
| `/admin-legacy`          | `/admin.html`         | LEG     | 🟠 legacy                   | Legacy 8,180-line admin. Reachable but should be deleted in rebuild.                                                |
| `/admin.html`            | `/admin.html`         | LEG     | 🟠 legacy                   | Direct file path to the legacy admin.                                                                               |

---

## Field worker entry points

| Route        | File                 | Surface | Status | Notes                                            |
| ------------ | -------------------- | ------- | ------ | ------------------------------------------------ |
| `/my-day`    | `public/my-day.html` | P (LEG) | 🟠     | See Phil block above.                            |
| `/my-gear`   | `public/my-gear.html`| P (LEG) | 🟠     | See Phil block above.                            |
| `/approvals` | `/admin/approvals.html` | A    | ⚠️ duplicate | Same as `/admin/approvals`. Bare alias.       |
| `/overview`  | `/admin/operations.html` | A   | ⚠️ duplicate | Same as `/admin/operations`. Bare alias.      |

---

## Deprecated naming — `/dev/site-office*` 🚫

| Route                          | File                                       | Surface | Status                       | Notes                                                                                                |
| ------------------------------ | ------------------------------------------ | ------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `/dev/site-office`             | `public/dev/site-office/components.html`   | DEV     | 🚫 deprecated naming        | Discovery surface using DEPRECATED "Site Office" name. Per [[project_buhlos_phil_naming]] this must go. |
| `/dev/site-office/components`  | `public/dev/site-office/components.html`   | DEV     | 🚫 deprecated naming        | Same.                                                                                                |
| `/dev/components`              | `public/dev/components/index.html`         | DEV     | 🟡                          | Component playground. Acceptable naming but should be retired or replaced by Storybook in rebuild.   |

---

## API routes — `/api/*` (89 endpoints)

These are Vercel serverless functions in `api/*.js`. All require the `buhl_session` cookie unless noted. Each file = one route. Full list below; deep dive of each endpoint is in [02-current-feature-inventory.md](02-current-feature-inventory.md) and [03-data-model-audit.md](03-data-model-audit.md).

**Auth + users:**
- `/api/auth` — login, logout, me, change-password (the `?action=` query param dispatches; **Phil app calls `?action=signin` which does not exist** — Phil signin is broken)
- `/api/users` — CRUD users (admin); also `?action=listTradies`, `?action=createClient`, `?action=sweep` (cron)
- `/api/access-requests`, `/api/password-resets`, `/api/notification-prefs`
- `/api/user-activity`, `/api/my-stats`

**Jobs + setup:**
- `/api/jobs`, `/api/job-types`, `/api/job-areas`, `/api/job-audit`, `/api/job-circuits`, `/api/job-draft`, `/api/job-glance`, `/api/job-itps`, `/api/job-quick-actions`, `/api/job-templates`, `/api/job-timeline`, `/api/jobs-bulk-edit`, `/api/jobs-export`

**Data per job:**
- `/api/data` (full-replacement writes for `dwellings + snags + notes`)
- `/api/area-detail`

**Crew:**
- `/api/crew`, `/api/crew-export`, `/api/crew-utilization`

**Hours / timesheets:**
- `/api/hours` (legacy format)
- `/api/time-entries` (new format; submit, approve, reject, reopen, bulk-approve, bulk-reject, export, recent-jobs, on-site, overview)
- `/api/compare-weeks`, `/api/log-hours-template`, `/api/payroll-reminder`, `/api/payroll-runs`

**Snags:**
- `/api/snags-all`, `/api/snags-mine`, `/api/snags-export`, `/api/snags-bulk-close`
- `/api/snag-stats`, `/api/snag-duplicates`, `/api/snag-quick-raise`, `/api/snag-quick-close`, `/api/snag-email`, `/api/snag-notify`
- `/api/my-job-snags`

**Photos + plans + ITPs:**
- `/api/photos`, `/api/photos-catalog`
- `/api/plans`
- `/api/itp-templates`

**Materials + suppliers:**
- `/api/materials-list`, `/api/materials-summary`
- `/api/suppliers`, `/api/supplier-lookup`, `/api/supplier-products`, `/api/wholesalers`

**Assets/temps:**
- `/api/assets`, `/api/temps`, `/api/tags`, `/api/tags-expiring`

**Quotes:**
- `/api/quotes`, `/api/quote-documents`, `/api/quote-stats`

**Costs + cash:**
- `/api/costs`, `/api/cash-watch`, `/api/handover-readiness`, `/api/hot-areas`

**Operational + reporting:**
- `/api/operations` (not found in this scan — likely embedded in shell fetches)
- `/api/admin-stats`, `/api/today-pulse`, `/api/weekly-report`
- `/api/data-quality`, `/api/search`, `/api/site-visits`, `/api/activity`
- `/api/contacts`, `/api/policy`, `/api/task-toggle`

**Notifications + push:**
- `/api/notifications`, `/api/push-test`

**Client view:**
- `/api/client-jobs-summary`, `/api/client-update`

---

## Cron-triggered endpoints (from `vercel.json` `crons`)

| Endpoint                                                | Schedule           | Notes                                                                          |
| ------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `/api/notifications?action=send-daily-reminders`        | `30 5 * * 1-5`     | 05:30 weekdays — push reminders.                                              |
| `/api/notifications?action=send-tag-reminders`          | `0 22 * * 0`       | 22:00 Sunday.                                                                  |
| `/api/notifications?action=send-daily-digest`           | `0 7 * * 1-5`      | 07:00 weekdays.                                                                |
| `/api/notifications?action=send-stale-snags`            | `0 23 * * 0`       | 23:00 Sunday.                                                                  |
| `/api/notifications?action=send-inactive-users`         | `0 23 * * 1`       | 23:00 Monday.                                                                  |
| `/api/cash-watch?action=check-overruns`                 | `30 22 * * *`      | Nightly.                                                                       |
| `/api/users?action=sweep`                               | `0 19 * * *`       | Nightly.                                                                       |

**Risk:** these crons fire against whatever data shape exists in Blob. Any rebuild that changes the shape can silently break them. Inventory + freeze them before changing data structures.

---

## Conflicts and duplicates summary

| Conflict                                              | Routes involved                                                       | Resolution proposed                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Same file served from multiple URLs                  | `/admin/<x>` and `/buhlos/admin/<x>` (× 22)                           | Drop `/buhlos/*` entirely in rebuild.                                          |
| Same file served from bare and prefixed URL          | `/jobs` and `/admin/jobs` both → `/admin/jobs.html`                   | Drop bare `/jobs`. Bare `/jobs/:id` goes elsewhere — confusing.                |
| Same file served from bare and prefixed URL          | `/approvals` and `/admin/approvals` both → `/admin/approvals.html`    | Drop bare `/approvals`.                                                        |
| Same file served from bare and prefixed URL          | `/overview` and `/admin/operations` both → `/admin/operations.html`   | Drop `/overview`.                                                              |
| Two surfaces for tradies                             | `/phil` (new) and `/my-day` (legacy)                                  | `/phil` canonical. Migrate manifest + login redirect.                          |
| Three Phil entry points                              | `/phil`, `/my-day`, `/my-gear`, `/phil-hours`                         | All collapse into `/phil/*` sub-routes inside the rebuild.                      |
| Two admin entry points                               | `/admin/operations` (SPA) and `/admin/<x>` (multi-page shell)         | Pick one. SPA pattern is closer to where the rebuild lands; multi-page retires. |
| Legacy admin still reachable                         | `/admin-legacy` → `admin.html`                                        | Delete file + route in rebuild.                                                |
| Legacy per-job page still reachable                  | `/jobs/:jobId` → `project.html`                                       | Delete file + route in rebuild.                                                |
| Deprecated naming in URL                             | `/dev/site-office`, `/dev/site-office/components`                     | Delete both routes and the underlying `public/dev/site-office/` folder.        |

---

## Cross-references

- Vercel rewrite source: `vercel.json`
- Login routing logic: `public/login.html:736-762` (`landingFor()`)
- Admin entry redirect logic: `public/admin/index.html:16-30`
- Operations SPA role gate: `public/admin/operations.html:1541-1625` (`ADMIN_ROLES` / `LEADING_HAND_ROLES` / `FIELD_ROLES` / `CLIENT_ROLES`)
- Phil client-blocking screen: `public/phil.html:1542-1551`
- Static smoke test: `scripts/smoke-admin-routes.js`
- Blank-page regression history: `docs/regressions/admin-operations-blank.md`
