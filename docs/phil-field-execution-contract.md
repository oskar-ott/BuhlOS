# Phil Field Execution System v1 — Contract & sequencing plan

_Audit + contract only. No runtime code in this PR. Branch `docs/phil-field-execution-contract`._

**Goal:** make a Phil job feel like a **site bible in your pocket** — open a job and know what to do, what's done, what's blocked, and what to log before leaving site — not a desktop dashboard squeezed onto a phone.

This document captures the field-execution audit (2026-06-06, against `main` @ `f47fd86`), the contract a Phil job should expose, the ranked usability gaps, and the safe PR sequence. It exists because the two surfaces a Field Execution build must touch — **capture** (PR #86) and **hours** (PR #57) — are still **open**, so runtime work is sequenced behind them rather than built on shifting ground.

---

## 1. Current state — Phil is already mature and real

The Phil job interface is **not** a stub. `/phil/jobs/[jobId]` → `PhilJobDetail.tsx` is a structured "Job Home" backed by real, persisted data, with honest UC markers where a surface isn't wired. Nothing below is fabricated.

| Surface | Where | Data / storage | State |
| --- | --- | --- | --- |
| Job list | `/phil/jobs` → `PhilJobsList` | `/api/jobs` (scoped to `assignedJobIds`) | **Real**, read-only |
| Job identity / hero | `PhilJobHero` | `/api/jobs` | **Real** |
| Needs attention | `PhilJobAttentionStrip` ← `PhilJobAttention.deriveAttention` | snags + ITPs + induction | **Real** (max 3, every item actionable) |
| Work plan (areas/stages/tasks) | `philJobWorkTree` + `PhilJobAreaCard`/`Detail` ← `effectiveTasks`/`visibleAreaGroups` | `/api/jobs` structure | **Real but READ-ONLY** (no completion) |
| Capture evidence | `CaptureSheet` + `PhilCaptureLauncher` (FAB) + `TodaysCapturesStrip` | `/api/photos` → Vercel Blob, `/api/evidence` → `jobs/{id}/data.json` | **Real**, two-phase persist, honest failure states |
| ITPs / checks | `JobItpPanel` + `ITPRecording` + `ITPPointCard` | `/api/job-itps` → `jobs/{id}/itps.json` | **Real**, worker records points; 50% independence rule (no self-sign-off) |
| Snags / issues | `JobSnagsPanel` + `ReportSnagSheet` | `/api/snags` → `snagsV2[]` | **Real**, worker reports + transitions open→in_progress→resolved; admin-only verify/close/reject |
| Plans / docs | `/phil/jobs/[jobId]/plans` + `JobDocumentsPanel` | `/api/plans` | **Real**, current-only (superseded/archived hidden); opens external viewer |
| Hours | `/phil/my-day` (Standard Day + custom) + `/phil/hours` (history) | `/api/time-entries` | **Real**; job attribution guaranteed non-null (#77); **not on the job screen** |
| Gear | `/phil/gear` → `PhilGearList` | `/api/assets` | **Real**, return / report damaged / missing |
| Materials | `JobMaterialsPanel` | — | **Honest UC stub** (E4 lane) |
| History | `JobHistoryPanel` | (audit-log exists) | **Honest UC stub** (derivable later) |

Nav (`PhilTabBar`): **Today** (`/phil/my-day` = hours) · **Jobs** · **Capture FAB** · **Gear** · **More**. Auth: middleware + RSC + API all gate `/phil/*` to assigned, Phil-capable roles; draft/archived jobs 404 to the field. No admin controls leak into Phil.

---

## 2. Field workflow map

| # | Workflow | Where | Data source | Real/stub | Write? | Offline risk | Test coverage | Biggest on-site issue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Start day / open Phil | `/phil/my-day` | `/api/time-entries` (7d) + `/api/jobs` | Real | Write (hours) | High (2 fetches, no cache) | `LogHoursSheet`/`PhilShell` render tests | No offline fallback; jobs-load failure can block hours submit |
| 2 | Open job | `/phil/jobs/[jobId]` | `/api/jobs` + evidence/snags/itps/docs | Real | Read | Med | route + `PhilJobsList` tests | Lands on "what's wrong", not "what to do today" |
| 3 | Work plan | `PhilJobAreaDetail` ← `effectiveTasks` | `/api/jobs` structure | Real, **read-only** | — | Low | `philJobWorkTree.test`, `builder.test` | **Can't tick tasks done** — `/api/task-toggle` exists but new Phil never calls it |
| 4 | Capture evidence | `CaptureSheet` | `/api/photos`+`/api/evidence` (Blob) | Real | Write | Med-High (no queue) | `philCapture.test` (helpers); no E2E capture chain | CTA mid-page; no offline retry queue |
| 5 | Log hours | `/phil/my-day` `LogHoursSheet` | `POST /api/time-entries` | Real | Write | Med | `time-entry-attribution.test`, `timesheets.test`, field-readiness smoke | Not reachable from the job; **in-flight (#57)** |
| 6 | ITPs / checks | `JobItpPanel`/`ITPRecording` | `/api/job-itps` (Blob) | Real | Write (record) | Med | `itp.test` (state machine + independence) | Stale-read 750ms cross-instance; no E2E |
| 7 | Plans / docs | `/phil/jobs/[jobId]/plans`, `JobDocumentsPanel` | `/api/plans` | Real | Read | Low | `documents.test` | No in-app render (opens external viewer) |
| 8 | Snags / issues | `JobSnagsPanel`/`ReportSnagSheet` | `/api/snags` (Blob) | Real | Write (report+transition) | Med | `snags.test` | No "assigned to me" filter; photo via evidence-link only |
| 9 | Gear / materials | `/phil/gear`; `JobMaterialsPanel` | `/api/assets`; — | Gear Real / Materials UC | Gear write | Med | `gear.test` | Materials UC — worker phones PM |
| 10 | End of day | — | — | **Absent** | — | — | — | **No closeout** prompt (hours? evidence? checks? blockers?) |

---

## 3. Phil job execution contract

What a Phil job should expose to a field worker. (★ = already satisfied today.)

### A. Job context
- ★ jobId, job name, ref, site address
- ★ job status + worker-assignment/visibility state (draft/archived never reach the field)
- current **stage** surfaced at the top (rough-in / fit-off) — *partial: stage chosen inside Work, not in the hero*
- ★ last-updated indicator (real `updatedAt`, no fabrication)

### B. Worker-visible structure
- ★ stages, areas, tasks derived from the **same** source as BuhlOS "What the field sees" (`buildPhilPreview` / `effectiveTasks` / `visibleAreaGroups`)
- ★ archived/draft/admin-only content excluded
- **task completion state** — *missing: tasks are read-only; `/api/task-toggle` is built but unwired in new Phil*

### C. Primary actions (only when backed by real capability)
- ★ Capture evidence (real, job/stage/area/task context)
- Log hours **for this job** — *missing on the job screen (lives on Today tab); #57 in-flight*
- ★ View plans / docs
- ★ Complete check / record ITP point (respects independence rule)
- ★ Report snag / issue
- Add note — *via capture note only; no standalone note*

### D. Operational state
- ★ what needs attention (rejected snags, assigned-to-me, pending ITPs, induction)
- what is **completed** vs **pending** — *partial: ITP/snag states real; task completion missing; History UC*
- ★ what is blocked (rejected snags surfaced first)
- what is **missing before leaving site** — *missing: no end-of-day closeout*

### E. Honest limitations (must stay honest — never fake)
- ★ Materials: "lives on the office app, phone your PM" (UC)
- ★ History: UC until a worker-friendly audit-log feed lands
- ★ Capture failure shows failure; never a fake "saved"
- ★ ITP sign-off blocked for self-review without override
- **Offline/sync is NOT supported** — all reads are server-render, all writes are online-only POST; this must be stated, not hidden

---

## 4. Top 10 field usability gaps (ranked)

Ranked by on-site severity × abandonment risk × execution value × (data already exists) × (reduces calls to Tom/admin), tempered by ease/safety.

1. **Task completion is dormant.** `/api/task-toggle` is functional but only legacy `public/phil.html` calls it; the new Phil renders tasks read-only. An electrician literally cannot mark work done — the core "site bible" action. *Data+API exist; medium build (write UI + per-task state); high value; cuts "is X done?" calls.*
2. **No "Today / Next actions" hub.** Opening a job leads with what's *wrong*, then Site/Areas before the Capture CTA. No positive "what to do next." *Derivable from existing data; easy-medium; high abandonment-prevention.*
3. **No end-of-day closeout.** Nothing prompts "hours logged? evidence captured? checks done? anything blocked?" before leaving site. *Derivable read-only summary; medium; cuts missing-timesheet chases; safety-adjacent.*
4. **No offline / sync.** Dead-signal sites make the app unusable (reads server-render; writes online-only; no queue/SW/IndexedDB). *High severity + abandonment, but large infra; its own lane.*
5. **No in-job hours action.** Hours only on the global Today tab; "log hours for this job" means leaving job context. *Easy once #57 lands; blocked now.*
6. **Capture CTA buried mid-page (~section 7/12).** The primary daily action sits below Site + Areas; the global FAB mitigates but the in-job CTA is low. *Easy; touches #86 surface.*
7. **Current stage not surfaced at the top.** Rough-in vs fit-off is chosen inside Work, not shown at a glance. *Easy clarity win.*
8. **History is UC.** "What's been completed" is only visible to admins via per-item drawers; could be a real worker feed from the append-only audit-log. *Medium; data exists.*
9. **Materials is UC.** Worker can't request materials in-app (phones PM). *Bigger E4 lane; lower priority per existing docs.*
10. **No crew visibility.** Worker can't see who else is on the job. *Low value; external comms acceptable.*

---

## 5. Recommended PR sequence

**Hard prerequisite:** land the two open Phil PRs first so capture/hours/smoke stop moving —
- **#86** `feat/phil-capture-shutter-v1` (owns `src/domains/evidence/phil-capture.ts`, `PhilTabBar.render.test.tsx`, `tests/playwright/smoke/phil.spec.ts`)
- **#57** `pr-hours/complete-hours-system` (owns `/phil/hours`, `/phil/my-day`, `LogHoursSheet.tsx`)

Then, smallest-safe-first:

1. **`feat/phil-job-action-hub`** (gap #2, #6, #7) — a top-of-job "Today / Next actions" hub. Pure tested helper `philJobNextActions(job, {snags, itps, evidence, documents, viewer})` → ordered actions (Capture / Log hours / Complete check / View plans / Continue task / Report issue), each with an honest disabled/empty state. Reuses the existing in-component `CaptureSheet` + section anchors; links hours to the (now-stable) `/phil/hours`. Render + unit tests; **no** edit to `phil.spec.ts`/capture/hours files.
2. **`feat/phil-worker-visible-tasks`** (gap #1) — wire `/api/task-toggle` into `PhilJobAreaDetail` so a worker can mark a task done, with real per-task state (no fake progress). Its own design review (this is a *write* path); respects role gating.
3. **`feat/phil-end-of-day-closeout`** (gap #3) — a read-only "before you leave" summary on the job (and/or Today): hours logged today? evidence captured? required checks open? blockers? Derived from real data; links, not new writes.
4. **`feat/phil-offline-resilience`** (gap #4) — separate infra lane: capture/write queue + retry; out of scope for v1 tightening.

Already shipped & real → **no dedicated PR** (the action hub just surfaces them better): capture (Path C), ITPs (Path D), plans (Path E), snags. Materials (gap #9) and a worker History feed (gap #8) are later lanes.

---

## 6. Constraints honoured by this plan

- No change to the Phil hours write flow, `/api/time-entries` POST, or the attribution helper (`src/domains/qa/time-entry-attribution.ts`).
- No change to auth/role boundaries; no admin controls in Phil.
- No fake task completion / evidence upload / ITP sign-off / progress.
- No global Evidence module; no AI/OCR/plan markup; no app-shell over-refactor.
- Each lane stays a small, reviewable, real-data slice with honest empty/deferred states.

---

## 7. Conflict / sequencing note (why this is contract-only today)

`main` @ `f47fd86` (after #89, the BuhlOS operational-loop, merged). The core Phil job screen (`PhilJobDetail`, route, work-tree, panels, capture sheet, ITP, snags) is owned by **no** open PR — but **#86 (capture + `phil.spec.ts`)** and **#57 (hours)** are still open and own the two headline actions a Field Execution build must wire. Building now risks collisions and rework. This contract sequences the work so that, once #86 and #57 land, the action hub (PR 1 above) is a turnkey, collision-free slice.
