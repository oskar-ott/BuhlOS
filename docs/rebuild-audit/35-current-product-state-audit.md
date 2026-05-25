# 35 · Current product state audit (2026-05-26)

> **Status:** Snapshot audit (docs-only). Run by a parallel audit session on
> 2026-05-26 while **two other sessions were concurrently merging**
> `phase-e1a-itp-domain` (PR #34) and `ui-bible-vnext-implementation`
> (PR #35). Latest origin/main at audit close: `69ab80f` (PR #35, UI
> interface-bible vNext improvements, merged 2026-05-25 20:45 UTC).
> Audit-time snapshot reflects post-PR-35 main.
>
> **Purpose:** Brutal, practical state-of-the-product check covering everything
> that has been built, merged, shipped, half-built, designed-but-not-shipped,
> blocked, risky, or stale — plus the next-5-PR plan.
>
> **Not a planning artefact.** This doc does not introduce new scope. It maps
> reality against the existing planning docs (24-26 for Phase D, 32-34 for
> Phase E) and the binding rule set (10/13/14/20/27/31).
>
> **What this audit did NOT do:** local `npm run test / typecheck / build`
> on the main worktree (because an active E1a session was concurrently
> writing to it). Test coverage is assessed by reading test files. Production
> authenticated smoke also not run (no credentials passed to the audit
> session — leaving authenticated E1a verification for the E1a runbook
> session). Production unauth smoke ran; results in §3.

---

## 1 · Executive summary

**Overall verdict: PRODUCTION HEALTHY · HARDENING NEEDED BEFORE E1B.**

- Production at `buhlos.com` serves cleanly. All gated routes 307 to
  `/v2/login`. All APIs return 401 on unauth. No 500s, no blank pages, no
  Vercel SSO walls. Legacy `/login`, `/phil`, `/admin/*` all still serve.
- **PR #34 (E1a) just merged.** The ITP domain + API extension is on
  `origin/main` at `996d848`. CI was green (typecheck / lint / test /
  build). Vercel preview was SUCCESS. **Post-merge production smoke
  has NOT been run yet** and there is no `phase-e1-itp-runbook.md`.
- Six closed operational loops are live in production: **Hours, Gear,
  Jobs (Phil + Admin), Evidence, Snags.** E1a adds the seventh loop's
  backend (ITP) but the worker and admin UI for it has not been built —
  there is no `/phil/jobs/[jobId]/itps/[instanceId]` and no
  `/v2/jobs/[jobId]/itps` yet.
- Everything beyond E1a is on the roadmap but not started: E1b (Phil ITP
  UI), E1c (admin ITP queue + signoff), E2 (template editor rebuild +
  cross-job triage), E3 (RFI), E4 (Materials), F (reporting, Xero, AI).
- Three risks worth surfacing before E1b opens:
  1. **No post-E1a production smoke.** Per [34 §E](34-phase-e-testing-checklist.md)
     this is a required gate. Independence rule needs field validation.
  2. **CI cannot run authenticated tests.** Five Playwright specs exist;
     all authenticated flows are `.skip`'d pending seeded CI test
     accounts. The unauth-redirect tier is the only thing CI catches.
  3. **No middleware unit tests.** `src/middleware.ts`, `src/lib/auth/*`
     are the production gate for the entire rebuild surface; one
     domain-helper test (`landing.test.ts`) is the only coverage.

**Recommended next 5 PRs** (full detail in §17):

1. **This audit doc** — `current-product-state-audit` branch, docs-only.
2. **`phase-e1-itp-runbook.md` + E1a post-merge production smoke** —
   highest priority. Must validate independence rule + audit-log
   integration on production before any E1b code lands.
3. **E1b — Phil ITP recording UI** — `phase-e1b-phil-itp-ui` branch,
   prompt from [33 §E1b](33-phase-e-build-prompts.md).
4. **E1c — Admin ITP queue + sign-off** — `phase-e1c-admin-itp-queue`
   branch, prompt from [33 §E1c](33-phase-e-build-prompts.md). Runs
   in parallel with E1b after E1a runbook lands.
5. **Hardening: CI auth fixtures OR middleware tests** — pick one based
   on which gap Oskar finds more uncomfortable. Both are pre-E2 work.

E2 / E3 / E4 / F do NOT open until E1 (a + b + c + runbook) is shipped
and production-stable for ≥3 days.

---

## 2 · Repo / PR state

**At audit time (after PR #34 merge):**

| Item | Value |
| --- | --- |
| Canonical repo | `oskar-ott/BuhlOS` |
| Canonical Vercel project | `birdwood` |
| Production domain | `https://buhlos.com` |
| `origin/main` HEAD | `69ab80f` — Merge PR #35 (UI interface-bible vNext improvements) |
| `996d848` | Merge PR #34 (E1a ITP domain + API extension) |
| Latest pre-E1a HEAD | `2a92b90` — Merge PR #33 (Onboarding) |
| Open PRs | **0** (all 35 PRs merged or closed) |
| Total merged PRs | **35** (PR #1 through PR #35) |
| Active named branches | `phase-e1a-itp-domain` (just merged in #34), `ui-bible-vnext-implementation` (just merged in #35), `phase-e1a-itp-domain-api` (stale, no commits ahead) |
| Active worktrees | 40+ Claude session worktrees + audit + prod-base — these are tooling artefacts, not human-active work |
| Working tree on main | Clean (post-merge) |

### 2.1 · Recent merge sequence (last 15)

| # | PR | Title | Merged |
| --- | --- | --- | --- |
| 35 | [#35](https://github.com/oskar-ott/BuhlOS/pull/35) | UI · apply BuhlOS Phil interface bible vNext | 2026-05-25 20:45 |
| 34 | [#34](https://github.com/oskar-ott/BuhlOS/pull/34) | [Phase E1] E1a · ITP domain and API extension | 2026-05-25 20:42 |
| 33 | [#33](https://github.com/oskar-ott/BuhlOS/pull/33) | UI · implement onboarding design | 2026-05-25 20:19 |
| 32 | [#32](https://github.com/oskar-ott/BuhlOS/pull/32) | UI · pass 3 (drop remaining Phase-letter copy + friendlier 404) | 2026-05-25 19:45 |
| 31 | [#31](https://github.com/oskar-ott/BuhlOS/pull/31) | UI · design pass 2 (RSC manifest debt + sidebar active indicator) | 2026-05-25 19:38 |
| 30 | [#30](https://github.com/oskar-ott/BuhlOS/pull/30) | UI · harden BuhlOS + Phil interface clarity | 2026-05-25 08:49 |
| 28 | [#28](https://github.com/oskar-ott/BuhlOS/pull/28) | Phase E plan · E1 = ITP — canonical (docs-only) | 2026-05-25 20:14 |
| 26 | [#26](https://github.com/oskar-ott/BuhlOS/pull/26) | D.5 · harden snags API and counters | 2026-05-25 07:30 |
| 25 | [#25](https://github.com/oskar-ott/BuhlOS/pull/25) | docs: Phase D shipped-state reconciliation (audit of PR #8) | 2026-05-25 07:06 |
| 23 | [#23](https://github.com/oskar-ott/BuhlOS/pull/23) | fix: api/_lib/auth.js role normalization | 2026-05-25 06:25 |
| 21 | [#21](https://github.com/oskar-ott/BuhlOS/pull/21) | Phase D6 · Admin jobs index | 2026-05-25 06:15 |
| 20 | [#20](https://github.com/oskar-ott/BuhlOS/pull/20) | D5 snags hardening · rejection reasons + tap targets | 2026-05-25 05:59 |
| 19 | [#19](https://github.com/oskar-ott/BuhlOS/pull/19) | D5 snag drawer history retry | 2026-05-25 05:55 |
| 18 | [#18](https://github.com/oskar-ott/BuhlOS/pull/18) | Phase D.5 · Snags and defects loop | 2026-05-25 01:28 |
| 17 | [#17](https://github.com/oskar-ott/BuhlOS/pull/17) | D5 drawer history retry | 2026-05-25 00:36 |
| 16 | [#16](https://github.com/oskar-ott/BuhlOS/pull/16) | Phase D5 · Evidence hardening | 2026-05-24 23:10 |

The cadence is: 15 PRs merged on 2026-05-25 alone. Phase D + D.5 + UI
hardening + Onboarding + Phase E plan + E1a backend + UI bible vNext
all shipped in a single intense day.

### 2.2 · Stale branches / cleanup candidates

- `ui-bible-vnext-implementation` — head of PR #35; can be pruned once
  Vercel finishes production deploy.
- `phase-e1a-itp-domain-api` — same commit as main pre-PR #34; can be
  pruned.
- `phase-e1a-itp-domain` — head of PR #34; should be pruned once
  Vercel finishes production deploy.
- 40+ `.claude/worktrees/` directories — Claude tooling artefacts;
  ignored by .gitignore but bloating the filesystem (~40 working
  copies). Worth a manual cleanup pass after E1 ships.

---

## 3 · Production health (unauthenticated smoke)

Ran via WebFetch against `https://buhlos.com` at audit time. **All
endpoints behaved as expected.**

| Surface | Route | Expected | Actual |
| --- | --- | --- | --- |
| Login | `/v2/login` | 200 HTML | ✅ 200, sign-in form, links to legacy |
| Login (legacy) | `/login` | 200 HTML | ✅ 200, legacy login |
| Phil (legacy) | `/phil` | 200 HTML | ✅ 200, legacy Phil tabbed app |
| Phil v2 home | `/v2/phil` | 307 → login | ✅ 307 (gated, surface=phil) |
| Phil My day | `/phil/my-day` | 307 → login | ✅ 307 |
| Admin home | `/command-centre` | 307 → login | ✅ 307 (surface=admin) |
| Admin hours | `/hours` | 307 → login | ✅ 307 |
| Admin approvals | `/hours/approvals` | 307 → login | ✅ 307 |
| Admin jobs | `/v2/jobs` | 307 → login | ✅ 307 |
| Admin snags (per job) | `/v2/jobs/birdwood-iv3232/snags` | 307 → login | ✅ 307 |
| API auth | `/api/auth?action=me` | 401 JSON | ✅ 401 |
| API jobs | `/api/jobs` | 401 JSON | ✅ 401 |
| API jobs+stats | `/api/jobs?withStats=1` | 401 JSON | ✅ 401 |
| API snags | `/api/snags?jobId=birdwood-iv3232` | 401 JSON | ✅ 401 |
| API audit-log | `/api/audit-log?targetType=snag&jobId=birdwood-iv3232` | 400 (validation) or 401 | ✅ 400 (no targetId) |
| API audit-log itp | `/api/audit-log?targetType=itp_instance&...` | 401 JSON | ✅ 401 (post-E1a, schema accepts) |
| API ITP | `/api/job-itps?jobId=birdwood-iv3232` | 401 JSON | ✅ 401 (legacy endpoint, post-E1a extension) |

**No production blockers found in the unauth path.** Production deploy
for PR #34 (commit `996d848`) appears live — the `/api/audit-log` route
accepts the new `targetType=itp_instance` value (returns 401 unauth, not
400 validation). If E1a had not deployed, this would have been a 400.

**Not verified (requires credentials):**
- Authenticated end-to-end flow for each loop.
- The E1a-specific code paths (audit-log writes, independence rule,
  `statsItpsActive` enrichment on `/api/jobs?withStats=1`).
- Any production-side test data that may have accumulated from
  Phase B / C / D / D.5 verification sessions.

These belong in the E1a runbook session (see §17, PR 2).

---

## 4 · Built feature matrix

Status legend:
- **COMPLETE** — domain + API + UI + tests + production verified
- **PARTIAL** — some slices shipped, others pending
- **DESIGN** — design / plan only, no code
- **NOT STARTED** — explicitly future

| Loop | Phase | Status | Notes |
| --- | --- | --- | --- |
| **App shell** (Phil + Admin + login) | A | COMPLETE | PR #2. Phase A scaffold + `/v2/login`. Stable. |
| **Hours** | B | COMPLETE | PRs #3, #4, #7. Phil submits → admin approves/rejects → Phil sees status. Production-hardened (timezone, 16h cap, banner). |
| **Gear** | C | COMPLETE | PRs #5, #6, #9, #10. Admin assigns; worker reports returned/missing/damaged; admin mark-good. |
| **Jobs (Phil)** | D1 | COMPLETE | PR #11. `/phil/jobs` + `/phil/jobs/[jobId]` read-only. |
| **Evidence** | D2/D3/D4/D5 | COMPLETE | PRs #13–17. Phil capture → admin review (mark reviewed / reject + reason / un-review). History panel. |
| **Snags** | D.5 | COMPLETE | PRs #18–20, #26. Worker reports → admin transitions → status flows back. Reject reasons surfaced. PR #26 hardened the read-after-write race. |
| **Jobs (Admin index)** | D6 | COMPLETE | PR #21. `/v2/jobs` with evidence + snag chips. |
| **Onboarding (Phil)** | UI/design | COMPLETE | PR #33. 9-screen Phil onboarding tour at `/phil/onboarding`. Gated to phil surface. |
| **UI hardening** | UI | COMPLETE | PRs #30–32, #35. Interface bible pass + RSC manifest debt cleared + Phase-letter copy dropped + friendlier 404. PR #35 added interface-bible vNext: `AttentionBanner` + `StatusChip` UI primitives, reworked `/phil/my-day` + `/v2/phil` + `/phil/hours` + `PhilJobsList` to use them. |
| **Audit log (V2)** | D2+ | COMPLETE | Cross-loop write target. `api/audit-log.js` + `api/_lib/audit-log.js`. Read endpoint feeds drawer History panels. Verbs: evidence.\* + snag.\* + itp.\* (post-E1a). |
| **ITP backend** | E1a | **JUST MERGED** | PR #34. Domain (`src/domains/itp/*`), audit-log schema extension, `api/job-itps.js` extension (audit-log writes + PR #26 stale-read + independence rule + role-tier alignment), `api/jobs.js` statsItpsActive. **Awaiting production smoke + runbook.** |
| **ITP UI (Phil + Admin)** | E1b/E1c | NOT STARTED | Build prompts written in [33-phase-e-build-prompts.md](33-phase-e-build-prompts.md). E1a is the precondition; that gate is now met. |
| **ITP templates rebuild** | E2 | DESIGN | Deferred per [32 §2.2](32-phase-e-plan.md). Legacy `/admin/itp.html` continues to serve. |
| **Cross-job snag triage** | post-D.5 | DESIGN | Per [phase-d6-admin-jobs-index-runbook.md §5](phase-d6-admin-jobs-index-runbook.md). Sidebar `Snags · UC` placeholder. |
| **RFI** | E3 | DESIGN | Greenfield-small. Separate planning doc not opened. |
| **Materials** | E4+ | DESIGN | Legacy `api/materials-list.js` 1,200+ lines. Separate planning pack required. |
| **Reports / handover rollups** | F | NOT STARTED | Cross-loop reporting layer. |
| **Xero / payroll integration** | F | NOT STARTED | UC panel copy live on `/hours` mentions Xero push. |
| **AI plan interpretation** | F | NOT STARTED | |
| **Offline-first sync** | F | NOT STARTED | Existing "in-flight indicator + retry" patterns carry the field-experience floor. |

---

## 5 · Route map

### 5.1 · New rebuild routes (Next.js, in `src/app/`)

| Route | Surface | Auth | Owner | Status |
| --- | --- | --- | --- | --- |
| `/` | — | none | RootPage | Live — redirects to `landingFor(role)` |
| `/v2/login` | login | public | login-form.tsx | Live |
| `/command-centre` | admin | admin tier | page.tsx | Live (3 queue cards + 4 surface links + UC strip) |
| `/hours` | admin | admin tier | page.tsx | Live (hours overview + UC for Xero/CSV/bulk) |
| `/hours/approvals` | admin | admin tier | page.tsx | Live (HoursApprovalsQueue) |
| `/gear` | admin | admin tier | page.tsx | Live (GearRegisterClient) |
| `/v2/jobs` | admin/lh | admin or LH | page.tsx | Live (JobsList with chips) |
| `/v2/jobs/[jobId]/evidence` | admin/lh | admin or LH | page.tsx | Live (EvidenceQueue + drawer) |
| `/v2/jobs/[jobId]/snags` | admin/lh | admin or LH | page.tsx | Live (SnagsQueue + drawer + reject modal) |
| `/v2/jobs/[jobId]/itps` | admin/lh | admin or LH | — | **Not built (E1c)** |
| `/v2/phil` | phil | field or LH | page.tsx | Live (placeholder with onboarding CTA + UC for profile) |
| `/phil/my-day` | phil | field or LH | page.tsx | Live (LogHoursSheet + recent + UC for multi-job) |
| `/phil/hours` | phil | field or LH | page.tsx | Live (history) |
| `/phil/gear` | phil | field or LH | page.tsx | Live |
| `/phil/jobs` | phil | field or LH | page.tsx | Live (PhilJobsList) |
| `/phil/jobs/[jobId]` | phil | field or LH | page.tsx | Live (PhilJobDetail with snag panel) |
| `/phil/jobs/[jobId]/itps/[instanceId]` | phil | field or LH | — | **Not built (E1b)** |
| `/phil/onboarding` | phil | field or LH | page.tsx | Live (OnboardingFlow, 9 screens) |

### 5.2 · Legacy routes (`vercel.json` rewrites → `public/*.html`)

About 80 rewrites in [vercel.json](../../vercel.json). Key live legacy:

- `/login` → `login.html`
- `/admin` / `/admin/operations` → admin shell
- `/admin/jobs`, `/admin/job-builder`, `/admin/itp`, `/admin/plans`,
  `/admin/variations`, `/admin/reports`, `/admin/quotes`,
  `/admin/hours`, `/admin/crew`, `/admin/suppliers`, `/admin/temps`,
  `/admin/settings`, `/admin/support`, `/admin/assets`,
  `/admin/activity`, `/admin/materials`, `/admin/cash`,
  `/admin/snags`, `/admin/approvals` — 19 legacy admin pages
- `/phil`, `/phil/app`, `/phil/login` → legacy Phil
- `/my-day`, `/my-gear`, `/lh`, `/lh-home`, `/client` → other legacy
- `/buhlos/*` 16-route mirror set (banned in non-negotiables but still
  rewriting — quarantine candidate for Phase G)
- `/dev/site-office/components` (dev surface)
- `/admin-legacy` → `admin.html`
- `/` → `login.html`

**No rewrite changed since Phase A.** Cutovers are deferred per
[16-migration-strategy.md](16-migration-strategy.md).

### 5.3 · API routes (legacy + extended)

`api/` directory has 80+ Node.js handlers. Heavy ones (post-rebuild):

- `api/auth.js` — login + session
- `api/jobs.js` — list with `withStats=1` (extended in PR #21 + #34 for
  V2 evidence/snag/ITP counts)
- `api/time-entries.js`, `api/time-entries-approve.js`,
  `api/time-entries-reject.js`, `api/time-entries-reopen.js`, etc.
- `api/assets.js` — gear register
- `api/evidence.js` — evidence capture + review
- `api/snags.js` — snags transitions (extended in PR #18, #26 for V2
  audit + readBlobFresh)
- `api/job-itps.js` — ITP state machine (extended in PR #34: V2
  audit-log writes, PR #26 stale-read, isAdminRole normalization,
  independence rule)
- `api/audit-log.js` — V2 monthly cross-surface journal
- `api/photos.js` — photo upload (includes `upload-itp-photo` action)
- `api/job-audit.js` — legacy structural log

Plus many "stats" / "summary" / "export" endpoints, push notifications,
crons, etc. The legacy API surface is broad; the rebuild extends it
in-place rather than replacing it (per the rebuild non-negotiables).

---

## 6 · Domain state matrix

Code in `src/domains/<x>/`. Each domain typically has
`schema.ts` / `types.ts` / `service.ts` / `client.ts` / `format.ts` /
`<x>.test.ts`.

| Domain | Schema | Service | Client | Format | Tests | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `audit-log` | ✅ | — | ✅ | — | ✅ | Verbs: evidence.\*, snag.\*, itp.\* (post-E1a). Target types: evidence, snag, itp_instance, itp_template. |
| `evidence` | ✅ | ✅ | ✅ | ✅ | ✅ (819L) | D2/D3/D4/D5 complete. State machine in `service.ts`. |
| `gear` | ✅ | ✅ | ✅ | ✅ | ✅ (803L) | Phase C complete. Lost / damaged / returned states. |
| `itp` | ✅ | ✅ | ✅ | ✅ | ✅ (1289L) | E1a JUST MERGED. State machine + role gates + independence rule + 5 client wrappers. No UI consumers yet. |
| `jobs` | ✅ | — | ✅ | ✅ | ✅ (478L) | Schemas + format. Service logic is in API handlers, not duplicated here. |
| `snags` | ✅ | ✅ | ✅ | ✅ | ✅ (876L) | D.5 complete. Transition matrix open→in_progress→resolved→verified→closed + reject. |
| `timesheets` | ✅ | ✅ | ✅ | ✅ | ✅ (614L) | Phase B. Includes fixtures.ts. |

**No `src/domains/` for `rfi` or `materials`** — both intentionally not started.

---

## 7 · UX / UI audit

### 7.1 · Phil

- **Tab bar** (`src/components/phil/PhilTabBar.tsx`):
  - Today (`/phil/my-day`) · Jobs (`/phil/jobs`) · Gear (`/phil/gear`)
    · Snag (UC, links to `/v2/phil`) · More (`/v2/phil`)
  - **Issue:** the `Snag` tab is UC with a SOON pill, but per-job
    snags are already discoverable via `Jobs → job detail → Snags
    section`. The UC tab is for a future *cross-job* snag inbox. The
    SOON pill is honest, but the placement may be confusing — workers
    might think snagging isn't built. Consider relabel to "Snag inbox"
    or hide until shipped.
- **Home** (`/v2/phil/page.tsx`): minimal landing with "What's live"
  card, "Start the tour" CTA to `/phil/onboarding`, UC for
  profile/settings. Honest framing.
- **My day** (`/phil/my-day/page.tsx`): LogHoursSheet + recent entries
  + UC for multi-job allocation (legacy bail-out link). Clean.
- **Job detail** (`/phil/jobs/[jobId]/page.tsx` via PhilJobDetail):
  Renders snags section. Will need an ITPs section in E1b.
- **Onboarding** (`/phil/onboarding/page.tsx`): 9-screen flow. Steps
  cover Welcome, Identity, Hours, Gear, Jobs, Job interface, Site data,
  Permissions, Ready. **Two ITP / RFI mentions worth re-checking:**
  - Step 7 (SiteData): `"ITPs", detail: "tick off as you go — coming
    soon"`. Now that E1a is merged and E1b is next, this copy needs an
    update once Phil ITPs are visible.
  - Step 8 (Permissions): `"snags, RFIs, defects"`. RFI is Phase E3
    (greenfield, not started). Acceptable as forward-pointer for now.
- **Tap targets:** size="lg" (48 px) primary buttons. Photo capture 56
  px per CaptureSheet precedent. PR #20 hardened this.

### 7.2 · BuhlOS Admin

- **Sidebar** (`src/components/admin/AdminSidebar.tsx`):
  - Live: Command centre · Hours · Approvals · Gear · Jobs
  - UC: Snags · Support · Settings
  - **Issue (minor):** the UC items' `href` is `/command-centre` —
    placeholder. They are non-clickable (rendered as `<span>`) so the
    href is irrelevant, but worth tidying when one of them ships.
  - **No `ITPs` sidebar entry.** Per [32 §7.4](32-phase-e-plan.md), E1
    deliberately does not add one — admins find ITPs through
    `/v2/jobs` chips. A cross-job triage entry is E2.
- **Command Centre home** (`/command-centre/page.tsx`):
  - Three queue cards (Hours / Evidence / Snags) sourced from
    `/api/time-entries` + `/api/jobs?withStats=1`. Yellow pill =
    count > 0, navy card. Clean queue UX per doc 27 §9.1.
  - "Live surfaces" strip (Hours, Approvals, Gear, Jobs).
  - "Still being built" card mentions "cross-job snags inbox, reports
    / payroll exports and full settings".
  - **Will need an ITP queue card after E1c.** `statsItpsActive` is
    now exposed on `/api/jobs?withStats=1`; the home page can aggregate
    in the same shape as the snags card.
- **Per-job surfaces** (`/v2/jobs/[jobId]/(evidence|snags)`):
  Queue + drawer + reject modal pattern. Verified live. The
  `/v2/jobs/[jobId]/itps` peer route lands in E1c.
- **Hours, Approvals, Gear:** all live and queue-shaped.

### 7.3 · UC / fake-feature register

Eight UC panels mounted in user-facing surfaces (full list from a grep
audit):

| Surface | Feature label | Notes |
| --- | --- | --- |
| `/v2/phil` | Profile · settings · notifications | Honest placeholder. Bail-out link to legacy. |
| `/phil/my-day` | Multi-job allocation · job picker | Legacy bail-out. |
| `/phil/hours` | Edit rejected entry | Legacy bail-out. |
| `/phil/gear` | QR scan check-out | Future. |
| `/hours` (admin) | CSV export · payroll finalisation · Xero push | Mentions Xero + payroll — acceptable per Phase F outlook. |
| `/hours` (admin) | Bulk approve · weekly rollup · filters | Legacy bail-out. |
| `/hours/approvals` (admin) | Bulk approve week · re-open approved entry · LH-scoped admin view | Legacy bail-out. |
| `/gear` (admin) | Bulk operations · QR scanning · label printing | Future. |

All panels follow `<UnderConstructionPanel ...>` with `feature=` +
`description=` + optional `legacyHref=` + `legacyLabel=`. Per agent
rules #16, #17: visible, not hidden, with a legacy escape hatch where
one exists.

### 7.4 · "Switchboard" / "Site Office" findings

**Clean** per [20 #18](20-agent-rules.md):

- "Switchboard" appears only as ITP scope label / data value in
  `src/domains/itp/format.ts` (`scopeLabel("switchboard") = "Switchboard"`)
  and the corresponding test assertion. This is allowed per
  [32 §15.1 #4](32-phase-e-plan.md) — equipment-scope label, not
  section/sidebar.
- "Site Office" appears nowhere in user-facing copy.
- No Phase-letter user-facing copy (PR #32 cleared remainder).

### 7.5 · TODOs / FIXMEs / mocks

- **Zero TODO / FIXME comments in `src/`.** Clean.
- **No `BUHLOS_MOCK` silent-fallback** detected in production code
  paths. Test files use `mockFetch()` patterns; that's allowed.

---

## 8 · Architecture audit

### 8.1 · Component placement (RSC manifest rule, doc 24 D-26)

After PR #31 (UI design pass 2) lifted route-local client components
into `src/components/`, **no `"use client"` files remain under deep
route folders.** All client components live under:

- `src/components/phil/` (13 files)
- `src/components/admin/` (15 files)
- `src/components/onboarding/` (5 + 9 step files)
- `src/components/ui/` (8 files)

`src/app/` contains only server components (page.tsx / layout.tsx).
Login form is the only `*-form.tsx` under `src/app/` and it's
correctly inside the same route segment as the login page.

This is the binding architecture rule that caused multiple production
500s in earlier phases. Compliance is currently clean. **The E1b/E1c
build prompts re-state this rule** (no `"use client"` under
`src/app/phil/jobs/[jobId]/itps/` or `src/app/v2/jobs/[jobId]/itps/`).

### 8.2 · Storage / Vercel Blob

`api/_lib/blob.js` (167 lines) is the canonical blob layer:

- 5-second in-memory cache (TTL 5000 ms; LRU-evicted at 200 entries)
- In-flight request dedupe (concurrent reads to same key share one
  promise)
- `writeBlob` populates cache write-through (same-instance reads
  immediately consistent)
- `readBlobFresh` invalidates + re-reads (used post-write across
  instances)
- `BLOB_CACHE_DISABLE=1` env var for cron bypass

**Cross-instance Blob propagation lag is real** (multi-second after a
`put`). The PR #26 mitigation pattern — `readBlob` first, if guard
rejects retry after 750ms with `readBlobFresh` — is now in place in
both `api/snags.js` (D.5 hardening) and `api/job-itps.js` (E1a).

**Storage namespaces:**

- `jobs.json` — job list
- `users.json` — user list (with password hash)
- `itp-templates.json` — global ITP template library
- `jobs/<id>/data.json` — evidence + snagsV2 + dwellings + notes
- `jobs/<id>/itps.json` — ITP instances per job (separate from
  data.json per [32 §5.4](32-phase-e-plan.md))
- `audit-log/<YYYY-MM>.json` — V2 monthly journals (cross-surface)
- Plus various legacy keys: hours/\*, photos/\*, etc.

**No transactional database.** All writes are append-then-overwrite on
JSON blobs. Concurrent writes on the same key from two warm function
instances can lose data (last-write-wins). The 5s cache + 750ms retry
pattern is a *mitigation*, not a *solution*. **For Phase F+ moving to a
real DB is on the table** (per various risk register entries) but not
scheduled.

### 8.3 · Auth / roles

`api/_lib/auth.js` (the JS server-side helper) and `src/lib/auth/*.ts`
(the TS middleware-side helper) are kept in sync by hand. Both
normalise role strings to lowercase and recognise the same 4 tiers:

- **Admin tier** (7): admin, boss, owner, manager, office, pm, estimator
- **LH tier** (4): leadinghand, leading_hand, leading-hand, lh
- **Field tier** (4): tradie, apprentice, labourer, electrician
- **Client tier** (1): client

PR #23 normalised this (post-D.5) — previously bare-string `role ===
'admin'` checks in some endpoints would 403 a `boss` or `pm` user even
though they had legitimate access. The PR #26 follow-up applied the
same normalisation to `api/snags.js` local sets; the PR #34 E1a
extension applied it to `api/job-itps.js` (the V2 audit-log writes).

**No middleware unit tests.** `src/lib/auth/landing.test.ts` (47 lines)
covers `landingFor` and `rolePermits`. `permissions.ts`, `session.ts`,
`current-user.ts`, and the middleware itself have **zero unit
coverage.** The Playwright unauth-redirect specs are the only
regression net here.

### 8.4 · API surface

- 80+ files in `api/`. Most are legacy (pre-rebuild). The rebuild
  extends in place rather than replacing (per non-negotiables).
- Recent extensions:
  - `api/snags.js` — D.5 + PR #26 hardening
  - `api/evidence.js` — D2/D5
  - `api/jobs.js` — D6 (statsEvidenceV2Pending, statsSnagsV2Active)
    + E1a (statsItpsActive)
  - `api/job-itps.js` — E1a major extension (~240 lines added on a
    237-line legacy file)
  - `api/audit-log.js` — read endpoint; schemas in `_lib/audit-log.js`
- **No new HTTP endpoint paths since rebuild started** (per agent
  rule #31).
- **No `vercel.json` rewrite changed since Phase A** (per agent rule
  #19).

### 8.5 · Legacy `public/admin/*.html`

25 legacy admin pages still serving via vercel.json rewrites:

- `index.html`, `operations.html`, `approvals.html`, `snags.html`,
  `jobs.html`, `job.html`, `job-builder.html`, `itp.html`, `plans.html`,
  `variations.html`, `reports.html`, `quotes.html`, `quote.html`,
  `hours.html`, `crew.html`, `suppliers.html`, `temps.html`,
  `settings.html`, `support.html`, `assets.html`, `activity.html`,
  `materials.html`, `cash.html`, plus `_shell.css`, `_shell.js`,
  `admin-data.js`.

**`public/admin/itp.html` (legacy ITP template editor + cross-job
queue) is the source of truth for ITP templates until E2 ships.** E1
deliberately does not touch it. E1c reads through the same data.

The `/buhlos/*` 16-route mirror set is still in vercel.json — banned by
the rebuild non-negotiables but not yet removed. Quarantine candidate
for Phase G.

---

## 9 · Test coverage findings

### 9.1 · Strong (unit + integration)

| Domain | Tests | Coverage |
| --- | --- | --- |
| audit-log | 256 L | Schemas, sorting, filtering. ITP verbs covered post-E1a. |
| evidence | 819 L | State machine, blob URLs, predicates, validation. |
| gear | 803 L | Schemas, photo URLs, assignment, lost/damaged states. |
| itp (E1a) | 1289 L | Schemas, state machine, role gates, independence rule, 5 client wrappers. **Largest test file in the repo.** |
| snags | 876 L | Transition matrix, role-based access, field visibility. |

### 9.2 · Moderate

| Area | Tests | Gaps |
| --- | --- | --- |
| jobs | 478 L | Schemas + formatting only; no integration. |
| timesheets | 614 L | Standard Day validation; approval flow thin. |
| EvidenceFilterBar | 171 L | Predicate function only; no React rendering test. |
| Onboarding steps | 45 L | Taxonomy + nav; no step UI render test. |
| Auth landing | 47 L | landingFor + rolePermits only. |

### 9.3 · Weak / missing

- **Middleware** — no test file.
- **`src/lib/auth/{session,permissions,current-user,roles}.ts`** — no
  test files.
- **UI primitives** — Button, Card, Modal, Pill, StatusBadge,
  EmptyState, DemoModeBanner, UnderConstructionPanel — no test files.
- **Phil components** — CaptureSheet, JobSnagsPanel, PhilTabBar,
  LogHoursSheet, PhilJobDetail, etc. — no test files.
- **Admin components** — SnagDrawer, SnagsQueue, EvidenceDrawer,
  EvidenceQueue, ITPsQueue (future), JobsList — no test files.
- **Blob layer** (`api/_lib/blob.js`) — no test file. Cache hit/miss,
  write-through, readBlobFresh invalidation, in-flight dedupe — all
  untested.
- **Most API handlers** — no `.test.js` next to them.

### 9.4 · E2E (Playwright)

5 specs in `tests/`. All authenticated flows are `.skip`'d pending
seeded CI test accounts:

| Spec | Active checks | Skipped |
| --- | --- | --- |
| phase-a.spec.ts | unauth /v2/phil → /v2/login; /v2/login renders | demo banner check |
| phase-b-hours.spec.ts | unauth gating on my-day, hours, approvals | full hours flow |
| phase-d-d3-capture.spec.ts | unauth /phil/jobs gating | capture flow (photo + note + submit) |
| phase-d-d4-admin-review.spec.ts | unauth /v2/jobs/[jobId]/evidence gating | review flow |
| phase-d-d6-admin-jobs-index.spec.ts | unauth /v2/jobs gating | LH read-only, list+filter |

**No E1a or E1 spec yet.** Should be added with E1c.

### 9.5 · Smoke scripts

- `scripts/smoke-admin-routes.js` — static check on legacy admin shell
- `scripts/smoke-evidence-routes.js` — HTTP status codes on 24 routes
- `scripts/check-admin-shell.js` — `SHELL.boot()` presence in legacy
  admin pages
- `scripts/check-sw-cache-version.js` — service-worker CACHE_VERSION
  bump check
- `scripts/check-production-shell.js` — production shell sanity
- `scripts/check-prod-branch.js` — predeploy branch guard
- `scripts/auth-smoke-d55-snags.sh` — authenticated D.5 lifecycle smoke

**No `auth-smoke-e1-itp.sh` yet.** Should be added with E1a runbook.

---

## 10 · Risks and gaps (prioritised)

### 10.1 · P0 — production blockers

**None observed.** Production is healthy on the unauth path. E1a deploy
should be live (the `/api/audit-log?targetType=itp_instance` route
accepts the new enum value).

### 10.2 · P1 — core workflow / integrity risks

| # | Risk | Source | Mitigation |
| --- | --- | --- | --- |
| P1-1 | E1a shipped without post-merge production smoke. Independence rule + audit-log integration + statsItpsActive enrichment all unverified on production. | [34 §E](34-phase-e-testing-checklist.md) explicitly requires this gate. | Run §E checklist before any E1b code. PR 2 in §17. |
| P1-2 | No `phase-e1-itp-runbook.md`. New domain shipped without a runbook. | All prior phases shipped with one (phase-c-rollout-runbook, phase-d5-runbook, phase-d55-snags-runbook, phase-d6-admin-jobs-index-runbook). | Write as part of PR 2. |
| P1-3 | Phase E plan §15.1 lists 8 open founder calls. The plan says "Must be approved by Oskar before any Phase E build prompt is run." E1a appears to have proceeded with §15.1 defaults applied. | [32 §15.1](32-phase-e-plan.md) | Confirm with Oskar that the defaults are accepted. If 15.1 #3 (50% threshold) or #4 ("Switchboard" label policy) need revisiting, do so before E1c. |
| P1-4 | No authenticated E2E in CI. Five Playwright specs exist; all auth flows `.skip`'d. The only regression net for the rebuild surface is unauth-redirect smoke. | tests/\*.spec.ts | Pre-E2: seed CI test accounts (tradie + admin + LH) and unblock the .skip'd specs. |

### 10.3 · P2 — important hardening

| # | Item | Notes |
| --- | --- | --- |
| P2-1 | No middleware unit tests | `src/middleware.ts` + `src/lib/auth/{permissions,session,current-user,roles}.ts` are the gate for the entire rebuild surface. Tested only via Playwright unauth-redirect smoke. |
| P2-2 | No blob layer unit tests | `api/_lib/blob.js` write-through cache, in-flight dedupe, readBlobFresh — untested. PR #26 hardened a real bug here; regression risk exists. |
| P2-3 | Phil "Snag" UC tab confusing | Could be read as "snags aren't built" when per-job snags ARE built. Relabel to "Snag inbox" or hide until cross-job triage ships. |
| P2-4 | Onboarding "coming soon" copy for ITPs (Step 7 / SiteData) | E1a is merged. Once E1b ships, update Phil onboarding step copy. |
| P2-5 | Authenticated production test data accretion | Phase B/C/D verification sessions left TEST PR5 gear, sn_fbrqxa99 etc. No cleanup endpoints exist. Cosmetic; not blocking. |
| P2-6 | 40+ Claude session worktrees in `.claude/worktrees/` | Bloat; not breaking anything but ~40 working copies on disk. |
| P2-7 | No `auth-smoke-e1-itp.sh` | Pattern-match `auth-smoke-d55-snags.sh`. Add with PR 2. |

### 10.4 · P3 — polish / docs / cleanup

| # | Item | Notes |
| --- | --- | --- |
| P3-1 | Stale local branches | `ui-bible-vnext-implementation`, `phase-e1a-itp-domain-api`, etc. — prune after audit lands. |
| P3-2 | UC sidebar items `href=/command-centre` placeholder | Cosmetic; non-clickable spans don't navigate. Tidy when one of (Snags / Support / Settings) ships. |
| P3-3 | `/buhlos/*` 16-route mirror set in vercel.json | Banned by non-negotiables. Quarantine in Phase G. |
| P3-4 | 25 legacy `public/admin/*.html` pages | Will remain through Phase E. Quarantine pass is Phase G. |
| P3-5 | Phase D plan doc 24 §15.1 had 2 open founder calls. | If still open, surface to Oskar — likely resolved in the operational flow but worth confirming. |

### 10.5 · P4 — future feature work (not now)

E2 (template editor rebuild + cross-job ITP triage), E3 (RFI), E4
(Materials), F (reports, Xero, AI, offline), G (legacy quarantine).
None should open until E1 is fully shipped + stable.

---

## 11 · Phase-by-phase shipped state

| Phase | Slice | Status | PR | Notes |
| --- | --- | --- | --- | --- |
| A | Next.js + TS foundation | ✅ shipped | [#2](https://github.com/oskar-ott/BuhlOS/pull/2) | Parallel to legacy. |
| B | Hours loop | ✅ shipped | [#3](https://github.com/oskar-ott/BuhlOS/pull/3), [#4](https://github.com/oskar-ott/BuhlOS/pull/4), [#7](https://github.com/oskar-ott/BuhlOS/pull/7) | Phil → admin → Phil. Production-hardened. |
| C | Gear loop | ✅ shipped | [#5](https://github.com/oskar-ott/BuhlOS/pull/5), [#6](https://github.com/oskar-ott/BuhlOS/pull/6), [#9](https://github.com/oskar-ott/BuhlOS/pull/9), [#10](https://github.com/oskar-ott/BuhlOS/pull/10) | Asset register + worker reports + mark-good. |
| D1 | Phil jobs read-only | ✅ shipped | [#11](https://github.com/oskar-ott/BuhlOS/pull/11) | |
| D2 | Evidence domain + API | ✅ shipped | [#13](https://github.com/oskar-ott/BuhlOS/pull/13) | |
| D3 | Phil evidence capture | ✅ shipped | [#14](https://github.com/oskar-ott/BuhlOS/pull/14) | |
| D4 | Admin evidence review | ✅ shipped | [#15](https://github.com/oskar-ott/BuhlOS/pull/15) | |
| D5 | Evidence hardening | ✅ shipped | [#16](https://github.com/oskar-ott/BuhlOS/pull/16), [#17](https://github.com/oskar-ott/BuhlOS/pull/17) | Drawer history retry. |
| D.5 | Snags + defects loop | ✅ shipped | [#18](https://github.com/oskar-ott/BuhlOS/pull/18), [#19](https://github.com/oskar-ott/BuhlOS/pull/19), [#20](https://github.com/oskar-ott/BuhlOS/pull/20), [#26](https://github.com/oskar-ott/BuhlOS/pull/26) | BUG-2 read-after-write fix. |
| D6 | Admin jobs index | ✅ shipped | [#21](https://github.com/oskar-ott/BuhlOS/pull/21), [#22](https://github.com/oskar-ott/BuhlOS/pull/22), [#23](https://github.com/oskar-ott/BuhlOS/pull/23), [#24](https://github.com/oskar-ott/BuhlOS/pull/24), [#25](https://github.com/oskar-ott/BuhlOS/pull/25) | canWrite normalisation, doc reconciliation. |
| UI hardening | Interface bible | ✅ shipped | [#30](https://github.com/oskar-ott/BuhlOS/pull/30), [#31](https://github.com/oskar-ott/BuhlOS/pull/31), [#32](https://github.com/oskar-ott/BuhlOS/pull/32) | RSC manifest debt cleared. Phase-letter copy dropped. |
| UI bible vNext | New AttentionBanner + StatusChip + Phil rework | ✅ shipped 2026-05-25 | [#35](https://github.com/oskar-ott/BuhlOS/pull/35) | Lands alongside E1a. Adds two UI primitives + restructures `/phil/my-day`, `/v2/phil`, `/phil/hours`, `PhilJobsList`. |
| Onboarding | Phil 9-screen tour | ✅ shipped | [#33](https://github.com/oskar-ott/BuhlOS/pull/33) | |
| E1 plan | Canonical Phase E plan | ✅ docs | [#28](https://github.com/oskar-ott/BuhlOS/pull/28) | Supersedes PR #27. |
| **E1a** | ITP domain + API extension | **✅ just shipped 2026-05-25 20:42** | [#34](https://github.com/oskar-ott/BuhlOS/pull/34) | **Awaits prod smoke + runbook.** |
| E1b | Phil ITP recording UI | ⏳ next | — | Build prompt: [33 §E1b](33-phase-e-build-prompts.md). |
| E1c | Admin ITP queue + signoff | ⏳ parallel-able with E1b | — | Build prompt: [33 §E1c](33-phase-e-build-prompts.md). |
| E2 | Template editor rebuild | 📋 plan only | — | Separate planning doc not yet opened. |
| E3 | RFI bootstrap | 📋 plan only | — | |
| E4 | Materials rebuild | 📋 plan only | — | |
| F | Reports / Xero / AI / offline | 📋 plan only | — | |
| G | Legacy quarantine | 📋 plan only | — | |

---

## 12 · E1b readiness

**Verdict: NOT YET. Run E1a post-merge production smoke + write
runbook first. THEN E1b can proceed.**

**Blockers (must clear before E1b opens):**

1. Run [34 §E](34-phase-e-testing-checklist.md) production smoke
   against `buhlos.com` for the freshly-deployed E1a build.
2. Write `docs/rebuild-audit/phase-e1-itp-runbook.md` documenting:
   - production deploy URL + commit
   - the auth smoke script command (write `scripts/auth-smoke-e1-itp.sh`)
   - known limitations (E1-L1, E1-L2, ...) as they surface
   - any operational findings from production verification
3. Confirm with Oskar that [32 §15.1](32-phase-e-plan.md) #1-6 defaults
   are accepted (especially the 50% independence-rule threshold and the
   "Switchboard" scope-label rendering).

**Non-blockers (can proceed in parallel with E1b):**

- §15.1 #7 (auto-snag on rejected ITP items) — explicitly deferred to
  post-E1 field observation.
- §15.1 #8 (photo enforcement policy) — same, defer to field
  observation.

**Once blockers clear, E1b prompt in [33 §E1b](33-phase-e-build-prompts.md)
is paste-ready.** Branch: `phase-e1b-phil-itp-ui`.

---

## 13 · Next 5 PRs (paste-ready brief)

### PR 1 · This audit doc

- **Title:** `docs: current product state audit (2026-05-26)`
- **Branch:** `current-product-state-audit`
- **Scope:** This document + an entry in
  [23-rebuild-index.md](23-rebuild-index.md).
- **Out of scope:** Anything else.
- **Files touched:** `docs/rebuild-audit/35-current-product-state-audit.md` (new),
  `docs/rebuild-audit/23-rebuild-index.md` (1-line addition).
- **Tests:** none (docs-only).
- **Merge risk:** None.

### PR 2 · E1a post-merge production smoke + runbook

- **Title:** `docs: phase E1a · ITP runbook + post-merge production smoke`
- **Branch:** `phase-e1-itp-runbook`
- **Scope:**
  - Run [34 §E](34-phase-e-testing-checklist.md) production smoke
    against `buhlos.com` at commit `996d848`.
  - Write `docs/rebuild-audit/phase-e1-itp-runbook.md` (sibling of
    `phase-d55-snags-runbook.md`). Include §1 what shipped, §2 storage,
    §3 permissions, §4 UX rules, §5 open questions, §6 field test
    script, §7 known limitations (E1-L1 through E1-LN as discovered).
  - Add `scripts/auth-smoke-e1-itp.sh` (fork `auth-smoke-d55-snags.sh`).
    Cover the full lifecycle: attach → record 3 point types → witness
    → sign off (no override) → reopen → sign off with independence
    override.
  - Update [23-rebuild-index.md](23-rebuild-index.md) with the new
    runbook entry.
- **Out of scope:** No code changes to `api/job-itps.js` or
  `src/domains/itp/*`. Bug-fixes uncovered during smoke land as
  separate PRs (`phase-e1a-fix-N`).
- **Files touched:** `docs/rebuild-audit/phase-e1-itp-runbook.md` (new),
  `docs/rebuild-audit/23-rebuild-index.md` (index update),
  `scripts/auth-smoke-e1-itp.sh` (new).
- **Tests:** none locally (the script IS the test). Manual production
  smoke before docs land.
- **Merge risk:** Low. Docs + script only.

### PR 3 · E1b — Phil ITP recording UI

- **Title:** `[Phase E1] E1b · Phil ITP recording UI`
- **Branch:** `phase-e1b-phil-itp-ui`
- **Scope:** Per [33 §E1b](33-phase-e-build-prompts.md). Add
  `src/components/phil/JobITPsPanel.tsx` (section on `/phil/jobs/[jobId]`),
  add `src/app/phil/jobs/[jobId]/itps/[instanceId]/page.tsx` server
  component, add `src/components/phil/ITPRecording.tsx` + `ITPPointCard.tsx`.
  Update `scripts/smoke-evidence-routes.js` to include the new HTML
  route (25 checks total).
- **Out of scope:** Admin queue (E1c), template editor (E2), cross-job
  triage (E2), RFI, materials, snag auto-creation on rejected ITP.
- **Files touched:** ~6 new files in `src/components/phil/` + 1 new
  route page + smoke script update + 3 test files.
- **Tests:** unit tests per [34 §B](34-phase-e-testing-checklist.md),
  preview Chrome MCP smoke as tradie Oskar.
- **Merge risk:** Medium. New mobile UI surface; tap-target + RSC
  manifest compliance must be verified in preview before merge.

### PR 4 · E1c — Admin ITP queue + sign-off

- **Title:** `[Phase E1] E1c · admin ITP queue and sign-off`
- **Branch:** `phase-e1c-admin-itp-queue`
- **Scope:** Per [33 §E1c](33-phase-e-build-prompts.md). Add
  `src/app/v2/jobs/[jobId]/itps/page.tsx` server component, add
  `src/components/admin/ITPsQueue.tsx` + `ITPDrawer.tsx` +
  `ITPSignOffModal.tsx`, extend `src/components/admin/JobsList.tsx` with
  an ITPs chip. Update `scripts/smoke-evidence-routes.js` to include the
  admin route.
- **Out of scope:** Phil UI (E1b), template editor (E2), cross-job
  triage (E2).
- **Files touched:** 4 new components + 1 new route page + 1 chip
  extension + smoke script update + 4 test files.
- **Tests:** unit + Chrome MCP preview smoke as admin Tom.
- **Merge risk:** Medium. Independence-rule modal must surface the
  correct branch (threshold met vs not met) and the textarea must be
  required when the rule fires.

### PR 5 · Pick: CI auth fixtures OR middleware tests OR onboarding copy update

This slot is for the highest-friction hardening item Oskar wants
addressed before E2 opens. Options, in rough priority:

#### Option A: CI auth fixtures (highest leverage)

- **Title:** `tests: seed CI test accounts to unblock authenticated Playwright specs`
- **Branch:** `tests-ci-auth-fixtures`
- **Scope:** Add a CI-only seed script (creating one admin, one LH,
  one tradie, one client in a CI-scoped Blob namespace) and update the
  Playwright config to log in via the new `/v2/login` flow. Unblock
  the `.skip`'d hours / capture / review / jobs-index specs.
- **Files:** new `scripts/ci-seed-users.js`, updates to
  `playwright.config.ts` + 5 spec files.
- **Tests:** the unblocked specs themselves.
- **Merge risk:** Medium-high (CI flakiness risk).

#### Option B: Middleware + auth unit tests

- **Title:** `tests: cover middleware + lib/auth/* with unit tests`
- **Branch:** `tests-middleware-auth-units`
- **Scope:** Add `src/middleware.test.ts`, `src/lib/auth/permissions.test.ts`,
  `src/lib/auth/session.test.ts`, `src/lib/auth/current-user.test.ts`.
- **Files:** 4 new test files.
- **Tests:** the new tests themselves.
- **Merge risk:** Low.

#### Option C: Onboarding copy refresh post-E1a

- **Title:** `ui: refresh onboarding step copy now ITPs are live`
- **Branch:** `ui-onboarding-itp-copy`
- **Scope:** Update Step 7 (SiteData) "coming soon" copy for ITPs to
  reflect E1a+E1b shipping. Decide whether to keep RFI mentions or
  defer them until E3.
- **Files:** 2 onboarding step files.
- **Tests:** snapshot update on `steps.test.ts` if needed.
- **Merge risk:** Low.

**Recommendation:** Option A (CI auth fixtures). The skipped Playwright
specs are the biggest regression-coverage gap in the rebuild — six
loops live in production with no authenticated CI net.

---

## 14 · Decisions log / open questions for Oskar

1. **§15.1 (Phase E plan) #1–6.** Confirm defaults are accepted, or
   resolve any that need revisiting before E1c lands. Especially #3
   (50% independence threshold) and #4 ("Switchboard" scope label).
2. **§15.1 #7 + #8.** Continue to defer to post-E1 field observation,
   per plan.
3. **PR 5 pick.** Which hardening track lands first — CI auth fixtures
   (Option A, recommended), middleware tests (Option B), or onboarding
   copy refresh (Option C)?
4. **Worktree cleanup.** Manual cleanup of `.claude/worktrees/` ~40
   stale directories — schedule when?
5. **Phil "Snag" UC tab** — keep / relabel "Snag inbox" / hide?
6. **Doc 24 §15.1 (Phase D plan) open questions** — confirm any
   carry-over.

---

## 15 · Confirmations (from this audit session)

- No app code changed.
- No API code changed.
- No `vercel.json` changed.
- No deploy invoked.
- No production data created.
- No credentials written or echoed.
- The dirty working tree on the primary worktree at audit start was the
  composite WIP of **two concurrent sessions** — one on
  `phase-e1a-itp-domain` (which merged as PR #34 during this audit) and
  one on `ui-bible-vnext-implementation` (which merged as PR #35 a few
  minutes later). The audit doc was written in a separate clean
  worktree at `.claude/worktrees/audit-state-2026-05-26` to avoid
  interfering with those sessions.
- Local `npm run typecheck / lint / test / build` skipped (concurrent
  session writing the same tree). Test coverage assessed by reading
  test files. CI for PR #34 passed cleanly (per `gh pr view`).

---

## 16 · Next prompt (paste-ready)

For the session that runs PR 2 (E1a runbook):

```
You are Claude Code working as the E1a runbook + post-merge production
smoke session for BuhlOS / Phil.

Read first:
  docs/rebuild-audit/35-current-product-state-audit.md  ← this audit
  docs/rebuild-audit/32-phase-e-plan.md
  docs/rebuild-audit/33-phase-e-build-prompts.md
  docs/rebuild-audit/34-phase-e-testing-checklist.md  §E (production smoke)
  docs/rebuild-audit/phase-d55-snags-runbook.md  ← runbook format precedent
  docs/rebuild-audit/phase-d5-runbook.md
  docs/rebuild-audit/phase-d6-admin-jobs-index-runbook.md
  scripts/auth-smoke-d55-snags.sh  ← script format precedent
  api/job-itps.js  ← post-E1a (origin/main at 996d848)
  src/domains/itp/*

Scope:
  1. Run §E production smoke against https://buhlos.com at commit
     996d848. Capture every step's result.
  2. Write docs/rebuild-audit/phase-e1-itp-runbook.md following the
     phase-d55-snags-runbook structure. Include any limitations
     discovered during smoke as E1-L1, E1-L2, etc.
  3. Write scripts/auth-smoke-e1-itp.sh modelled on auth-smoke-d55-snags.sh.
     Cover: attach → record point (3 types) → witness → sign off
     (no override) → reopen → sign off with independence override.
  4. Update docs/rebuild-audit/23-rebuild-index.md with the new
     runbook entry.

Out of scope:
  - Code changes to api/job-itps.js or src/domains/itp/*.
  - E1b / E1c work.
  - E2 / E3 / E4 / F work.

Branch:  phase-e1-itp-runbook
Commit:  docs: phase E1a · ITP runbook + post-merge production smoke
PR title: docs: phase E1a · ITP runbook + post-merge production smoke

Do NOT merge without Oskar review. If smoke surfaces a real bug,
STOP and surface — fix lands as a separate phase-e1a-fix-N PR, not
bundled with this runbook PR.
```

---

## 17 · Cross-references

- [00-executive-summary.md](00-executive-summary.md)
- [10-product-definition.md](10-product-definition.md)
- [20-agent-rules.md](20-agent-rules.md)
- [23-rebuild-index.md](23-rebuild-index.md)
- [32-phase-e-plan.md](32-phase-e-plan.md)
- [33-phase-e-build-prompts.md](33-phase-e-build-prompts.md)
- [34-phase-e-testing-checklist.md](34-phase-e-testing-checklist.md)
- [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md)
- [phase-d6-admin-jobs-index-runbook.md](phase-d6-admin-jobs-index-runbook.md)
- [api/job-itps.js](../../api/job-itps.js)
- [api/_lib/blob.js](../../api/_lib/blob.js)
- [api/_lib/auth.js](../../api/_lib/auth.js)
- [src/middleware.ts](../../src/middleware.ts)
- [src/lib/auth/](../../src/lib/auth/)
- [src/domains/itp/](../../src/domains/itp/)
- [vercel.json](../../vercel.json)
