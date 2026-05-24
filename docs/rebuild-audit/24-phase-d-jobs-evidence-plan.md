# 24 · Phase D — jobs and evidence loop plan

> **Status:** Planning. No code in scope. Authored on `phase-d-jobs-evidence-plan` branch from `origin/main` (Phase B + production hardening). Phase C (My Gear) is in PR #5 and assumed merged before Phase D begins. **This plan must be approved by Oskar before any Phase D build prompt is run.**
>
> **Read first:** [10-product-definition.md](10-product-definition.md), [11-operational-workflow-map.md](11-operational-workflow-map.md) #7, #9, #10, #11, #19, #20, [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) §Jobs / §Evidence, [13-ui-information-architecture.md](13-ui-information-architecture.md) §Phil / §Jobs / §Defects, [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md), [16-migration-strategy.md](16-migration-strategy.md) §B, §C.3, [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) §C.4, [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md) (format precedent), [20-agent-rules.md](20-agent-rules.md), [21-rebuild-decision-record.md](21-rebuild-decision-record.md) ADR-011.

---

## 1 · Executive summary

Phase D ships the third closed operational loop in the rebuild: **job context → field evidence capture → admin review**. It is the loop that converts the Phil shell from a hours+gear utility into a real on-site companion that knows what job the worker is on and what they're proving.

**What Phase D is.** A Phil worker opens a job assigned to them, sees the relevant job context (address, site notes, access notes, stages/areas), captures evidence (photo + note) attached to a job (and optionally a stage or task), and an admin reviews that evidence on the new admin Jobs surface. Status is visible to both sides. The loop closes end-to-end.

**Why it comes after My Gear.** Hours (Phase B) proved the loop pattern; Gear (Phase C) proved the assignment + accountability pattern. Both are field-shaped and admin-counterparted but their data model is contained. Jobs is the centre of gravity for every other workflow ([10-product-definition.md] §A) — it has to be solid before plans, ITPs, RFIs, variations, or materials can hang off it ([21-rebuild-decision-record.md] ADR-011). Evidence is the smallest possible payload that exercises the job domain end-to-end without dragging in the snag triage queue, Job Builder mutations, plans, or ITPs.

**Operational loop Phase D creates.**

```
Admin job data exists (legacy /api/jobs unchanged)
  → Phil worker opens an assigned job
    → worker sees address, access notes, stages, areas
      → worker captures evidence (photo + note) on job [/stage/task]
        → evidence persists to Vercel Blob
          → admin sees evidence on /jobs/:jobId
            → admin reviews / rejects / marks reviewed
              → field data accumulates against the real job entity for
                Phase E ITPs / RFIs / handover-readiness / reporting.
```

**Recommended scope (concise):** Jobs (read-only from existing legacy API) + Phil job context view + Evidence capture (photo + note) + Admin evidence review surface + a one-click task completion toggle. **Snag triage lifecycle, Job Builder mutations, plans/documents, ITPs, RFIs, variations, and materials are explicitly deferred.** This is narrower than the Phase D scope hinted at in [11-operational-workflow-map.md] (which bundles snags) and [12-domain-model-deep-dive.md] §C.D (which mentions `Defect` as Phase D). See §13 (Build sequence) and §15 (Open decisions for Oskar) for the rationale; the bundling is the single biggest scope question this plan flags.

---

## 2 · Scope

### 2.1 In scope (Phase D ships these end-to-end)

**Phil (mobile):**

- `/phil/jobs` — list of jobs assigned to the current worker. Status pill, address, last-activity timestamp. Empty state when no jobs assigned.
- `/phil/jobs/[jobId]` — single-job context view. Header (name, address, status). Site notes + access notes + parking notes block. Stages strip (read-only). Areas grid (read-only, for context only). Quick-action floating bar: **Capture evidence**, **Mark task done** (if any tasks are visible).
- `/phil/jobs/[jobId]/capture` (or a sheet modal launched from job detail) — photo + 1-line note + (optional) stage/task picker → submit. Photo required. Upload progress + pending state visible. Failure recovery (retry without losing the captured image).
- A `pending_sync` indicator on any evidence item that hasn't yet been confirmed by the server (no offline-first sync engine in Phase D — just a clear in-memory pending state that survives a retry but not a kill).
- A small `Evidence I captured today` strip on the job detail showing the worker their own recent captures.

**Admin (desktop):**

- `/jobs` — admin jobs list (active jobs first). Columns: name, status, PM, address, evidence count this week, last activity. Filter by status, PM, evidence-pending-review.
- `/jobs/[jobId]` — admin job detail. Header (name, address, status, PM). Tabs or stacked sections: **Overview** (read-only structure: stages, areas), **Hours** (read-only roll-up from Phase B — link out is acceptable in Phase D), **Evidence** (new — list of captured evidence with photo thumb, note, captured-by, captured-at, target stage/task, review state).
- `/jobs/[jobId]/evidence` — focused evidence review page (or panel) with review actions: mark reviewed, reject with reason. Bulk select for mark-reviewed on multiple items.
- `/activity` (existing audit surface, light Phase D contribution) — surfaces "evidence captured", "evidence reviewed", "evidence rejected" events from the unified `AuditLog`. This is Phase D's bootstrap of the unified audit log per [12-domain-model-deep-dive.md] §C.D.

**Cutovers Phase D performs** (per [16-migration-strategy.md] §C.3, executed one rewrite at a time, each its own PR):

- `/admin/jobs → /jobs` (Next.js owns). Legacy `public/admin/jobs.html` quarantined to `/legacy/admin-jobs` for one billing cycle.
- `/admin/jobs/:jobId → /jobs/:jobId` (Next.js owns). Legacy `public/admin/job.html` (4,772 lines) quarantined to `/legacy/admin-jobs/:jobId`.
- `/admin/activity → /activity` (Next.js owns) — small surface, mostly a feed.
- `/admin → /command-centre`: **gated on Phase E shipping enough sections that the new Command Centre has feature parity.** **Do not cutover `/admin` in Phase D.**

**Cutovers Phase D does NOT perform:**

- `/jobs` (the Phil-facing legacy `/jobs → /admin/jobs.html` rewrite) — this needs PM/Phil disambiguation. Defer.
- `/admin/snags`, `/admin/plans`, `/admin/itp`, `/admin/job-builder`, `/admin/crew`, `/admin/variations`, `/admin/materials`, `/admin/operations` — Phase E or later. Section-by-section per [16-migration-strategy.md] §C.3.

### 2.2 Out of scope (deliberately)

**Bundled with Phase D in earlier docs — deferred here:**

- **Snag triage lifecycle** ([11-operational-workflow-map.md] #12, [12-domain-model-deep-dive.md] §`Defect`). Has its own state machine (`open → assigned → in_progress → fixed → verified → closed | wont_fix`), priority, assignment, close-reason, notification cron, and admin triage queue. Phase D scopes this out; the snag capture flow on Phil and the admin triage UI are deferred to **Phase D.5** (a dedicated post-Phase-D PR) or **Phase E adjacent**. See §15 (Open decisions for Oskar) — this is the single biggest scope question.
- **Job Builder mutations** ([11-operational-workflow-map.md] #7, [12-domain-model-deep-dive.md] §`Job`). Creating jobs, editing stages, editing areas, editing tasks, templating, scope modules. The legacy `public/admin/job.html` (4,772 lines) and `public/admin/job-builder.html` continue to serve until a dedicated rebuild slice (post-Phase-D). Phase D consumes `/api/jobs` **read-only**; no patch endpoints are written.
- **Worker assignment to a job** ([11-operational-workflow-map.md] #9). Legacy `public/admin/crew.html` continues; Phil reads its result via existing endpoints.
- **Stage/area mutations.** Admin can view but not edit stages/areas in Phase D.

**Always out of scope for Phase D:**

- Full plans / documents loop ([11-operational-workflow-map.md] #16–#18). Phase E.
- Full ITP system ([11-operational-workflow-map.md] #15). Phase E.
- Full RFI system ([11-operational-workflow-map.md] #21). Phase E.
- Full materials request / delivery ([11-operational-workflow-map.md] #13–#14). Phase E.
- Variations ([11-operational-workflow-map.md] #22). Phase E.
- Handover readiness checklist ([11-operational-workflow-map.md] #23). Phase E.
- AI plan interpretation. Phase F+.
- Xero / payroll integration. Phase F+.
- Reporting / business intelligence layer. Phase F+.
- Final `/login`, `/phil`, `/admin` route cutover finalisation beyond the specific `/admin/jobs`, `/admin/jobs/:jobId`, `/admin/activity` cutovers listed in §2.1.
- Offline-first sync engine. A simple `pending_sync` indicator is fine; a real durable queue + conflict resolution is Phase F+ and explicitly avoided in Phase D.
- Replacing `/api/data` (the full-document write endpoint) wholesale. Phase D may add **one** narrow patch endpoint for evidence if existing endpoints are unsuitable (see §9) — but only if approved per [20-agent-rules.md] #31 and ADR-002.

---

## 3 · Operational loop

```
ADMIN-SIDE STATE EXISTS (legacy backbone)
  Job rows in jobs.json + per-job jobs/{id}/data.json
  with name / address / siteNotes / accessNotes / stages / areas / tasks
  populated via the legacy Job Builder (UNCHANGED in Phase D).

  ↓

PHIL WORKER OPENS PHIL
  GET /phil/jobs
    → list of jobs where workers[].userId == me (filtered server-side
      by the existing endpoint or — if not — client-filtered with a flag
      to harden in a follow-up; see §15 open decision 3).

  ↓

WORKER OPENS A SINGLE JOB
  GET /phil/jobs/[jobId]
    → single-job header + site/access notes
    → stages strip + areas grid (read-only)
    → "Capture evidence" floating CTA
    → optional "Mark task done" rows for tasks assigned to me on
      the currently active stage/area.

  ↓

WORKER CAPTURES EVIDENCE
  Tap "Capture evidence" → opens capture sheet (full-screen modal)
    1. Camera input (default rear camera, file input fallback)
    2. Client-side resize to 1920px @ 0.7 jpeg quality (~300–700KB)
    3. Optional: pick stage and/or task to attach to
    4. 1-line note (text input, ≤ 280 chars)
    5. Tap Submit
  POST /api/photos?jobId=... action=upload-evidence-photo
    (mirrors the existing snag/itp photo pattern in api/photos.js)
    → returns { id, url, capturedAt }
  POST /api/jobs/[jobId]/evidence  (new patch endpoint — see §9)
    body: { kind: 'photo', photoId, photoUrl, note, stageId?, taskId? }
    → returns { evidenceId, status: 'submitted' }
  UI flips the item from `pending_sync` → `submitted`.
  On failure: stays `pending_sync`, retry available, note + image
    preserved in component state for retry.

  ↓

EVIDENCE ATTACHED TO JOB/STAGE/TASK
  Persisted in jobs/{jobId}/data.json under `evidence[]` (or a
  sibling key — see §9.4 / §15 open decision 2 for storage shape).
  AuditLog write: { action: 'evidence.captured', actor, jobId, evidenceId }.

  ↓

ADMIN SEES EVIDENCE
  GET /jobs/[jobId]/evidence
    → list of evidence items with photo thumb, note, target, captured-by,
      captured-at, current review status.
  Admin actions:
    - Mark reviewed → POST /api/jobs/[jobId]/evidence/[evidenceId]/review
        body: { status: 'reviewed' }
    - Reject with reason → POST .../review
        body: { status: 'rejected', reason: '...' }
  Both writes AuditLog.

  ↓

EVIDENCE BECOMES USEFUL DOWNSTREAM
  Phase E ITPs can attach evidenceIds[] when worker submits an ITP.
  Phase E RFIs can attach evidenceIds[] when raising.
  Phase E handover-readiness can require N reviewed evidence per stage.
  Phase F reports aggregate captures-per-job, review SLA, etc.
```

The loop closes through both surfaces ([10-product-definition.md] §A: "a feature is not done until its loop closes through both surfaces"). It is the smallest closed loop that exercises the `Job` domain entity end-to-end without dragging in a separate state machine.

---

## 4 · Routes

Per [14-technical-architecture-deep-dive.md] §C and [16-migration-strategy.md] §C, every new Next.js route is either (a) on a safe path that `vercel.json` does not claim, or (b) is being introduced together with a rewrite removal in the same PR (the cutover pattern).

### 4.1 Phil routes (new — no vercel.json collision)

| Route | Owner | Notes |
| --- | --- | --- |
| `/phil/jobs` | Next.js | Safe — `vercel.json` does not claim `/phil/jobs`. |
| `/phil/jobs/[jobId]` | Next.js | Safe. |
| `/phil/jobs/[jobId]/capture` | Next.js (route OR full-screen modal) | Implementation choice. Modal is preferred to keep the URL stable on retry; if a route is used, it is a `(.)capture` parallel route or a dedicated subroute. Either way no `vercel.json` collision. |

Phil bottom tab bar gets a **Jobs** tab live (per [13-ui-information-architecture.md] §Phil tabs — currently UC until Phase D).

### 4.2 Admin routes (new — Phase D performs the cutovers)

| Route | Owner before Phase D | Owner after Phase D | Cutover PR |
| --- | --- | --- | --- |
| `/jobs` | `vercel.json → /admin/jobs.html` (legacy) | Next.js | PR-D4 (after preview verification of the new page) |
| `/jobs/[jobId]` | `vercel.json → /project.html` (legacy) | Next.js | PR-D4 (same cutover batch) |
| `/jobs/[jobId]/evidence` | Next.js (new sub-route — safe) | Next.js | Ships with PR-D4 |
| `/activity` | `vercel.json → /admin/activity.html` (legacy) | Next.js | PR-D5 (separate cutover) |

**Pre-cutover work-around:** the new admin Jobs surface is first built and verified on **`/v2/jobs`** (or `/admin-v2/jobs` — see §15 open decision 4). Once verified on preview, PR-D4 removes the `vercel.json` rewrite for `/jobs` and `/jobs/:jobId` in the same atomic commit. The legacy HTML moves to `/legacy/admin-jobs` and `/legacy/admin-jobs/:jobId` for one billing cycle, then is deleted per [16-migration-strategy.md] §A principle 5.

**Cutover NOT performed in Phase D:** `/admin`, `/admin/operations`, `/admin/job-builder`, `/admin/snags`, `/admin/plans`, `/admin/itp`, `/admin/crew`, `/admin/variations`, `/admin/materials`, `/admin/quotes`, `/admin/reports`, `/admin/settings`, `/admin/support`, `/admin/temps`, `/admin/assets`, `/admin/hours`, `/admin/approvals`, `/admin/cash`, `/admin/suppliers`. All defer to Phase E or later.

### 4.3 Legacy routes preserved (must keep working)

Phase D may not break any of:

- `/login`, `/v2/login`
- `/`, `/phil`, `/phil/app`, `/phil/login`, `/my-day`, `/my-gear`, `/phil-hours`
- `/lh`, `/lh-home`
- `/install`, `/client`, `/client/jobs/:jobId`
- `/admin`, `/admin/operations`, `/admin/approvals`, `/admin/snags`, `/admin/plans`, `/admin/itp`, `/admin/job-builder`, `/admin/crew`, `/admin/variations`, `/admin/materials`, `/admin/quotes`, `/admin/quotes/:quoteId`, `/admin/hours`, `/admin/reports`, `/admin/settings`, `/admin/support`, `/admin/assets`, `/admin/temps`, `/admin/cash`, `/admin/suppliers`
- `/buhlos/*` mirror routes (slated for deletion in Phase G — untouched in Phase D)
- `/dev/*`, `/admin-legacy`, `/overview`, `/approvals`
- `/command-centre`, `/v2/phil`, `/phil/my-day`, `/phil/hours`
- All `/api/*` endpoints unchanged in Phase D except where §9 explicitly approves a new patch endpoint.

`scripts/check-route-collisions.js` (per [17-testing-and-quality-plan.md] §B.11) must pass on every Phase D PR.

### 4.4 Phil tab bar after Phase D

Per [13-ui-information-architecture.md] §Phil tabs:

1. **Today** — `/phil/my-day` (live since Phase B)
2. **Jobs** — `/phil/jobs` (live in Phase D — was UC)
3. **Gear** — `/phil/gear` (live since Phase C — assumed merged)
4. **Snag** — `/phil/snags` (**REMAINS UC** in Phase D — see §15 open decision 1; if snags are deferred, the tab stays UC with the consistent UC pill)
5. **More** — `/phil/more` (live since Phase A / B)

If the user decides snags ship in Phase D (overriding this plan's recommendation), the Snag tab flips to live in the same Phase D PR set.

---

## 5 · Data model

All shapes live in `src/domains/jobs/schema.ts` and `src/domains/evidence/schema.ts` as Zod schemas; types derive via `z.infer<>`. Field set follows [12-domain-model-deep-dive.md] §Universal field set and §Jobs / §Evidence.

### 5.1 `Job` (read-only consumption in Phase D)

```
Job
  id                  string (nanoid)
  organisationId      string                           — always set
  name                string                           — required
  jobNumber           string?                          — legacy `ref` field
  clientId            string?
  clientName          string?
  address             string?
  siteAddress         string?                          — legacy field (often same as address)
  siteContactName     string?
  siteContactPhone    string?
  accessNotes         string?                          — long text
  parkingNotes        string?
  safetyNotes         string?
  inductionRequired   boolean?
  startDate           string?  (YYYY-MM-DD)
  dueDate             string?  (YYYY-MM-DD)
  status              enum('draft','active','on_hold','complete','archived')
  modules             { areas, snags, photos, hours, materials, tags,
                        temps, plans, contacts, switchboards, circuits,
                        itps, levels }  (per existing api/jobs.js sanitizeModules)
  assignedWorkerIds   string[]                         — IDs of workers
                                                        currently assigned
  createdBy           userId
  createdAt           ISO
  updatedBy           userId
  updatedAt           ISO
  auditLogIds         string[]                         — back-references
```

Source: existing `jobs.json` + `jobs/{id}/data.json`. Phase D reads via `/api/jobs` (list) and `/api/jobs?id=<jobId>` or equivalent (detail; verify exact endpoint shape during PR-D1).

### 5.2 `JobStage` (read-only)

```
JobStage
  id            string
  jobId         string
  name          string                                 — e.g. "Rough-in"
  sequence      number
  status        enum('not_started','in_progress','complete')
  targetDate    string? (YYYY-MM-DD)
  completedAt   ISO?
```

Source: nested in `jobs/{id}/data.json.stages`. **Phase D flattens to a typed shape in the client** but does not promote storage to first-class rows (that's the broader Phase D scope rejected in §2).

### 5.3 `JobArea` (read-only)

```
JobArea
  id           string
  jobId        string
  name         string                                  — e.g. "Master Bedroom"
  sequence     number
  status       enum('not_started','in_progress','complete')
  stageScope   string[]?
```

Source: nested in `jobs/{id}/data.json.areas` (or `dwellings` — verify legacy naming). [12-domain-model-deep-dive.md] §`JobArea`.

### 5.4 `JobTask` (read-only + status toggle only)

```
JobTask
  id            string
  jobId         string
  stageId       string
  areaId        string
  name          string
  status        enum('not_started','in_progress','complete')
  assignedTo    userId?
  evidenceIds   string[]?                              — back-reference
```

Source: nested in `jobs/{id}/data.json.dwellings[areaId].<stage>.tasks` (per existing `api/task-toggle.js` shape). Phase D allows status toggle via existing `POST /api/task-toggle` only — no other mutations.

### 5.5 `EvidenceItem` (NEW in Phase D)

```
EvidenceItem
  id                string (nanoid)
  organisationId    string                             — always set
  jobId             string                             — required
  stageId           string?                            — optional attachment
  taskId            string?                            — optional attachment
  kind              enum('photo','note')               — Phase D ships 'photo' only;
                                                        'note' shape reserved
  photoId           string?                            — references the
                                                        uploaded blob's photoId
  photoUrl          string?                            — public Vercel Blob URL
  thumbnailUrl      string?                            — same URL Phase D
                                                        (no separate thumb pipeline)
  note              string  (≤ 280 chars)              — optional, but if
                                                        photoless, required
  capturedById      userId                             — required
  capturedByName    string                             — denormalised for read
  capturedAt        ISO                                — required
  exifLocation      { lat: number, lng: number }?      — if available; not required
  status            enum('draft','uploading','pending_sync','submitted',
                          'reviewed','rejected')
  reviewedById      userId?                            — set when status='reviewed'|'rejected'
  reviewedAt        ISO?
  rejectionReason   string?                            — required when status='rejected'
  auditLogIds       string[]
  createdAt         ISO
  updatedAt         ISO
```

Status transitions:

```
draft         ─(client sets pre-upload)──→ uploading
uploading     ─(photo POST ok)─────────────→ pending_sync
pending_sync  ─(evidence POST ok)──────────→ submitted
pending_sync  ─(evidence POST fails)───────→ pending_sync (retryable)
submitted     ─(admin reviews)─────────────→ reviewed
submitted     ─(admin rejects with reason)→ rejected
rejected      ─(worker recaptures)─────────→ submitted (new EvidenceItem; old is kept)
```

`draft` and `uploading` are **client-only states** that never persist to the server. They exist for UX (capture pending, upload-in-progress indicators). The server only knows about `pending_sync` (a soft state during the brief gap between photo POST and evidence POST, primarily a UI signal) and beyond.

### 5.6 `Note` (reserved shape, not built in Phase D)

[12-domain-model-deep-dive.md] §`Note` is reserved for Phase D per the audit but the user's scoped brief defers note-only evidence. The Zod schema in `src/domains/evidence/schema.ts` allows `kind: 'note'` so it's a one-line addition later; **no note-only UI ships in Phase D**.

### 5.7 `Defect` / snag (NOT built in Phase D — see §15 open decision 1)

Reserved per [12-domain-model-deep-dive.md] §`Defect`. If Oskar overrides the scope split and includes snags in Phase D, the schema lands then.

### 5.8 `AuditLog` (bootstrap unified table in Phase D)

Per [12-domain-model-deep-dive.md] §`AuditLog` and the Phase B brief deferring this to Phase D. Schema:

```
AuditLog
  id           string (nanoid)
  actorId      userId
  action       string                                  — 'evidence.captured',
                                                        'evidence.reviewed',
                                                        'evidence.rejected',
                                                        'task.toggled'
  targetEntity string                                  — 'evidence' | 'job' | 'jobTask'
  targetId     string
  jobId        string?
  at           ISO
  before       unknown?
  after        unknown?
  reason       string?
  metadata     Record<string,unknown>?
```

Storage: append-only blob at `audit/{yyyy-mm}.json` (one file per month, per [12-domain-model-deep-dive.md] migration plan). Per-domain legacy audit files (`users/<userId>/time-entries-audit/<yyyy-mm>.json`) continue in parallel; consolidation happens in Phase E.

### 5.9 Fields that MUST NOT be skipped

Per [12-domain-model-deep-dive.md] §"Fields that must NOT be skipped":

- `auditLogIds` on every `EvidenceItem`.
- `createdBy` + `updatedBy` on every row.
- `status` on every entity with a lifecycle (Job, EvidenceItem).
- `reviewedBy` on `EvidenceItem` when reviewed/rejected.
- `jobId` on every operational row (EvidenceItem, AuditLog when scoped).

---

## 6 · Admin / Phil split

### 6.1 What Phil sees

- **Only jobs assigned to me** (filtered server-side by user ID; if the existing endpoint can't filter, harden in a Phase D follow-up — see §15 open decision 3).
- Mobile-first portrait layout, ≥360px wide.
- One-thumb operation. 48px+ tap targets per [13-ui-information-architecture.md] §Phil.
- Sunlight-legible (high contrast tokens already established).
- **No queue counts, KPIs, charts, admin meta-features.** Per [10-product-definition.md] §C and [13-ui-information-architecture.md] §Phil.
- **No other workers' captures.** A worker sees their own captures and the captures of the team marked publicly on the job — Phase D defaults to **own captures only** on the Phil job detail "Today's captures" strip. (See §15 open decision 5.)
- **No PM-only data:** profitability, hours roll-up, snag triage, evidence-rejected-by-admin-without-context.
- **No rejection reason without polish:** when an admin rejects an EvidenceItem, Phil shows a small inline reason on the worker's "my evidence" history — *not* a notification bubble or a banner blocking their work.

### 6.2 What admin sees

- **All jobs** (org-scoped).
- Desktop-first layout, ≥1280px per [13-ui-information-architecture.md] §Admin.
- Dense tables, status pills (consistent tone mapping per [13-ui-information-architecture.md] §Visual tokens).
- Evidence review surface with filters (by job, by stage, by reviewer-pending, by date).
- Real counts derived from real data — no fake metrics, no fixtures hidden behind a missing banner.
- Search (basic): job name + jobNumber substring.

### 6.3 What both surfaces share

- Brand tokens.
- Same `Job` / `EvidenceItem` types from `src/domains/`.
- Same Zod validation at API boundary.
- Same `AuditLog` write pattern.
- Same DemoModeBanner discipline — once Phase D wires real data, the banner is OFF for jobs and evidence.

---

## 7 · UI / state requirements

Every screen in Phase D must support all of these states explicitly. Per [13-ui-information-architecture.md] §Foundational rules and [20-agent-rules.md] #17.

| State | When | Visual treatment |
| --- | --- | --- |
| **Loading** | Initial fetch + after mutation while waiting | Skeleton blocks; never a blank panel; never a generic "Loading…" |
| **Empty** | Real fetch returned zero results | Plain prose ("No jobs assigned yet." / "No evidence captured today.") + (admin only) a tertiary "+ New evidence" hint where appropriate. No fake CTAs. |
| **Error** | Fetch failed (network / 5xx / schema mismatch) | Banner with the underlying message + Retry button. Never silent fallback to fixtures. |
| **Ready** | Data loaded, no mutation in flight | Normal render |
| **Submitted / saved** | Just-submitted EvidenceItem visible inline | Brief affirmative status pill ("Submitted") that decays into the normal status pill after 1.5s |
| **Upload pending** | EvidenceItem photo POST in flight | Inline progress bar on the EvidenceItem placeholder; capture sheet stays open until success or explicit cancel |
| **Pending sync** | Photo POST done, evidence POST in flight or failed | Item shows `pending_sync` pill (warning tone); retry button accessible; original photo + note preserved in component state |
| **Under construction** | Anywhere Phase D's scope doesn't cover | `UnderConstructionPanel` — never `alert()`, never a placeholder modal that says "coming soon" (per [20-agent-rules.md] #16) |

Phil specifically also needs:

- **Offline display state** (visible only, not a sync engine): when `navigator.onLine === false`, top-of-screen banner "Offline — captures will sync when reconnected" + capture button still enabled (capture goes to `pending_sync` until online).

### 7.1 Demo-mode banner discipline

Per [21-rebuild-decision-record.md] ADR-015 and [13-ui-information-architecture.md] §Banned patterns:

- `src/domains/jobs/fixtures.ts` and `src/domains/evidence/fixtures.ts` exist for Storybook / preview only.
- `fixtures.isDemoMode()` returns `false` for both domains in production after Phase D wires real data.
- `DemoModeBanner` is visible during the development phase; the Phase D exit criteria require the banner to be **off** on `/phil/jobs`, `/phil/jobs/:id`, `/jobs`, `/jobs/:id`, `/jobs/:id/evidence`.

---

## 8 · Evidence capture rules

These are binding for the Phase D capture flow:

1. **Photo is required for `kind: 'photo'` evidence.** Note alone is reserved (`kind: 'note'`) but not shipped in the Phase D UI.
2. **Note is optional but encouraged.** 280-char limit. If included, sanitised server-side.
3. **Attach to job is always required.** Attach to stage and/or task is optional but offered prominently when an active stage/task can be inferred from worker assignment.
4. **Timestamp and user metadata are server-set.** Client cannot override `capturedAt` or `capturedById`. Client-set timestamp is recorded as `clientCapturedAt` (metadata only) for debugging.
5. **Client-side resize before upload.** Target 1920px max dimension, JPEG quality 0.7, ~300–700KB. Mirrors existing `api/photos.js` expectation. Prevents 6MB upload payloads.
6. **Upload progress is visible.** The capture sheet stays open until success (or explicit cancel) and shows progress percentage.
7. **Failure recovery preserves the captured image.** If photo POST fails, the image stays in component state for retry. Worker is not forced to retake.
8. **Pending sync state survives within a tab session.** If the evidence POST fails after photo POST succeeds (orphan photo), the EvidenceItem stays `pending_sync` with the `photoId` already returned, and retry sends only the evidence POST (not a duplicate photo upload). Tab close = state lost (Phase D accepts this; offline-first sync is Phase F+).
9. **No loose photo dump.** Photos cannot exist in `jobs/{id}/photos/` without a corresponding `EvidenceItem` row pointing to them. The legacy `photos-index.json` per-dwelling shape is **NOT** reused for Phase D evidence — Phase D writes a new key (`jobs/{id}/evidence.json` or appends to `data.json.evidence[]` — see §9.4).
10. **Server validates** `jobId` exists, `stageId` (if provided) belongs to `jobId`, `taskId` (if provided) belongs to `jobId` and `stageId`. Server rejects mismatches with 400; client never gets to an inconsistent state.
11. **Photo size cap server-side: 6MB** (matches existing `api/photos.js` ceiling). Returns 413 if exceeded.
12. **No EXIF stripping** in Phase D (preserved for future evidence-of-place verification). Server stores blob URL only; metadata stays in the file.
13. **AuditLog write on capture, review, and reject.** Three events, three rows.

---

## 9 · Storage / API strategy

### 9.1 Reuse what exists

Per ADR-002 the legacy backend is consumed verbatim wherever possible. Phase D reuses:

| Concern | Endpoint | Notes |
| --- | --- | --- |
| Auth / session | `api/auth.js` + `api/_lib/auth.js` | Cookie `buhl_session` unchanged. |
| Job list | `GET /api/jobs` | Verify response shape during PR-D1; the existing `withStats=1` variant is heavy and not needed in Phase D. |
| Job detail | `GET /api/jobs?id=<jobId>` or `GET /api/job-glance?jobId=<id>` | Pick the one with the simplest shape during PR-D1. |
| Job stages/areas | Nested in job detail blob; helper `api/_lib/job-tasks.js` exists | Read-only consumption. |
| Photo upload | `POST /api/photos?jobId=<id>&action=upload-evidence-photo` | **Pattern mirrors `upload-snag-photo` and `upload-itp-photo` in `api/photos.js:36-145`.** Phase D **does not** add a new endpoint unless `upload-evidence-photo` action is added to the existing `api/photos.js` (≤ 30-line addition). See §9.3. |
| Task toggle | `POST /api/task-toggle?jobId=<id>` | Existing endpoint; consumed unchanged. |
| Blob R/W | `api/_lib/blob.js` (existing) | TTL-cached, in-flight dedupe. Phase D uses through `api/photos.js`. |
| Vercel Blob | `@vercel/blob` SDK | Existing dependency; no version bump in Phase D. |

### 9.2 What Phase D adds — minimum new endpoints

Per [20-agent-rules.md] #31 and ADR-002, new endpoints are added only when the legacy contract genuinely doesn't cover the flow. Phase D adds **at most two**:

1. **`api/photos.js?action=upload-evidence-photo`** — a new `action` branch inside the existing file (not a new file). Body: `{ dataUrl, evidenceId?, jobId, stageId?, taskId? }`. Stores to `jobs/{jobId}/evidence-photos/{photoId}.jpg`. Returns `{ photoId, url, capturedAt }`. ≤30-line addition modelled exactly on `uploadSnagPhoto` (api/photos.js:44-74) and `upload-itp-photo` (api/photos.js:119-145).

2. **`api/jobs-evidence.js`** (or `src/app/api/jobs/[jobId]/evidence/route.ts`) — new file (the Phase D plan recommends `src/app/api/...` per [14-technical-architecture-deep-dive.md] §C and §F future direction). Handles:
   - `GET  /api/jobs/[jobId]/evidence` — list (with filters: status, capturedBy, fromDate, toDate)
   - `POST /api/jobs/[jobId]/evidence` — create EvidenceItem (admin or assigned worker only)
   - `POST /api/jobs/[jobId]/evidence/[evidenceId]/review` — mark reviewed / rejected (admin only)
   - `PATCH /api/jobs/[jobId]/evidence/[evidenceId]` — edit note / re-attach to task (capturedBy or admin)
   
   Zod-validated. AuditLog write on every mutation.

**No other new endpoints.** If during PR-D1 a third endpoint is found to be needed, **stop and ask** per [20-agent-rules.md] #31.

### 9.3 Why `api/photos.js` action expansion vs new file

The legacy `api/photos.js` already carries three distinct upload paths (`upload-snag-photo`, `upload-itp-photo`, default base64 path) via `action` query parameter (api/photos.js:103-145). Adding `upload-evidence-photo` is one more `if (action === 'upload-evidence-photo' && req.method === 'POST')` branch — exact same shape as the snag and ITP cases. Splitting it into a new file would diverge from the established legacy pattern and require a new auth wiring; the in-file addition is ~30 lines and consistent.

### 9.4 Storage shape for `EvidenceItem`

Two options; **§15 open decision 2** flags this for Oskar.

- **Option A (recommended): append to `jobs/{jobId}/data.json` under a new `evidence[]` array.** Pros: same blob path as snags/tasks; matches existing read patterns; one fetch to render the admin Evidence tab. Cons: grows the data blob (already the source of the full-doc-write problem flagged by [14-technical-architecture-deep-dive.md] §A risk 7); new patch endpoint mitigates by writing only the evidence slice (read full doc, modify `evidence[]`, write full doc — same pattern as `api/task-toggle.js`).
- **Option B: separate `jobs/{jobId}/evidence.json` blob.** Pros: bounded blob size; doesn't inflate `data.json`; future Postgres migration is cleaner. Cons: extra fetch per admin Evidence-tab render (mitigated by `api/_lib/blob.js` TTL cache).

Recommendation: **Option A** for Phase D (consistency with existing read paths and admin job page expectations), with a clearly-flagged comment that Phase F migration moves this to its own Postgres table.

### 9.5 Validation

Per [14-technical-architecture-deep-dive.md] §E "API + persistence rules":

- All mutations validate input with Zod at the API boundary.
- All role-sensitive actions need permissions checks at three layers (middleware, page, API).
- The API check is authoritative.
- No full-document writes in new code → Phase D writes use read-modify-write semantics under the hood (necessary while Blob doesn't support patch) but client-facing API surface is patch-shaped per endpoint.

### 9.6 Permissions

- **Evidence capture:** worker must be `assignedTo` the job (via existing `canWrite(user, jobId)` helper in `api/_lib/auth.js`). Admin can capture on behalf (audit captures the actor difference).
- **Evidence read:** admin, PM (per job), captured-by worker (own captures), other workers assigned to the job (with the §15 open decision 5 caveat).
- **Evidence review:** admin and PM only. Worker cannot review their own. (LH approval scope mirrors hours rules — see §15 open decision 6.)
- **Task toggle:** existing `api/task-toggle.js` permission unchanged.

---

## 10 · Testing plan

Per [17-testing-and-quality-plan.md] §C.4 — Phase D testing extends the Phase B + Phase C baseline.

### 10.1 Unit tests (Vitest)

`src/domains/jobs/jobs.test.ts`:

- Schema parses valid Job from legacy `/api/jobs` response shape.
- Schema rejects: missing required fields, invalid status enum, malformed dates.
- Client formats job-list request correctly.
- Client returns `{ok: false}` on 4xx / 5xx without throwing.
- Filter helpers: `byStatus()`, `byAssignment()`, `pendingEvidence()`.

`src/domains/evidence/evidence.test.ts`:

- Schema parses valid EvidenceItem.
- Schema rejects: missing photoId for `kind: 'photo'`, note > 280 chars, invalid status enum, photoId without photoUrl.
- Status transition matrix: every valid transition allowed; every invalid one rejected.
- Client correctly serialises capture payload; handles 413 (too-large), 400 (mismatched stage/task), 403 (not assigned).

`src/domains/audit-log/audit-log.test.ts`:

- Schema parses each Phase D action type.
- Append-only invariant: `update()` is not exposed; only `append()`.

### 10.2 Integration tests (Vitest)

- Mocked `fetch` for `/api/jobs` → parsed Job list.
- Mocked `fetch` for `/api/photos?action=upload-evidence-photo` → parsed `{ photoId, url }`.
- Mocked `fetch` for `/api/jobs/[jobId]/evidence` POST → parsed EvidenceItem.
- Two-step capture: photo POST returns a `photoId`, then evidence POST uses that `photoId`. Asserts no second photo POST on retry.

### 10.3 Route smoke (Playwright)

`tests/phase-d-jobs-evidence.spec.ts`:

- Tradie login → `/phil/jobs` → sees their assigned jobs (or empty state if seeded as unassigned).
- Tap into a job → `/phil/jobs/[jobId]` → header + site notes + stages strip visible.
- Tap Capture → upload a test image → submit → EvidenceItem appears with `pending_sync` → flips to `submitted` on success.
- Admin login → `/jobs` → sees all jobs → opens the job → Evidence tab shows the new EvidenceItem.
- Admin marks reviewed → status flips → tradie's "my evidence" page reflects new status.
- Admin rejects with reason → reason visible on tradie's history.
- Task toggle: tap task → status flips → admin Hours view reflects.
- Visual: DemoModeBanner is OFF on all 5 Phase D routes once seeded with real data.
- No "Site Office" / "Switchboard" strings in DOM (existing lint + this assertion belt-and-braces).

### 10.4 Manual browser checklist

For PR-D4 (the cutover PR), Oskar manually verifies on a Vercel preview:

- [ ] `/phil/jobs` renders own assigned jobs on a real tradie account.
- [ ] Capture flow works from an iPhone in portrait, finger only, no gloves.
- [ ] Capture flow works from an Android Chrome.
- [ ] Capture flow degrades gracefully when the connection drops mid-upload (item stays `pending_sync`, retries succeed).
- [ ] `/jobs` admin page renders real job list within 1s on cold load.
- [ ] `/jobs/[jobId]/evidence` renders ≥5 captured items in <2s.
- [ ] Admin review / reject flow updates state without page reload.
- [ ] Legacy `/admin/jobs.html` reaches via `/legacy/admin-jobs` (quarantine route) for one billing cycle, then is verified deleted.
- [ ] Phil bottom tab bar: **Jobs** tab is live; Snag tab is still UC (or live if Oskar overrides §15 open decision 1).

### 10.5 Legacy regression

The four legacy guards (per [17-testing-and-quality-plan.md] §A) all keep passing:

- `npm run check:admin-shell`
- `npm run check:sw-cache-version`
- `npm run check:production-shell`
- `npm run smoke:admin-routes`

Plus the route-collision check (§B.11) and the hours-loop E2E reference (Phase B) must remain green.

### 10.6 Preview verification

Per [16-migration-strategy.md] §C.4 — Phase D cutover PRs (PR-D4, PR-D5) deploy only on Monday morning with on-call ready for one hour.

---

## 11 · Risks

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| D-01 | Photo upload pattern (base64 dataURL) bottlenecks on big images | Medium | Medium | Enforce client-side resize to 1920px @ 0.7. Server 413 at 6MB. Same as legacy snag/ITP. |
| D-02 | Vercel Blob storage cost balloons with many evidence photos | Medium | Low | Phase D captures only essential evidence. Phase F migration to Postgres / S3-compatible decouples cost. Monitor monthly. |
| D-03 | iOS Safari camera input quirks | Medium | Medium | Use `<input type="file" accept="image/*" capture="environment">` + tested fallback to gallery. Manual Playwright spot-check on iOS Safari preview. |
| D-04 | "Offline-capable" expectation creep | High | High | Plan explicitly avoids offline-first. `pending_sync` is a UI signal only; **state lost on tab close** is documented. Marketing copy banned. |
| D-05 | Job data quality (missing site notes, stale assignments) crashes the UI | High | Medium | Every Job field optional except `id`, `name`, `status`. Empty state for every missing-data block. Per-field fallback ("No site notes added yet."). |
| D-06 | Permission scope leak (worker sees other workers' captures unintentionally) | Low | High | Default to own-captures-only on Phil. Server filters by `capturedById` unless explicit admin/PM permission. §15 open decision 5. |
| D-07 | Evidence accumulates without admin review (review SLA absent) | High | Low (Phase D); Medium (later) | Surface "X items pending review" on admin Command Centre once real data lands. Phase F adds SLA alerts. |
| D-08 | `data.json` blob grows unbounded with evidence array | Medium | Medium | §9.4 Option A accepts the growth for Phase D; Phase F Postgres migration breaks it out. If growth becomes painful pre-Phase-F, flip to §9.4 Option B (separate blob) with a single migration script. |
| D-09 | Cutover of `/admin/jobs` and `/jobs` regresses the legacy 4,772-line `public/admin/job.html` | High | High | The legacy file is preserved at `/legacy/admin-jobs/:jobId` for one billing cycle. PR-D4 is its own PR with rollback plan. Deploy Monday with on-call. |
| D-10 | Workers conflate "evidence captured" with "task complete" | Medium | Medium | Capture flow explicitly separates them: capture sheet does **not** auto-mark task done. Visual hierarchy keeps them as separate actions. |
| D-11 | Snag flow remains UC after Phase D, confusing workers who expect to raise issues | Medium | Low | UC pill is consistent with the existing pattern from Phase A. Plan §15 open decision 1 surfaces whether to include snags in Phase D. If kept UC, the Today screen shows a "Snags coming soon" line item only when a worker taps the UC tab. |
| D-12 | Capture-then-tab-close loses the photo if upload was in flight | Medium | Low | Documented limitation. Phase D not offline-first. Workers told via release notes; Phase F+ adds proper queue. |
| D-13 | Audit log unification (introducing `audit/{yyyy-mm}.json`) silently diverges from per-domain logs | Medium | Medium | Phase D writes both: unified `audit/` and per-domain (where they exist) for one cycle. Phase E migrates remaining domains and deletes the duplication. |
| D-14 | New `/api/jobs/[jobId]/evidence` endpoint is the first new Phase D API surface — easy to drift from legacy conventions | Medium | Medium | Schema-first (Zod). Mirror the patch-shape conventions used in `api/_lib/blob.js` and `api/task-toggle.js`. Code-review reads existing patterns before reviewing the new endpoint. |
| D-15 | Phase C (My Gear) not yet merged — Phase D plan assumes its scope ships first | High | Low | Phase D start gate (§13 sequence) blocks on PR #5 merge + 7-day quiet period per [16-migration-strategy.md] §E.3. |
| D-16 | Plan-acknowledgement modal expectation creep (workers expect plans in Phase D since "evidence" sounds plan-shaped) | Low | Low | Phase D scope doc + release notes explicitly call out "no plans yet — Phase E." |
| D-17 | Scope creep within Phase D itself: a single PR creeps from "Phil jobs read-only" to "Job Builder rebuild" | High | High | Build sequence (§13) enforces D1–D6 as separate PRs. Any new feature requires Oskar approval before being added to the Phase D build prompt. |

---

## 12 · Phase D acceptance criteria

Phase D is **complete** when all of the following are true:

### 12.1 Functional

- [ ] A tradie can log in (via `/v2/login` or legacy `/login`) and see their assigned jobs at `/phil/jobs`.
- [ ] The Phil **Jobs** tab is live (no longer UC).
- [ ] Tapping a job opens `/phil/jobs/[jobId]` and shows real header + site notes + stages + areas.
- [ ] A tradie can capture evidence (photo + optional note + optional stage/task attachment) and see it appear in their own history.
- [ ] An admin sees the same evidence on `/jobs/[jobId]/evidence` within 2 seconds.
- [ ] Admin can mark reviewed / reject with reason; status updates on both surfaces.
- [ ] A tradie can mark a task complete via `/api/task-toggle`.
- [ ] `/jobs` admin page renders real job list and links into job detail.
- [ ] `/activity` admin page surfaces evidence captured/reviewed/rejected events from the new unified `AuditLog`.
- [ ] **All Phase A/B/C surfaces still work** (regression check).
- [ ] Hours loop reference E2E still passes.

### 12.2 Technical

- [ ] `src/domains/jobs/{schema,types,fixtures,client,service}.ts` exist.
- [ ] `src/domains/evidence/{schema,types,fixtures,client,service}.ts` exist.
- [ ] `src/domains/audit-log/{schema,types,client}.ts` exist (minimum: append + list).
- [ ] `src/lib/storage/blob.ts` exists as a typed wrapper around the photo-upload path (or extends `api/photos.js` action handlers via the existing pattern).
- [ ] At most **two new API surfaces:** `api/photos.js?action=upload-evidence-photo` and `src/app/api/jobs/[jobId]/evidence/route.ts` (and its sub-routes). No others.
- [ ] All four legacy guards pass.
- [ ] `scripts/check-route-collisions.js` passes.
- [ ] `npm run typecheck` zero errors. `npm run lint` zero warnings. `npm run test` all pass. `npm run build` succeeds.
- [ ] Playwright Phase D spec passes against preview.
- [ ] No "Site Office" / "Switchboard" (product label) in DOM (Playwright assertion + lint).

### 12.3 Quality / discipline

- [ ] DemoModeBanner is OFF on all Phase D routes once seeded with real data.
- [ ] Every mutation writes to the new `AuditLog`.
- [ ] No mock-only fallback. Errors show error UI.
- [ ] No `alert()` / `confirm()` / `prompt()` in product code.
- [ ] No new business logic in page components — `src/domains/...` carries it.
- [ ] No new `any` casts.
- [ ] Snag tab on Phil bottom bar remains UC (unless Oskar overrides §15 open decision 1).
- [ ] Phase D PR titles all start with `[Phase D]` (per [20-agent-rules.md] #28).

### 12.4 Deploy / cutover

- [ ] No `vercel deploy --prod` from local.
- [ ] PRs merge to `main`; Vercel auto-deploys.
- [ ] Each cutover PR (PR-D4, PR-D5) deploys Monday morning with on-call.
- [ ] Each cutover has its own rollback plan documented in the PR description.
- [ ] Legacy `public/admin/jobs.html` and `public/project.html` and `public/admin/activity.html` are reachable at `/legacy/...` for one billing cycle, then deleted in a separate PR.

### 12.5 Documentation

- [ ] This document is updated with any decisions taken during build (open decisions → resolved decisions section).
- [ ] [00-executive-summary.md](00-executive-summary.md) Phase D section added.
- [ ] [11-operational-workflow-map.md](11-operational-workflow-map.md) #10, #11 marked "shipped" (with Phase D ref) for the slices that did ship; #12 (snags) remains Phase D/E depending on §15 open decision 1.
- [ ] A `docs/rebuild-audit/25-phase-d-command-results.md` exists capturing every command run, outcome, and fix applied (per [20-agent-rules.md] #24).

---

## 13 · Build sequence

Six slices, each its own PR. Total estimated effort: 5–8 build days assuming Phase C is merged and the brief is approved.

### Pre-D · Gate (no PR — checklist)

- [ ] Phase C (PR #5 — My Gear) is merged to `main`.
- [ ] 7-day quiet period on Phase C in preview/production (per [16-migration-strategy.md] §E.3).
- [ ] This plan (Phase D plan) is approved by Oskar — open decisions §15 are answered.
- [ ] Phase C exit checklist is complete (per [17-testing-and-quality-plan.md] §E).

### D1 · Jobs domain + Phil jobs read

**PR title:** `[Phase D] D1 · jobs domain + Phil jobs list & detail (read-only)`

- `src/domains/jobs/{schema,types,fixtures,client,service}.ts` (Zod over the existing `/api/jobs` responses; verify exact shape).
- `src/domains/jobs/jobs.test.ts`.
- `src/app/phil/jobs/page.tsx` — list.
- `src/app/phil/jobs/[jobId]/page.tsx` — detail (read-only).
- Phil bottom tab bar: Jobs tab flips from UC to live.
- Playwright: list + detail render against fixtures (DemoModeBanner ON in this PR).
- **No backend changes.** **No admin pages.** **No evidence yet.**

### D2 · Evidence domain + Phil capture

**PR title:** `[Phase D] D2 · evidence domain + Phil capture flow`

- `src/domains/evidence/{schema,types,fixtures,client,service}.ts`.
- `src/domains/evidence/evidence.test.ts`.
- Capture sheet component (`src/app/phil/jobs/[jobId]/capture-sheet.tsx` or modal).
- Adds `action=upload-evidence-photo` to `api/photos.js` (≤30 lines, mirrored on snag pattern).
- Phil capture flow end-to-end against fixtures.
- **No admin pages.** **No new full API endpoint yet.** **No real data wiring.**

### D3 · `/api/jobs/[jobId]/evidence` route + audit log

**PR title:** `[Phase D] D3 · evidence persistence + unified audit log`

- New `src/app/api/jobs/[jobId]/evidence/route.ts` (GET, POST).
- New `src/app/api/jobs/[jobId]/evidence/[evidenceId]/review/route.ts` (POST).
- `src/domains/audit-log/{schema,types,client}.ts` (append + list).
- Real data wired: Phil capture → real POST → real blob write → real EvidenceItem.
- DemoModeBanner flips OFF for evidence on Phil.
- Phase D Playwright spec partial (Phil-side end-to-end).
- **No admin pages yet.**

### D4 · Admin Jobs + cutover

**PR title:** `[Phase D] D4 · admin jobs surface + /admin/jobs cutover`

- `src/app/(admin)/jobs/page.tsx` — list.
- `src/app/(admin)/jobs/[jobId]/page.tsx` — detail (Overview tab + Evidence tab + Hours read-only roll-up link).
- `src/app/(admin)/jobs/[jobId]/evidence/page.tsx` (or panel inside detail) — review surface.
- **First `/v2/jobs` preview verification, then cutover:**
  - Edits `vercel.json`: remove `/jobs → /admin/jobs.html`, remove `/jobs/:jobId → /project.html`, remove `/admin/jobs → /admin/jobs.html`, remove `/admin/jobs/:jobId → /admin/job.html`.
  - Adds new quarantine: `/legacy/admin-jobs → /admin/jobs.html`, `/legacy/admin-jobs/:jobId → /admin/job.html`, `/legacy/project/:jobId → /project.html`.
  - Bump SW cache version per [17-testing-and-quality-plan.md] §B.11 if shell files changed.
- Full Phase D Playwright spec passes (Phil + Admin).
- Deploy Monday with on-call.

### D5 · `/admin/activity` cutover

**PR title:** `[Phase D] D5 · admin activity surface + /admin/activity cutover`

- `src/app/(admin)/activity/page.tsx` — feed of AuditLog events (Phase D scope: evidence-captured/reviewed/rejected + task-toggled events only).
- Edit `vercel.json`: remove `/admin/activity → /admin/activity.html`; add `/legacy/admin-activity → /admin/activity.html`.
- Playwright: activity feed renders real events.

### D6 · Phase D exit polish

**PR title:** `[Phase D] D6 · exit polish + docs + Command Centre evidence count`

- Adds a real "X evidence pending review" count to `/command-centre` (per [13-ui-information-architecture.md] §Command Centre — "real counts only").
- Cleans up any `TODO(Phase D)` left in code.
- Updates [00-executive-summary.md](00-executive-summary.md) Phase D section.
- Updates [11-operational-workflow-map.md](11-operational-workflow-map.md) #10, #11 to "shipped".
- Creates `docs/rebuild-audit/25-phase-d-command-results.md`.
- Phase D exit checklist (§12) walked through and ticked.

### Post-D · 7-day quiet + decision on Phase D.5 (snags)

If §15 open decision 1 resolved "defer snags to Phase D.5", schedule that work as a focused 1-PR slice (Phase D.5) before Phase E starts.

---

## 14 · Claude Code build prompt (paste-ready for D1; replicate for D2–D6)

> **Copy the block below for the future build session. Each Dx slice gets its own session, its own PR, its own preview verification, its own merge.**

```
You are Claude Code Max working as the Phase D BUILD session for the BuhlOS / Phil repo.

This is the Phase D · D1 build session (jobs domain + Phil jobs list & detail, read-only).

Read first:
  docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md   ← this plan
  docs/rebuild-audit/20-agent-rules.md
  docs/rebuild-audit/10-product-definition.md
  docs/rebuild-audit/12-domain-model-deep-dive.md  §Jobs
  docs/rebuild-audit/13-ui-information-architecture.md  §Phil §Jobs
  docs/rebuild-audit/14-technical-architecture-deep-dive.md
  docs/rebuild-audit/16-migration-strategy.md
  docs/rebuild-audit/17-testing-and-quality-plan.md  §C.4
  docs/rebuild-audit/21-rebuild-decision-record.md  ADR-002, ADR-011
  docs/rebuild-audit/19-phase-b-hours-implementation-brief.md  ← format precedent

============================================================
HARD RULES (read 24-phase-d-jobs-evidence-plan.md §2, §11, §12 first)
============================================================

You may ONLY:
  - build Phase D · D1 (jobs domain + Phil jobs read-only)
  - read existing code freely
  - add src/domains/jobs/* with Zod schemas matching real /api/jobs response shape
  - add src/app/phil/jobs/page.tsx
  - add src/app/phil/jobs/[jobId]/page.tsx
  - flip Phil bottom tab bar: Jobs tab from UC to live
  - add tests (vitest + playwright fixtures-driven)
  - commit on a new branch phase-d-d1-jobs-read-only
  - push to that branch
  - open a PR to main

You MUST NOT:
  - build evidence (that's D2)
  - build any admin Phase D page (that's D4)
  - touch any backend endpoint
  - edit api/*.js
  - edit vercel.json
  - edit public/*.html
  - deploy
  - cutover any route
  - touch Phase C (PR #5) branch or worktree
  - rebuild Job Builder or any job mutation
  - build snag triage
  - build plans / ITPs / RFIs / materials / variations
  - merge anything

Before starting:
  - confirm Phase C (PR #5) is merged to main
  - confirm this plan (24-phase-d-jobs-evidence-plan.md) is approved by Oskar
  - confirm open decisions in §15 are answered (especially decision 1 — snag scoping —
    even though D1 doesn't touch snags, the answer affects what UC pill the Snag tab keeps)
  - if any of the above is uncertain, STOP and ask before any code

============================================================
SCOPE OF THIS PR (D1)
============================================================

In:
  - src/domains/jobs/schema.ts        (Zod over real /api/jobs response — verify shape via curl or read of api/jobs.js)
  - src/domains/jobs/types.ts         (z.infer<>)
  - src/domains/jobs/fixtures.ts      (typed seed data for tests/Storybook)
  - src/domains/jobs/client.ts        (typed wrappers around /api/jobs)
  - src/domains/jobs/service.ts       (filter helpers: byStatus, byAssignment)
  - src/domains/jobs/jobs.test.ts     (unit tests per §10.1 of the plan)
  - src/app/phil/jobs/page.tsx        (Phil jobs list; renders fixtures until D3)
  - src/app/phil/jobs/[jobId]/page.tsx  (Phil job detail; renders fixtures)
  - Update PhilShell / PhilTabBar to mark Jobs tab live (no longer UC)
  - tests/phase-d-d1-jobs-read-only.spec.ts (Playwright smoke against fixtures)

Out (defer to D2+):
  - capture sheet
  - any photo upload
  - any evidence schema
  - any admin page
  - any new API
  - any vercel.json change
  - any cutover

Before writing code:
  - read api/jobs.js to learn the exact response shape
  - read src/domains/timesheets/* for the established pattern
  - read src/lib/http.ts and src/lib/auth/* for the cross-cutting helpers
  - confirm /phil/jobs is not in vercel.json (it isn't — but verify)

Checks before opening the PR:
  - npm run typecheck  (zero errors)
  - npm run lint       (zero warnings)
  - npm run test       (all green)
  - npm run build      (succeeds)
  - npm run check:admin-shell
  - npm run check:sw-cache-version
  - npm run check:production-shell
  - npm run smoke:admin-routes
  - npm run test:e2e   (phase-d-d1 spec passes)
  - git status         (only src/domains/jobs/* + src/app/phil/jobs/* + tests touched)
  - git diff --stat    (no api/, no public/, no vercel.json, no src/app/(admin)/* changes)

PR title:  [Phase D] D1 · jobs domain + Phil jobs list & detail (read-only)

PR body must include:
  - link to docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §13 D1
  - confirmation that D2/D3/D4/D5/D6 are separate upcoming PRs
  - rollback plan: revert the PR; no production cutover so blast radius is preview only

Report at the end of the session:
  - branch + base commit
  - list of files created / modified
  - command outputs for every check above
  - any deviation from the plan + why
  - link to PR
  - confirmation: no backend touched, no vercel.json, no cutover, no Phase C interference
```

> For **D2 through D6**, copy the above template, swap the slice description, swap the in/out lists, swap the PR title. Use this Phase D plan §13 as the in/out source of truth.

---

## 15 · Open decisions Oskar must make before D1 starts

These are the questions this plan deliberately leaves to Oskar. Each affects scope or behaviour and cannot be resolved by reading the audit alone.

### Decision 1 · Do snags ship in Phase D, or defer to Phase D.5 / E?

- **Plan's recommendation:** Defer to Phase D.5 (one focused PR after Phase D exit, before Phase E starts). Reason: snags have their own state machine, admin triage queue, notification cron, and assignment workflow — bundling them would balloon Phase D from "5–8 days" to "10–15 days" and risk half-built UI.
- **Audit doc position** ([11-operational-workflow-map.md] #12, [21-rebuild-decision-record.md] ADR-011): bundles snags into Phase D.
- **Override impact if snags ship in D:** add `src/domains/snags/*`, Phil Snag tab flips to live, admin `/snags` page + cutover. Adds 1 more PR (D2.5 between D2 and D3) and 1 more cutover (D4.5 between D4 and D5). The Phase D plan §2.1 and §2.2 would expand accordingly.
- **Question for Oskar:** Defer to Phase D.5 (recommended) or include in Phase D?

### Decision 2 · `EvidenceItem` storage shape: append to `data.json` or separate blob?

- **Plan's recommendation:** §9.4 Option A (append to `data.json.evidence[]`).
- **Trade-off:** Option A is consistent with existing read patterns and one-fetch admin rendering, but grows the blob (the audit's risk 7 around full-doc writes). Option B is cleaner long-term but adds a fetch.
- **Question for Oskar:** Option A (recommended) or Option B?

### Decision 3 · Phil jobs list filtering — server-side or client-side?

- **Context:** `/api/jobs` may not natively filter by `assignedTo=<userId>` (verify in D1). If it doesn't, Phil's first fetch returns the full job list and we client-filter — a permission leak risk if the response includes data the worker shouldn't see.
- **Plan's recommendation:** **Verify the endpoint shape in D1.** If server already filters by session user, use that. If not, **either** add a server-side filter as part of D1 (small change to `api/jobs.js` — stops the plan being "no backend changes" for D1) **or** accept the client-filter for Phase D with a documented follow-up to harden in D6 polish.
- **Question for Oskar:** If the legacy endpoint doesn't filter, do we (a) harden `api/jobs.js` in D1 (small backend change), (b) ship D1 with client-filter and document the gap (and harden in D6), or (c) plan a separate "Phase D auth hardening" mini-slice?

### Decision 4 · Pre-cutover preview URL: `/v2/jobs` or `/admin-v2/jobs` or another?

- **Context:** D4 wants to verify the new admin Jobs surface on preview before flipping `/jobs` and `/admin/jobs` rewrites.
- **Plan's recommendation:** `/v2/jobs` (consistent with `/v2/login`, `/v2/phil` from Phase A).
- **Question for Oskar:** OK with `/v2/jobs`?

### Decision 5 · "Today's captures" strip on Phil job detail — own-only or team?

- **Context:** Phil job detail can show a small "Today's captures" strip. Plan defaults to **own captures only** to avoid a permission scope leak.
- **Plan's recommendation:** Own captures only in Phase D; revisit in Phase E once permission model around team visibility is firm.
- **Question for Oskar:** Confirm own-only (recommended)?

### Decision 6 · LH (Leading Hand) evidence review — can LH approve crew captures?

- **Context:** LH can approve hours for their crew (excluding other LHs). Plan defaults LH to **read evidence but not review/reject** — that's admin/PM only in Phase D.
- **Plan's recommendation:** LH read-only on evidence in Phase D; revisit in Phase E.
- **Question for Oskar:** OK?

### Decision 7 · Cutover of `/jobs` — Phil-facing or admin-facing route?

- **Context:** Today `/jobs` rewrites to `/admin/jobs.html` (the admin jobs list). After cutover, Next.js owns `/jobs` — but who is the audience?
- **Plan's recommendation:** **Admin-facing** at `/jobs` (consistent with `/command-centre`, `/hours/approvals`); Phil is at `/phil/jobs`. The legacy ambiguity goes away.
- **Question for Oskar:** Confirm `/jobs` = admin-facing post-cutover?

---

## 16 · Cross-references

- [10-product-definition.md](10-product-definition.md) §A, §B (tradesman, PM, admin user groups), §C (product surfaces).
- [11-operational-workflow-map.md](11-operational-workflow-map.md) #7 (Job creation — deferred), #9 (Worker assignment — deferred), #10 (Task completion — partial), #11 (Photo/evidence — primary), #12 (Snag — see §15 decision 1), #19 (Stages — read-only), #20 (Areas — read-only).
- [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) §Jobs, §`Evidence`, §`Photo`, §`AuditLog`, §"Fields that must NOT be skipped", §"Per-phase minimum models" §"Phase D".
- [13-ui-information-architecture.md](13-ui-information-architecture.md) §Admin/Jobs, §Phil/Jobs, §"Inside a Job (Phil)", §"Capture screens", §"Banned patterns".
- [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md) §C (app structure: `src/domains/jobs/`, `src/domains/evidence/`, `src/app/phil/jobs/`, `src/app/(admin)/jobs/`), §D (coexistence rules), §E (binding code rules).
- [16-migration-strategy.md](16-migration-strategy.md) §A (principles), §B (Phase map row "D"), §C.3 (cutover sequencing).
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) §B.5 (route smoke), §B.11 (route collision), §C.4 (Phase D acceptance).
- [20-agent-rules.md](20-agent-rules.md) §"Build posture" #6 (don't overbuild beyond phase), #8 (UC default), §"Deploy posture" #11–#15, §"File posture" #21–#22 (no UI without data model; no entity without ownership/status/audit rules).
- [21-rebuild-decision-record.md](21-rebuild-decision-record.md) ADR-002 (retain backend), ADR-011 (jobs+evidence is third loop), ADR-013 (UC over fake-it), ADR-015 (mock data labelled), ADR-020 (Vercel Blob continues).
- [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md) — format precedent for this plan.
- [[project_buhlos_phil_hours_pipeline]] — user's six-step deployment order; Phase D follows the same pattern.
- [[feedback_hide_unfinished_features]] — Snag tab stays UC if Phase D defers snags (§15 decision 1).
- [[project_buhlos_phil_naming]] — Phil + BuhlOS canonical names; "Switchboard" / "Site Office" banned in all new Phase D code.

---

## 17 · Document status

| Field | Value |
| --- | --- |
| Document | `docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md` |
| Phase | D · Jobs and evidence loop plan |
| Status | **Draft — awaiting Oskar approval of §15 open decisions** |
| Author | Phase D planning agent (session 3 — separate from Session 2 / PR #5) |
| Author branch | `phase-d-jobs-evidence-plan` |
| Base commit | `origin/main` (Phase B + production hardening) |
| Assumed precondition | Phase C (PR #5 · My Gear) merged to `main` + 7-day quiet period |
| Next action | Oskar answers §15 open decisions → build session opens for D1 with the paste-ready prompt in §14 |
