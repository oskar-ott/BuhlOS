# 01 · MVP rebuild scope

The first buildable slice of the rebuild. Four phases, each with a clear exit criterion. Anything not listed here is **`UNDER CONSTRUCTION`** until its phase arrives.

Phases are built in order. A phase is "done" when its acceptance criteria pass on a preview URL with a non-author human verifying. Only then does the next phase begin.

---

## Phase A — Clean app shell

**Goal:** stand up a new Next.js + TS + Tailwind app in this repo, render an empty admin shell and an empty Phil shell, wire one login flow. No features yet.

### Scope

- [ ] New deps in `package.json`: `next`, `react`, `react-dom`, `typescript`, `tailwindcss`, `zod`, `@tanstack/react-query`, `react-hook-form`, `lucide-react`, `date-fns`, `vitest`, `playwright`, dev typings.
- [ ] `tsconfig.json` with strict mode, `noUncheckedIndexedAccess`, `noImplicitOverride`.
- [ ] `tailwind.config.ts` with brand tokens (`--accent-yellow`, `--brand-navy`, `--accent-ink`, density tokens).
- [ ] `next.config.ts` minimal (no rewrites needed yet; legacy `public/*.html` still reachable via Vercel static serving).
- [ ] `src/` folder structure from [01-target-rebuild-structure.md](../architecture/01-target-rebuild-structure.md).
- [ ] `src/app/layout.tsx` (Inter + Inter Tight fonts, error boundary, theme provider).
- [ ] `src/app/page.tsx` — server component that calls `getCurrentUser()` and `redirect()`s to the role landing.
- [ ] `src/app/login/page.tsx` — new login form, posts to existing `/api/auth?action=login`.
- [ ] `src/app/login/login-form.tsx` — client component.
- [ ] `src/app/(admin)/layout.tsx` — empty AdminShell (sidebar + topbar; no nav items yet, just brand block + sign-out).
- [ ] `src/app/(admin)/command-centre/page.tsx` — placeholder ("Welcome to BuhlOS Admin. Hours loop coming next.").
- [ ] `src/app/(phil)/layout.tsx` — empty PhilShell (bottom tab bar with 5 empty tabs).
- [ ] `src/app/(phil)/phil/page.tsx` — placeholder.
- [ ] `src/middleware.ts` — reads session cookie, calls `getCurrentUser`, redirects per role.
- [ ] `src/lib/auth/session.ts` — typed wrapper over `api/_lib/auth.js`.
- [ ] `src/lib/auth/landing.ts` — the one `landingFor(role)` function.
- [ ] `src/lib/auth/roles.ts` — `type Role`, role categorisation.
- [ ] `src/lib/env.ts` — Zod-validated env at boot.
- [ ] `src/lib/http.ts` — typed fetch wrapper.
- [ ] `src/components/ui/Button.tsx`, `Card.tsx`, `Pill.tsx`, `EmptyState.tsx`, `UnderConstructionPanel.tsx`, `DemoModeBanner.tsx`.
- [ ] `src/components/admin/AdminShell.tsx`, `AdminSidebar.tsx`, `AdminTopbar.tsx`.
- [ ] `src/components/phil/PhilShell.tsx`, `PhilTabBar.tsx`, `PhilHeader.tsx`.
- [ ] One Playwright test: `phase-a.spec.ts` — `/login` renders form; admin login → command-centre placeholder; tradie login → phil placeholder.
- [ ] CI workflow `.github/workflows/pr.yml` — typecheck + lint + test + build.

### Out of scope for Phase A

- Any actual feature (jobs list, hours, etc.).
- Removing the legacy `public/*.html` files (they stay reachable as `/legacy/*` rewrites added in `next.config.ts`).
- Migrating any data shape.
- Touching `api/*.js`.
- Service worker changes.

### Exit criteria

- `npm run build` succeeds.
- `npm run typecheck` succeeds.
- `npm run test` (Vitest) succeeds.
- `npx playwright test phase-a` passes.
- On preview URL:
  - `/` redirects to `/login` (no session) or to the role landing (with session).
  - `/login` shows the new form; logging in as admin lands at `/command-centre`.
  - Logging in as tradie lands at `/phil`.
  - Both placeholder pages render without console errors.
- Old surfaces (`/admin/operations`, `/my-day`, `/jobs/:id`) still work via the legacy rewrite — production untouched.

---

## Phase B — Hours loop end-to-end

**Goal:** ship the hours loop (Loop 1 in [00-core-operational-loops.md](00-core-operational-loops.md)) on the new shell. Phil My Day, Phil hours capture, admin approval queue, audit log writes. Everything else stays UNDER CONSTRUCTION.

### Scope

- [ ] `src/domains/timesheets/` complete:
  - `types.ts` — `TimesheetEntry`, `TimesheetApproval`.
  - `schema.ts` — Zod schemas.
  - `fixtures.ts` — typed fixtures (replaces `BUHLOS_MOCK.hoursByJob`).
  - `client.ts` — `submitTimesheet`, `listPending`, `approve`, `reject`, `listMyEntries`, etc.
  - `service.ts` — `isStandardDay(hours)`, `calculateTotal(entries)`, etc.
  - `timesheets.test.ts` — unit tests for service pure functions.
- [ ] `src/domains/workers/` minimal — types needed for displaying who submitted.
- [ ] `src/domains/jobs/` minimal — `JobSummary` type so timesheets can attach to a job.
- [ ] `src/domains/audit-log/` minimal — `logEvent(action, target, before?, after?)`.
- [ ] Phil:
  - `src/app/(phil)/phil/my-day/page.tsx` — today's hours + standard-day button + custom-hours sheet.
  - `src/app/(phil)/phil/hours/page.tsx` — list of own entries with status pills (pending / approved / rejected).
  - `src/components/phil/LogHoursSheet.tsx` — the 7h 36m standard-day sheet.
  - `src/components/phil/HoursListItem.tsx`.
- [ ] Admin:
  - `src/app/(admin)/hours/approvals/page.tsx` — pending queue with row → side panel.
  - `src/app/(admin)/hours/page.tsx` — combined overview (pending + approved + recent activity).
  - `src/components/admin/ApprovalQueue.tsx`.
  - `src/components/admin/ApprovalRow.tsx`.
- [ ] Admin sidebar Run section: "Command centre" (placeholder), "Approvals" (live), "Snags" (UNDER CONSTRUCTION), "Support" (UNDER CONSTRUCTION).
- [ ] Phil tab bar: Today (live), Jobs (UC), Gear (UC), Snag (UC), More (live for sign-out).
- [ ] Manifest update: `start_url: '/phil/my-day'`.
- [ ] Login `landingFor()` updated: tradie/apprentice → `/phil/my-day`. Existing `/my-day` redirect kept as legacy.
- [ ] Playwright E2E `phase-b.spec.ts`: worker submits standard day → admin approves → worker sees approved status → AuditLog has the event.
- [ ] DemoModeBanner across all surfaces when fixtures are loaded.

### Acceptance

- Hours loop closed end-to-end on the new shell, real data via existing `api/time-entries*`.
- Old hours surfaces (`/my-day`, `/admin/approvals`, `/admin/hours`) still work — both paths produce the same data.
- A worker can use either path (legacy or new) and the data ends up in the same Blob.

### Out of scope for Phase B

- Gear, evidence, ITP, RFI features.
- Editing approved entries (adjustments are new entries — Phase B+).
- Job creation in the new shell (admins still create jobs in `/admin-legacy` or `/admin/jobs.html`).

### Exit criteria

- Phase A criteria still pass.
- Playwright `phase-b` passes.
- The hours loop on the new shell is verified by a non-engineer on the preview URL.
- A timesheet submitted via legacy `/my-day` is visible to admin in the new `/hours/approvals` view, and vice versa.
- No regression in legacy `/admin/operations` (smoke test still passes).

---

## Phase C — My Gear

**Goal:** ship Loop 2 (gear). Admin assigns gear, worker sees it in Phil, basic assignment status. QR scanning is in scope but optional (`pickup`/`return` buttons in Phil can substitute initially).

### Scope

- [ ] `src/domains/gear/` complete:
  - `types.ts` — `GearAsset`, `GearAssignment`, `GearScan`.
  - `schema.ts`.
  - `fixtures.ts`.
  - `client.ts` — assign, return, scan, listOwn, listAll, listOverdue.
  - `service.ts` — overdue logic, single-open-assignment logic.
  - `gear.test.ts`.
- [ ] Admin:
  - `src/app/(admin)/gear/page.tsx` — list with overdue filter.
  - `src/app/(admin)/gear/[assetId]/page.tsx` — detail + assignment history.
  - `src/components/admin/GearAssignDialog.tsx`.
- [ ] Phil:
  - `src/app/(phil)/phil/gear/page.tsx` — list of currently-assigned gear.
  - `src/components/phil/GearListItem.tsx`.
  - "Confirm receipt" button (writes a GearScan with action=`pickup`).
  - "Hand back" button (closes assignment).
- [ ] Sidebar / tab bar marks Gear as `live`.
- [ ] Command Centre KPI tile: "Overdue gear" (live count).
- [ ] Playwright E2E `phase-c.spec.ts`: admin assigns → worker confirms → admin sees confirmation in detail view; later admin sees overdue when expectedReturn passes.

### Acceptance

- Gear loop closed end-to-end.
- Phil-side gear list reflects admin assignments in real time (on refresh).
- Overdue assets surface in admin command-centre.

### Out of scope for Phase C

- QR scanning (substituted by buttons).
- Calibration-due workflow (separate from overdue).
- Gear request → approval loop (the loop is admin-pushes-to-worker only in Phase C).
- Cross-job gear transfer history.

### Exit criteria

- Phase A + B criteria still pass.
- Playwright `phase-c` passes.
- Verified on preview by a non-engineer.

---

## Phase D — Jobs (admin + Phil) + evidence capture

**Goal:** the first slice of Loop 3 (job evidence). Admin builds a job, worker sees it, worker completes tasks. Evidence-required photo capture is a placeholder for now (full Evidence flow lands post-MVP).

### Scope

- [ ] `src/domains/jobs/` complete:
  - `types.ts` — `Job`, `JobStage`, `JobArea`, `JobTask`.
  - `schema.ts`.
  - `fixtures.ts`.
  - `client.ts` — create, update, listAll, listMine, getDetail, setTaskStatus.
  - `service.ts` — completion %, evidence-required guards.
  - `jobs.test.ts`.
- [ ] `src/domains/evidence/` placeholder:
  - `types.ts` — `Evidence`, `Photo`.
  - `client.ts` — upload photo (calls existing `/api/photos`).
- [ ] Admin:
  - `src/app/(admin)/jobs/page.tsx` — list with status filter.
  - `src/app/(admin)/jobs/[jobId]/page.tsx` — header + stage drilldown.
  - `src/app/(admin)/jobs/[jobId]/areas/[areaId]/page.tsx` — task list with status.
  - `src/app/(admin)/jobs/new/page.tsx` — Job Builder (initially: name + address + builder + at least one stage / area / task).
- [ ] Phil:
  - `src/app/(phil)/phil/jobs/page.tsx` — list of assigned jobs.
  - `src/app/(phil)/phil/jobs/[jobId]/page.tsx` — stage drilldown.
  - `src/app/(phil)/phil/jobs/[jobId]/tasks/[taskId]/page.tsx` — task detail + status selector + photo upload (if evidenceRequired).
  - `src/components/phil/TaskStatusSelector.tsx` (Not started / In progress / Done).
- [ ] Photo upload UX in Phil — camera or file picker, compress client-side, POST to existing `/api/photos`.
- [ ] Admin can review captured Evidence in the area detail view.
- [ ] Playwright E2E `phase-d.spec.ts`: admin creates a 1-stage 1-area 1-task job → worker sees it → worker marks task in-progress → worker uploads photo → worker marks done → admin sees done.

### Acceptance

- Job evidence loop closed at MVP level (admin can flag for re-capture but full Evidence inbox is post-MVP).
- Admin can no longer say "Job Builder is under construction" — it works for simple jobs.
- Legacy `/admin/job.html` and `/admin/jobs.html` still reachable and unchanged.

### Out of scope for Phase D

- Full ITP / QA loop (Loop 4) — UNDER CONSTRUCTION.
- Full RFI loop (Loop 5) — UNDER CONSTRUCTION.
- Variations — UNDER CONSTRUCTION.
- Plans upload — UNDER CONSTRUCTION.
- Materials — UNDER CONSTRUCTION.
- Reports — UNDER CONSTRUCTION.
- Quotes — UNDER CONSTRUCTION.
- Cash & margin — UNDER CONSTRUCTION.
- Job templates — copy-paste from legacy not auto-imported.
- Concurrent-write protection (best-effort last-write-wins for now).

### Exit criteria

- All previous phase criteria still pass.
- Playwright `phase-d` passes.
- Verified on preview by a non-engineer.

---

## After Phase D — what's next (post-MVP)

Roughly in priority order. None of these are MVP; each is a future phase.

| Phase | Feature                                                | Loop / domain                       |
| ----- | ------------------------------------------------------ | ----------------------------------- |
| E     | Full Evidence inbox + flag/return flow                 | Loop 3 extension                    |
| F     | ITP / QA loop end-to-end                                | Loop 4                              |
| G     | RFI / Variation / Defect inbox + triage                | Loop 5                              |
| H     | Plans upload + revision + acknowledgement              | Plans domain                        |
| I     | Materials request → order → deliver                    | Materials domain                    |
| J     | Reports: weekly summary, job financials                | Reports surface                     |
| K     | Quotes + builder integration                           | Quotes domain                       |
| L     | Cash & margin watch                                    | Cash domain                         |
| M     | Multi-org (Organisation entity)                        | Organisation domain                 |
| N     | Postgres migration                                     | Storage layer                       |
| O     | Auth.js / OIDC migration (optional)                    | Auth                                 |

Each phase ships behind a feature flag and only takes over a route once verified. The MVP rebuild is **Phases A through D**.

---

## What "UNDER CONSTRUCTION" looks like

Per [[feedback_hide_unfinished_features]], no half-broken UI ships live. The `UnderConstructionPanel` component is used everywhere an unfinished feature would otherwise show:

```tsx
<UnderConstructionPanel
  feature="Materials"
  expectedPhase="Phase I"
  description="Materials request → order → deliver loop is not built yet. Use the legacy admin for now."
  legacyLink="/legacy/admin/materials"
/>
```

- Black-and-yellow tape pattern as background.
- Feature name + expected phase visible.
- Optional link to legacy surface if still reachable.
- Sidebar/nav entries for UC features show greyed-out with "UC" tag.

---

## Migration of users from legacy to rebuild

| When                          | What                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| Phase A live                  | Admins can log in to new shell at `/command-centre` (placeholder). Tradies still land at legacy `/my-day` by default. |
| Phase B live                  | Tradies' `landingFor()` switches to `/phil/my-day`. Legacy `/my-day` still works as a fallback link. |
| Phase B verified              | Hours-only users have migrated. Older surfaces left alone.            |
| Phase C live                  | Phil gear tab goes live; legacy `/my-gear` redirects to `/phil/gear`. |
| Phase D live                  | Job views in admin shell go live; legacy `/admin/jobs.html` redirects to `/jobs`. |
| Phase D verified              | Most daily flows on new shell. Legacy admin surfaces still reachable for unbuilt features (materials, ITP, etc.). |
| Post Phase F                  | Most features ported. `public/admin/*.html` files deleted (kept only `admin.html` legacy archive). |
| Post Phase L                  | All features ported. Legacy `public/*.html` deleted. `vercel.json` simplified.           |

---

## Cross-references

- The loops in detail: [00-core-operational-loops.md](00-core-operational-loops.md)
- The structure: [../architecture/01-target-rebuild-structure.md](../architecture/01-target-rebuild-structure.md)
- The rules: [../architecture/00-rebuild-non-negotiables.md](../architecture/00-rebuild-non-negotiables.md)
- What stays vs goes: [../rebuild-audit/07-salvage-map.md](../rebuild-audit/07-salvage-map.md)
- The next Claude Code prompt: [../rebuild-audit/08-next-claude-code-prompt.md](../rebuild-audit/08-next-claude-code-prompt.md)
