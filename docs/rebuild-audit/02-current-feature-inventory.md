# 02 · Current feature inventory

Every visible or implied feature, grouped by surface (BuhlOS Admin vs Phil).

**Legend — recommendation:**
- 🟢 **KEEP** — carry forward roughly as-is, just port to new shell.
- 🔵 **REBUILD** — concept is right, implementation is replaced.
- 🟡 **PARK** — keep the data but hide UI behind `UNDER CONSTRUCTION` until the loop matures.
- 🔴 **DISCARD** — code/UI/data that should not exist in the new world.

**Legend — state:**
- ✅ functional — wired to real API, used in production
- 🟡 partial — UI exists but some flows are mocked, missing approval/audit/etc.
- 🔶 mock-only — UI exists but data comes from `window.BUHLOS_MOCK` or Phil's local `MOCK_*` constants
- ❌ broken — code is present but doesn't work (wrong endpoint, missing dependency)

---

## BuhlOS Admin

The admin surface today has two interleaved shells:
- **Command Centre SPA** at `/admin/operations` (`operations.html` — 3,246 lines, self-contained).
- **Multi-page `_shell.js`** at every other `/admin/*` route (sidebar shared, page bodies separate).

Both display the same nav items in different ways. Below, each feature is named once and its locations noted.

### Command centre / dashboard 🟢 KEEP (rebuild shell)

- **Files:** `public/admin/operations.html` (the canonical SPA); shell's `today` / "Command centre" section also appears at `/admin/operations` via `_shell.js`.
- **State:** 🟡 partial. KPIs (Active jobs, Pending timesheets, Open alerts, Crew on site) wire to real APIs (`/api/jobs`, `/api/time-entries?status=submitted&scope=approver`, `/api/snags-all?status=Open`, `/api/users`). Alerts list, Quick actions, Today panel — partly real, partly mock when the API returns empty (uses `window.BUHLOS_MOCK` fallback).
- **Mock fallback:** Loaded from `public/admin/admin-data.js` (321 lines of mock jobs, workers, ITPs, plans, variations).
- **Bug:** No visible marker distinguishing mock-from-API. Admin can act on mock jobs ("Birdwood IV3232", "Arthur St Warehouse") thinking they're real.
- **Recommendation:** Concept keeps. Shell rebuilds. Mock data moves into typed fixtures with explicit "DEMO MODE" marker.

### Jobs (admin) 🔵 REBUILD

- **Files:** `public/admin/jobs.html` (list); `public/admin/job.html` (detail — 4,769 lines, the single largest page); operations.html has a Jobs section too.
- **APIs:** `/api/jobs`, `/api/job-areas`, `/api/job-circuits`, `/api/job-glance`, `/api/job-itps`, `/api/job-quick-actions`, `/api/job-templates`, `/api/job-timeline`, `/api/job-audit`, `/api/jobs-bulk-edit`, `/api/jobs-export`.
- **State:** ✅ functional. The most-developed admin feature. Backed by `jobs.json` in Blob.
- **Bugs / drift:** `job.html` is 4,769 lines of inline code. Adding a single field touches the entire page. No shared schema.
- **Recommendation:** Rebuild in new shell with `src/domains/jobs/` owning schema, fixtures, and components. Backend `api/jobs.js` stays.

### Job Builder 🟡 PARK then 🔵 REBUILD

- **Files:** `public/admin/job-builder.html` (745 lines); also a `builder` section in `operations.html` (renderJobBuilder).
- **APIs:** `/api/job-templates`, `/api/job-draft`, `/api/jobs (POST)`.
- **State:** 🟡 partial — marked `v1` in the sidebar. Operations SPA's "+ New job" button currently `alert()`s "Job creation lives in the legacy admin while Job Builder is under construction".
- **Bug:** Two implementations of the same feature (multi-page + SPA).
- **Recommendation:** Hide behind `UNDER CONSTRUCTION` in old shell; rebuild as the canonical job-creation flow in the new shell.

### Hours / timesheets 🟢 KEEP (end-to-end loop)

- **Files:** `public/admin/hours.html` (admin view, 694 lines), `public/admin/approvals.html` (admin approval queue), `public/phil-hours.html` (legacy Phil hours), `public/my-day.html` (legacy tradie home with hours sheet), `public/log-hours-sheet.js` (38KB shared modal).
- **APIs:** `/api/hours` (legacy), `/api/time-entries` (canonical), `/api/time-entries-approve`, `/api/time-entries-reject`, `/api/time-entries-reopen`, `/api/time-entries-bulk-approve`, `/api/time-entries-bulk-reject`, `/api/time-entries-export`, `/api/time-entries-overview`, `/api/time-entries-on-site`, `/api/time-entries-recent-jobs`.
- **State:** ✅ functional, **the only end-to-end loop** in the product per [[project_buhlos_phil_hours_pipeline]]. Phil/my-day captures → admin sees in approvals queue → admin approves/rejects → audit log.
- **Bug:** Two formats coexist (`/api/hours` legacy crew-string format and `/api/time-entries` userId format). Two Phil-side capture paths (`/my-day` modal and `/phil-hours` standalone).
- **Recommendation:** Treat this as the **reference loop** for the rebuild. Port carefully — do not change behaviour. Schema is documented in `OVERVIEW.md`.

### Workers / crew / people 🟢 KEEP

- **Files:** `public/admin/crew.html` (609 lines).
- **APIs:** `/api/users`, `/api/users?action=listTradies`, `/api/crew`, `/api/crew-export`, `/api/crew-utilization`.
- **State:** ✅ functional. CRUD on users, hourly rates, job assignments.
- **Recommendation:** Port concept; rebuild UI. Backend stays. Add typed schema for User/WorkerProfile split (see [03-data-model-audit.md](03-data-model-audit.md)).

### Gear / assets register 🔵 REBUILD

- **Files:** `public/admin/assets.html` (358 lines), `public/admin/temps.html` (195 lines), `public/my-gear.html` (16KB).
- **APIs:** `/api/assets`, `/api/temps`, `/api/tags`, `/api/tags-expiring`.
- **State:** 🟡 partial. Admin can list assets and assign holders; calibration / expected-return tracked. Overdue detection in sidebar badge. Worker side (`/my-gear`) is read-only.
- **Bugs:** No QR scanning, no scan log, no formal hand-back flow. "Temps" and "Tags" are separate concepts that overlap (both track field hardware).
- **Recommendation:** Unify Temps + Tags + Assets into a single GearAsset / GearAssignment / GearScan model. Rebuild Phil-side as scan-driven (per Loop 2 in [00-core-operational-loops.md](../product/00-core-operational-loops.md)).

### Materials 🟡 PARK then 🔵 REBUILD

- **Files:** `public/admin/materials.html` (351 lines); operations.html `materials` section.
- **APIs:** `/api/materials-list`, `/api/materials-summary`.
- **State:** 🔶 mock-only in operations.html. The per-page `/admin/materials` reads from API but the data is largely stub.
- **Recommendation:** Park. The full Materials loop (request → order → deliver → consume) is not built. Hide in Phil; show admin-side as `UNDER CONSTRUCTION` for now.

### ITP / QA 🟡 PARK then 🔵 REBUILD

- **Files:** `public/admin/itp.html` (538 lines); operations.html `itp` section (`renderITPs`, 226+ lines of rendering).
- **APIs:** `/api/itp-templates`, `/api/job-itps`.
- **State:** 🟡 partial — `v1` in sidebar. Independent-reviewer rule (`itp_review_self`) coded but not end-to-end. `needs_info` status exists but flow incomplete.
- **Recommendation:** Park until rebuild can support the full ITP loop (template → checkpoint → evidence → review → signoff → handover-readiness). The existing data shapes are useful starting points.

### RFIs / requests 🔴 DISCARD (then 🔵 REBUILD as a fresh feature)

- **Files:** none. There is no RFI feature today.
- **APIs:** none.
- **State:** Not built. Snags (defects) are the closest existing concept.
- **Recommendation:** Add as a new domain (`src/domains/rfis/`) in the rebuild.

### Defects / snags 🟢 KEEP

- **Files:** `public/admin/snags.html` (319 lines), `public/admin/job.html` snag section, `public/my-day.html` snag-raise sheet.
- **APIs:** `/api/snags-all`, `/api/snags-mine`, `/api/snags-export`, `/api/snags-bulk-close`, `/api/snag-stats`, `/api/snag-duplicates`, `/api/snag-quick-raise`, `/api/snag-quick-close`, `/api/snag-email`, `/api/snag-notify`, `/api/my-job-snags`.
- **State:** ✅ functional. Worker raises snag from Phil/my-day; admin sees in triage; resolve flow works.
- **Recommendation:** Carry forward. Treat as the model for the RFI loop.

### Plans / documents 🟡 PARK then 🔵 REBUILD

- **Files:** `public/admin/plans.html` (377 lines); operations.html `plans` section.
- **APIs:** `/api/plans`.
- **State:** 🟡 partial — `v1` in sidebar. Plan upload is `UNDER CONSTRUCTION` (`alert()`s in operations.html). Drawing #, type, area/stage linking, Phil-readiness toggle all defined in shapes but not all wired.
- **Recommendation:** Park UI; keep schema. Plans need worker-side acknowledgement (`PlanAcknowledgement`) which doesn't exist yet.

### Reports 🟡 PARK

- **Files:** `public/admin/reports.html` (438 lines); operations.html `reports` section.
- **APIs:** `/api/weekly-report`, `/api/admin-stats`, `/api/today-pulse`, `/api/compare-weeks`.
- **State:** 🟡 partial. Sidebar marks Reports as `soon`. Some real metrics, some UC tiles.
- **Recommendation:** Park. Build reports last, once the underlying loops produce reliable data.

### Settings 🟢 KEEP

- **Files:** `public/admin/settings.html` (222 lines).
- **APIs:** `/api/auth?action=change-password`, `/api/notification-prefs`.
- **State:** ✅ functional. Password change, notification prefs.
- **Recommendation:** Keep concept. Rebuild UI on new shell. Add org-level settings (was missing).

### Integrations 🔴 DISCARD (no real implementation)

- **Files:** No integrations folder. `package.json` includes `@anthropic-ai/sdk` (unused at the UI layer), `@vercel/blob`, `web-push`. No Xero/MYOB/QBO integration despite `crew.html` storing Xero IDs.
- **APIs:** `/api/push-test` (web push only).
- **State:** Not built.
- **Recommendation:** Defer integration work until after MVP loops are stable.

### Quotes 🟡 PARK

- **Files:** `public/admin/quotes.html` (268 lines), `public/admin/quote.html` (1,546 lines), `api/quotes.js` (71KB!), `api/quote-documents.js`, `api/quote-stats.js`.
- **APIs:** `/api/quotes`, `/api/quote-documents`, `/api/quote-stats`.
- **State:** 🟡 partial — sidebar marks as `soon`. Backend is enormous (71KB single file) but UI is incomplete. Operations SPA marks Quotes as UC.
- **Recommendation:** Park. The quote model is real and substantial but not central to the field-operations rebuild. Re-enter as a separate phase.

### Variations 🟡 PARK

- **Files:** `public/admin/variations.html` (398 lines); operations.html `variations` section.
- **APIs:** none dedicated; embedded in jobs.
- **State:** 🟡 partial. `v1` in sidebar. Creation modal, invoiced status, source/builder-ref.
- **Recommendation:** Park until variation is a first-class entity (`Variation` in target schema).

### Cash / margin 🟡 PARK

- **Files:** `public/admin/cash.html` (456 lines).
- **APIs:** `/api/cash-watch`, `/api/costs`.
- **State:** 🟡 partial. Admin-only. Cash-watch is a nightly cron.
- **Recommendation:** Park. Depends on accurate hours + materials data which is not yet end-to-end.

### Suppliers 🟡 PARK

- **Files:** `public/admin/suppliers.html` (642 lines).
- **APIs:** `/api/suppliers`, `/api/supplier-lookup`, `/api/supplier-products`, `/api/wholesalers`.
- **State:** 🟡 partial.
- **Recommendation:** Park.

### Support 🟢 KEEP (admin only)

- **Files:** `public/admin/support.html` (242 lines).
- **APIs:** `/api/access-requests`, `/api/password-resets`.
- **State:** ✅ functional. Open access requests + password reset requests in one inbox.
- **Recommendation:** Keep. Rebuild on new shell.

### Activity log 🟢 KEEP

- **Files:** `public/admin/activity.html` (267 lines).
- **APIs:** `/api/activity`, `/api/user-activity`.
- **State:** ✅ functional. Activity stream from `_lib/activity.js`.
- **Recommendation:** Keep. Becomes `AuditLog` in target schema.

### Search 🟡 PARK

- **Files:** Command palette in admin (`public/components/cmd-palette.js`). `api/search.js`.
- **APIs:** `/api/search`.
- **State:** 🟡 partial.
- **Recommendation:** Park; rebuild as a cross-domain search in new shell.

---

## Phil (mobile field-worker)

The Phil surface is more fractured than admin. Three parallel surfaces all serve roughly the same audience:

1. **`/phil`** → `phil.html` — the *new* Phil mobile app with its own login screen, Today / Jobs / Gear / Snag / More tabs.
2. **`/my-day`** → `my-day.html` — the *legacy* tradie home; **still the PWA `start_url`** and the **login.html post-login redirect target for tradies**.
3. **`/phil-hours`** + **`/my-gear`** — standalone single-purpose pages from the older era.

### Phil — login 🔴 DISCARD (currently broken)

- **File:** `phil.html` shows its own login screen via `showLoginScreen()`.
- **API called:** `/api/auth?action=signin` and `/api/auth?action=signout` — **these actions do not exist in `api/auth.js`**, which only handles `login`, `logout`, `me`, `change-password`. Phil login is BROKEN.
- **State:** ❌ broken. Phil's "Sign in" button posts to a 404.
- **Recommendation:** Discard the in-file login. Use the same `/login.html` → `/api/auth?action=login` path the rest of the app uses. The rebuild has one login.

### Phil — Today / My Day 🔵 REBUILD

- **Files:** `phil.html` Today tab (`renderToday`); `my-day.html` standalone page (2,179 lines).
- **APIs:** `/api/today-pulse`, `/api/time-entries`, `/api/jobs`, `/api/my-job-snags`, `/api/my-stats`.
- **State:** 🟡 partial in `phil.html` (mock data). ✅ functional in `my-day.html`.
- **Recommendation:** Rebuild as `/phil/my-day` in the new shell. Migrate manifest `start_url` from `/my-day` to `/phil/my-day`. Standard-day button (7h 36m) per [[project_buhlos_phil_hours_pipeline]].

### Phil — Hours 🟢 KEEP (rebuild UI)

- **Files:** Hours sheet in `phil.html` (`renderHours` etc.); `phil-hours.html` standalone; `log-hours-sheet.js` shared modal.
- **APIs:** `/api/time-entries` (POST).
- **State:** ✅ functional via `my-day` / `phil-hours` / `log-hours-sheet`.
- **Recommendation:** This is the core of the hours loop. Port to new shell, keep schema.

### Phil — My Gear 🔵 REBUILD

- **Files:** Gear tab in `phil.html` (`renderGear`); `my-gear.html` standalone.
- **APIs:** `/api/assets`.
- **State:** 🟡 partial. Read-only list of assigned gear with kind/expectedReturn.
- **Recommendation:** Rebuild as scan-driven gear management. See Loop 2 in [00-core-operational-loops.md](../product/00-core-operational-loops.md).

### Phil — Jobs 🔵 REBUILD

- **Files:** Jobs tab in `phil.html` (`renderJobs`).
- **APIs:** `/api/jobs`.
- **State:** 🔶 mock-only.
- **Recommendation:** Wire to real API. Jobs visible to a worker = jobs where they're in `assignedJobIds`.

### Phil — Individual job interface 🔵 REBUILD

- **Files:** `phil.html` `openJob()` (areas → tasks).
- **APIs:** `/api/data`, `/api/area-detail`, `/api/job-areas`.
- **State:** 🔶 mock-only in phil.html.
- **Recommendation:** Rebuild. Worker sees stages → areas → tasks. Each task can require evidence (photo).

### Phil — Task completion 🔵 REBUILD

- **Files:** `phil.html` task selectors (Not started / In progress / Ready / Done).
- **APIs:** `/api/data` (full-document replacement) or `/api/task-toggle`.
- **State:** 🔶 mock-only.
- **Bug:** Full-document replacement is dangerous with concurrent writes.
- **Recommendation:** Rebuild to use `/api/task-toggle` (single-task PATCH) — already exists but unused by Phil.

### Phil — Photo / evidence capture 🔵 REBUILD

- **Files:** `phil.html` references but flow incomplete; `my-day.html` and `project.html` (legacy) had photo uploads.
- **APIs:** `/api/photos` (base64 dataUrl upload).
- **State:** 🟡 partial. The upload endpoint works but Phil UI doesn't yet require evidence per task.
- **Recommendation:** Build evidence-required tasks (Loop 3 in core loops).

### Phil — ITP / checklists 🔴 NOT BUILT

- **State:** Phil-side ITP completion does not exist.
- **Recommendation:** Build new. Major piece of the rebuild MVP.

### Phil — RFIs / requests 🔴 NOT BUILT

- **State:** Phil-side RFI raising does not exist. Snag raise is the closest analogue.
- **Recommendation:** Build new (Loop 5).

### Phil — QR scanning 🔴 NOT BUILT

- **State:** Not built.
- **Recommendation:** Build new for gear / area / job scan (Loop 2).

### Phil — Snag raise 🟢 KEEP

- **Files:** `phil.html` snag sheet (`saveSnag`); `my-day.html` snag sheet.
- **APIs:** `/api/snag-quick-raise` — exists.
- **Bug:** `phil.html:1524` has a TODO comment "POST to /api/snags (not yet built)" — endpoint *is* built (`/api/snag-quick-raise`); Phil just doesn't call it.
- **Recommendation:** Wire Phil to the existing endpoint.

### Phil — More / profile 🟢 KEEP

- **Files:** `phil.html` `renderMore()`.
- **State:** ✅ functional (read-only).

---

## Cross-cutting features

### Cron jobs (notifications + sweep) 🟢 KEEP

- See [01-current-route-map.md](01-current-route-map.md) cron section.
- All wire to real data. Daily push reminders, weekly digests, snag/inactive-user nudges.
- **Recommendation:** Keep. Rebuild needs to inventory cron output shapes before changing data structures.

### Service worker 🔵 REBUILD

- **File:** `public/sw.js`.
- **Features:** Push notifications + install prompt + admin shell cache (stale-while-revalidate).
- **Bug:** The shell cache adds an extra failure mode (`v2 → v3 → v4 → v5 → v6 → v7` bumps in 2 weeks).
- **Recommendation:** Keep push handling. Drop admin shell caching — Next.js handles its own caching.

### Install prompt 🟢 KEEP

- **File:** `public/install-prompt.js`, `public/install.html`.
- **Recommendation:** Port to new shell.

### Theme / brand 🔵 REBUILD

- **Files:** `public/theme.css` (44KB), `public/css/buhlos.css`, `public/css/buhlos-admin.css`, plus per-page `<style>` blocks.
- **Recommendation:** Rebuild as Tailwind config tokens. See [05-04-ui-ux-audit.md](04-ui-ux-audit.md).
