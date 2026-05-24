# 24 · Phase D — jobs and evidence loop plan

> **Status:** Planning. No code in scope. Authored on `phase-d-jobs-evidence-plan` branch from `origin/main` (Phase B + production hardening). Phase C (My Gear) is in PR #5 and assumed merged before Phase D begins. **This plan must be approved by Oskar before any Phase D build prompt is run.**
>
> **Read first:** [10-product-definition.md](10-product-definition.md), [11-operational-workflow-map.md](11-operational-workflow-map.md) #7, #9, #10, #11, #19, #20, [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) §Jobs / §Evidence, [13-ui-information-architecture.md](13-ui-information-architecture.md) §Phil / §Jobs / §Defects, [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md), [16-migration-strategy.md](16-migration-strategy.md) §B, §C.3, [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) §C.4, [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md) (format precedent), [20-agent-rules.md](20-agent-rules.md), [21-rebuild-decision-record.md](21-rebuild-decision-record.md) ADR-011.

---

## 1 · Executive summary

Phase D ships the third closed operational loop in the rebuild: **job context → field evidence capture → admin review**. It is the loop that converts the Phil shell from a hours+gear utility into a real on-site companion that knows what job the worker is on and what they're proving.

**What Phase D is.** A Phil worker opens a job assigned to them, sees the relevant job context (address, site notes, access notes, area groups → areas), captures evidence (photo + note) attached to a job — optionally also tagged with an area, a stage (`roughIn` or `fitOff`), and a task — and an admin reviews that evidence on the new admin Jobs surface. Status is visible to both sides. The loop closes end-to-end.

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

**Recommended scope (concise):** Jobs (read-only from existing legacy API) + Phil job context view + Evidence capture (photo + note) + Admin evidence review surface + a one-click task completion toggle. **Snag triage lifecycle, Job Builder mutations, plans/documents, ITPs, RFIs, variations, and materials are explicitly deferred.** This is narrower than the Phase D scope hinted at in [11-operational-workflow-map.md] (which bundles snags) and [12-domain-model-deep-dive.md] §C.D (which mentions `Defect` as Phase D). See §13 (Build sequence) for the rationale.

**Phase ordering (decided by Oskar — 2026-05-24):**

| Phase | Scope | Status in this plan |
| --- | --- | --- |
| **D** | Jobs + Evidence | Planned in this doc. |
| **D.5** | Snags / defects (`Defect` schema + Phil Snag tab + admin triage queue) | Confirmed as a dedicated post-Phase-D, pre-Phase-E PR set. Its own plan doc will land before D.5 build starts. |
| **E** | ITP / RFI / Materials (and Plans / Variations per [16-migration-strategy.md] §B) | Unchanged from the audit. |

This split overrides the audit's bundling of snags into Phase D ([11-operational-workflow-map.md] #12, [21-rebuild-decision-record.md] ADR-011). The override is intentional — bundling would balloon Phase D from ~5–8 build days to ~10–15 and risk half-built UI. A future ADR (ADR-021 or similar) should formalise the split when the next ADR pass happens.

---

## 2 · Scope

### 2.1 In scope (Phase D ships these end-to-end)

**Phil (mobile):**

- `/phil/jobs` — list of jobs assigned to the current worker. Status pill, address, last-activity timestamp. Empty state when no jobs assigned.
- `/phil/jobs/[jobId]` — single-job context view. Header (name, address, status). Site notes + access notes + parking notes + safety notes + induction-required pill if set. Area-groups → areas list (read-only, hides archived per `projectJobStructure`). Stage chooser (two pills: `Rough-in` / `Fit-off`). When an area + stage is selected, the resolved task list (via `effectiveRoughInTasks` / `effectiveFitOffTasks`) shows with current task state pills. Quick-action floating bar: **Capture evidence**, **Mark task done** (current area + stage + selected task only).
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

- **Snag triage lifecycle** ([11-operational-workflow-map.md] #12, [12-domain-model-deep-dive.md] §`Defect`). Has its own state machine (`open → assigned → in_progress → fixed → verified → closed | wont_fix`), priority, assignment, close-reason, notification cron, and admin triage queue. **Decision (Oskar, 2026-05-24): deferred to Phase D.5** — a dedicated PR set after Phase D exit and before Phase E starts. D.5 will get its own plan doc; the Phil Snag tab stays UC through all of Phase D and flips live with the D.5 ship.
- **Job Builder mutations** ([11-operational-workflow-map.md] #7, [12-domain-model-deep-dive.md] §`Job`). Creating jobs, editing stages, editing areas, editing tasks, templating, scope modules. The legacy `public/admin/job.html` (4,772 lines) and `public/admin/job-builder.html` continue to serve until a dedicated rebuild slice (post-Phase-D). Phase D consumes `/api/jobs` **read-only**; no patch endpoints are written.
- **Worker assignment to a job** ([11-operational-workflow-map.md] #9). Legacy `public/admin/crew.html` continues; Phil reads its result via existing endpoints.
- **Area / area-group mutations.** Admin can view but not edit areas or area groups in Phase D. The `roughInTasks` / `fitOffTasks` template lists are also read-only (admin job-setup edits remain on legacy `public/admin/job.html`).

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
    → list of jobs where me.assignedJobIds.includes(job.id)
      (server-side filter is the legacy default at api/jobs.js:188-195;
      verified — no client-side filter needed). Admin/client roles get
      their own server-side scoping; same endpoint, different branch.

  ↓

WORKER OPENS A SINGLE JOB
  GET /phil/jobs/[jobId]
    → single-job header + site/access notes
    → area groups → areas list (read-only, hides archived)
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
    body: { kind: 'photo', photoId, photoUrl, note, areaId?, stage?, taskId? }
           // stage is 'roughIn' | 'fitOff' | null per §5.4
    → returns { evidenceId, status: 'submitted' }
  UI flips the item from `pending_sync` → `submitted`.
  On failure: stays `pending_sync`, retry available, note + image
    preserved in component state for retry.

  ↓

EVIDENCE ATTACHED TO JOB/STAGE/TASK
  Persisted in jobs/{jobId}/data.json under `evidence[]` (or a
  sibling key — §9.4 storage shape; §15.0 decision 2 resolved to append-to-data.json).
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

**Pre-cutover work-around:** the new admin Jobs surface is first built and verified on **`/v2/jobs`** (decision §15.0 #4 resolved). Once verified on preview, PR-D4 removes the `vercel.json` rewrite for `/jobs` and `/jobs/:jobId` in the same atomic commit AND removes `/v2/jobs` (one canonical URL per concept). The legacy HTML moves to `/legacy/admin-jobs` and `/legacy/admin-jobs/:jobId` for one billing cycle, then is deleted per [16-migration-strategy.md] §A principle 5.

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
4. **Snag** — `/phil/snags` (**REMAINS UC** through Phase D. **Decision confirmed:** snags ship in Phase D.5, after Phase D exit and before Phase E. Tab flips to live in the Phase D.5 PR set.)
5. **More** — `/phil/more` (live since Phase A / B)

---

## 5 · Data model

All shapes live in `src/domains/jobs/schema.ts` and `src/domains/evidence/schema.ts` as Zod schemas; types derive via `z.infer<>`. Schemas use `.passthrough()` so forward-compatible fields don't break parsing (precedent: `src/domains/timesheets/schema.ts:38`). Field set follows [12-domain-model-deep-dive.md] §Universal field set and §Jobs / §Evidence, **but is grounded in the legacy reality** observed in `api/jobs.js:108-155` and `api/_lib/job-tasks.js` rather than the abstract audit shape.

> **Important: the legacy data shape does NOT match the abstract `JobStage` entity** described in [12-domain-model-deep-dive.md] §`JobStage`. The audit doc describes a future Postgres-shaped first-class entity; legacy reality is a binary **rough-in / fit-off** stage enum plus a job-level task list (with per-area overrides). Phase D consumes the legacy reality directly; the abstract `JobStage` row migration is deferred to Phase F+ alongside the Postgres move.

### 5.1 `Job` (read-only consumption in Phase D)

Verbatim shape from `api/jobs.js` GET response. Schema matches the legacy server's projection (`projectJobStructure` at `api/jobs.js:111-127`).

```
Job
  id                  string                            — slug, e.g. "birdwood-iv3232"
  name                string                            — required
  status              enum('active','complete','archived','on_hold','draft')
  clientUserId        string | null
  type                string | null                     — references job-types.json
  typeName            string?                           — server-resolved label
  modules             { areas, snags, photos, hours, materials, tags,
                        temps, plans, contacts, switchboards, circuits,
                        itps, levels }                  — per-job feature flags
                                                          (sanitizeModules at jobs.js:35-42)
  customFields        Array<{ id, name, value }>?       — per-job custom fields
  ref                 string?                            — external job number
  serviceM8JobId      string?
  siteAddress         string?
  siteContactName     string?
  siteContactPhone    string?
  accessNotes         string?
  parkingNotes        string?
  safetyNotes         string?
  inductionRequired   boolean?
  startDate           string?  (YYYY-MM-DD)
  dueDate             string?  (YYYY-MM-DD)
  programmedDurationDays  number | null?
  contractValue       number?                            — admin-only field
  labourEstimate      number?
  materialEstimate    number?
  claimedToDate       number?
  paidToDate          number?
  oldestClaimDays     number?
  areaGroups          JobAreaGroup[]                     — see §5.2
  roughInTasks        JobTaskTemplate[]                  — job-level rough-in list
  fitOffTasks         JobTaskTemplate[]                  — job-level fit-off list
  createdAt           ISO
  (optional stats fields when withStats=1 — see §5.7 — NOT requested in Phase D)
```

**Phase D consumes only the fields it needs.** Schema is `.passthrough()` so extra legacy fields don't fail parsing.

### 5.2 `JobAreaGroup` and `JobArea` (read-only)

The legacy job structure is a two-level hierarchy: `areaGroups[] → areas[]`. Examples: "Ground floor / Kitchen", "Upper floor / Master bedroom".

```
JobAreaGroup
  id        string
  name      string                              — e.g. "Ground floor"
  areas     JobArea[]
  archived  boolean?                            — admin can archive

JobArea
  id            string
  name          string                          — e.g. "Master Bedroom"
  spaceType     string?                         — e.g. "bedroom", "kitchen"
  roughInTasks  JobTaskTemplate[]?              — per-area override
                                                  (omitted = use job-level)
  fitOffTasks   JobTaskTemplate[]?              — per-area override
  archived      boolean?                        — admin can archive
```

Source: nested in `Job.areaGroups[]`. Filtered server-side by `projectJobStructure` to hide archived items from mobile/tradie reads (only admin editor passes `?includeArchived=1`).

### 5.3 `JobTaskTemplate` (read-only)

```
JobTaskTemplate
  id     string
  name   string                                 — e.g. "Rough-in lighting"
```

This is the **template**. The runtime task state (per area, per stage) lives in `dwellings[areaId][stage].tasks[taskId] = TaskStateValue` (see §5.4). Resolution helper: `effectiveRoughInTasks(job, area)` / `effectiveFitOffTasks(job, area)` — returns area override if non-empty, else job-level (`api/_lib/job-tasks.js:23-33`).

### 5.4 Task state (per-area, per-stage) — read + single-toggle mutation

The runtime state of tasks lives in `jobs/{jobId}/data.json` under:

```
data.dwellings[areaId].roughIn.tasks[taskId] = 'not_started' | 'in_progress' | 'complete'
data.dwellings[areaId].fitOff.tasks[taskId]  = 'not_started' | 'in_progress' | 'complete'
```

Mutated via existing `POST /api/task-toggle?jobId=<id>` with body `{ areaId, stage: 'roughIn' | 'fitOff', taskId, state }`. **Phase D consumes this endpoint unchanged** — it's already a tight, fast-path mutation (api/task-toggle.js).

> **No abstract `JobStage` entity in Phase D.** The conceptual "stage" is one of two enum values: `'roughIn'` or `'fitOff'`. If a future Phase F+ Postgres migration promotes stage to a first-class entity, this is a schema-level change at that time; not a Phase D concern.

### 5.5 `EvidenceItem` (NEW in Phase D)

Phase D's only new persistent entity. Schema mirrors the [12-domain-model-deep-dive.md] §`Evidence` shape, adapted to the legacy storage reality (see §9.4).

```
EvidenceItem
  id                string (nanoid)
  jobId             string                             — required
  areaId            string?                            — optional attachment
  stage             enum('roughIn','fitOff') | null    — optional attachment;
                                                         matches legacy task-toggle shape
  taskId            string?                            — optional attachment
                                                         (must be valid for stage+area
                                                         if all three provided)
  kind              enum('photo','note')               — Phase D ships 'photo' only;
                                                         'note' schema reserved
  photoId           string?                            — references the uploaded
                                                         blob's photoId
  photoUrl          string?                            — public Vercel Blob URL
  thumbnailUrl      string?                            — same URL in Phase D
                                                         (no separate thumb pipeline)
  note              string  (≤ 280 chars)              — optional; required when
                                                         kind='note' (deferred)
  capturedById      userId                             — required, server-set
  capturedByName    string                             — denormalised for read
  capturedAt        ISO                                — server-set
  clientCapturedAt  ISO?                               — client-set, metadata only
  exifLocation      { lat: number, lng: number }?      — preserved if present
  status            enum('uploading','pending_sync',
                          'submitted','reviewed','rejected')
  reviewedById      userId?                            — set when status='reviewed'|'rejected'
  reviewedAt        ISO?
  rejectionReason   string?                            — required when status='rejected'
  auditLogIds       string[]
  createdAt         ISO
  updatedAt         ISO
```

`draft` and `uploading` are **client-only states** that never persist to the server. They exist for UX (capture pending, upload-in-progress indicators).

Status transitions (server-enforced):

```
            client-only                  ┌──────────── server-persisted ─────────────┐
            ┌──────────┐                 │                                            │
draft ────► uploading ────► (photo POST ok) ────► pending_sync ────► submitted ──┐    │
                                                       │                          │    │
                                                       └─(evidence POST fails)────┤    │
                                                          (retryable; same        │    │
                                                          photoId, no re-upload)  │    │
                                                                                  │    │
                                                          submitted ──(admin reviews)──► reviewed
                                                                   ──(admin rejects)───► rejected
                                                                                          │
                                                          rejected ──(worker recaptures)──► new EvidenceItem
                                                                     (old is kept; not edited
                                                                      in place)
```

Server rejects transitions other than:
- nothing → submitted (POST create with `status: 'submitted'`)
- submitted → reviewed (review POST with `status: 'reviewed'`)
- submitted → rejected (review POST with `status: 'rejected'` and `rejectionReason`)
- reviewed → submitted (admin un-reviews; rare; admin only)

### 5.6 `Note` (reserved shape, not built in Phase D)

[12-domain-model-deep-dive.md] §`Note` is reserved. Schema in `src/domains/evidence/schema.ts` allows `kind: 'note'` so it's a one-line addition later. **No note-only UI ships in Phase D.**

### 5.7 `Defect` / snag (NOT built in Phase D — Phase D.5)

Reserved per [12-domain-model-deep-dive.md] §`Defect`. **Phase D.5** lands the `Defect` schema, snag triage queue, Phil Snag-tab activation, and `/admin/snags → /snags` cutover. Reuses Phase D's `api/photos.js?action=upload-snag-photo` legacy primitive.

### 5.8 `JobStats` (read-only, NOT requested in Phase D)

`api/jobs.js` `?withStats=1` enriches each job with `statsPct`, `statsOpenSnags`, `statsCrewCount`, `statsAreaCount`, `statsExpiredTags`, `statsExpiringTags`. **Phase D does not request `withStats=1`** because:
- `statsOpenSnags` is snag-domain (Phase D.5).
- `statsExpiredTags` / `statsExpiringTags` is tag-domain (later phase).
- `statsPct` requires walking task state across all areas — expensive on the list view.

Phase D admin job list shows: name, status, address, last-activity. Stats columns are deferred to Phase D.6 polish if there's appetite, or Phase F reporting otherwise.

### 5.9 `AuditLog` (bootstrap unified table in Phase D)

Per [12-domain-model-deep-dive.md] §`AuditLog` and the Phase B brief deferring this to Phase D. Schema:

```
AuditLog
  id           string (nanoid)
  actorId      userId
  actorName    string                                  — denormalised
  action       string                                  — 'evidence.captured',
                                                        'evidence.reviewed',
                                                        'evidence.rejected',
                                                        'task.toggled'
  targetEntity string                                  — 'evidence' | 'job' | 'jobTask'
  targetId     string
  jobId        string?                                 — for cross-job aggregation
  at           ISO
  before       unknown?
  after        unknown?
  reason       string?
  metadata     Record<string,unknown>?
```

Storage: append-only blob at `audit/{yyyy-mm}.json` (one file per month, per [12-domain-model-deep-dive.md] migration plan). Per-domain legacy audit files (`users/<userId>/time-entries-audit/<yyyy-mm>.json`, per-job `jobs/{id}/job-audit/...` written by `api/_lib/job-audit.js`) continue in parallel; consolidation happens in Phase E. Phase D's new code writes to **both** the unified `audit/` and the per-domain log to avoid losing the legacy admin's audit-tab inputs.

### 5.10 Fields that MUST NOT be skipped

Per [12-domain-model-deep-dive.md] §"Fields that must NOT be skipped":

- `auditLogIds` on every `EvidenceItem`.
- `capturedById` (= `createdBy`) on every `EvidenceItem`.
- `status` on every entity with a lifecycle.
- `reviewedById` on `EvidenceItem` when reviewed/rejected.
- `jobId` on every operational row (EvidenceItem, AuditLog when scoped).

---

## 6 · Admin / Phil split

### 6.1 What Phil sees

- **Only jobs assigned to me** (server-side filter — verified in `api/jobs.js:188-195`; decision §15.0 #3 resolved). Single-job 403 enforced at `api/jobs.js:174-178` for URL-poking attempts.
- Mobile-first portrait layout, ≥360px wide.
- One-thumb operation. 48px+ tap targets per [13-ui-information-architecture.md] §Phil.
- Sunlight-legible (high contrast tokens already established).
- **No queue counts, KPIs, charts, admin meta-features.** Per [10-product-definition.md] §C and [13-ui-information-architecture.md] §Phil.
- **No other workers' captures.** Phase D shows **own captures only** on the Phil job detail "Today's captures" strip (decision §15.0 #5 resolved). Team-level visibility is a Phase E concern with its own permission gate.
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
10. **Server validates** `jobId` exists, `areaId` (if provided) belongs to `jobId`, `stage` (if provided) is one of `'roughIn' | 'fitOff'`, `taskId` (if provided) resolves through `effectiveRoughInTasks(job, area)` or `effectiveFitOffTasks(job, area)` per `api/_lib/job-tasks.js:23-33`. Server rejects mismatches with 400; client never gets to an inconsistent state.
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
| Area groups + areas | Nested in `Job.areaGroups[]` (job detail response) | Read-only consumption; archived items filtered server-side. |
| Stage = `'roughIn' \| 'fitOff'` enum + tasks | Job-level `roughInTasks` / `fitOffTasks` + per-area overrides; resolved via `api/_lib/job-tasks.js` helpers | Read-only consumption; `effectiveRoughInTasks(job, area)` is the single source of truth for "which tasks apply to this area in this stage". |
| Photo upload | `POST /api/photos?jobId=<id>&action=upload-evidence-photo` | **Pattern mirrors `upload-snag-photo` and `upload-itp-photo` in `api/photos.js:36-145`.** Phase D **does not** add a new endpoint unless `upload-evidence-photo` action is added to the existing `api/photos.js` (≤ 30-line addition). See §9.3. |
| Task toggle | `POST /api/task-toggle?jobId=<id>` | Existing endpoint; consumed unchanged. |
| Blob R/W | `api/_lib/blob.js` (existing) | TTL-cached, in-flight dedupe. Phase D uses through `api/photos.js`. |
| Vercel Blob | `@vercel/blob` SDK | Existing dependency; no version bump in Phase D. |

### 9.2 What Phase D adds — minimum new endpoints

Per [20-agent-rules.md] #31 and ADR-002, new endpoints are added only when the legacy contract genuinely doesn't cover the flow. Phase D adds **at most two**:

1. **`api/photos.js?action=upload-evidence-photo`** — a new `action` branch inside the existing file (not a new file). Body: `{ dataUrl }`. Stores to `jobs/{jobId}/evidence-photos/{photoId}.jpg`. Returns `{ photoId, url, capturedAt }`. ≤30-line addition modelled exactly on `uploadSnagPhoto` (api/photos.js:44-74) and `upload-itp-photo` (api/photos.js:119-145). The endpoint is photo-only — it does NOT know about EvidenceItem rows. The Phil client makes a second POST to `/api/jobs/[jobId]/evidence` with the returned `photoId` to create the EvidenceItem (which is where `areaId`, `stage`, `taskId`, `note` live).

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

Decision resolved in §15.0 #2 — **Option A** is the chosen path. The two options are kept here as design context for future readers.

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
- **Evidence read:** admin sees all; LH sees all evidence on jobs in their `assignedJobIds`; tradie sees own captures only on the Phil "Today's captures" strip (decision §15.0 #5 resolved). Server filters per actor role.
- **Evidence review (`status: reviewed | rejected`):** **admin only** in Phase D (decision §15.0 #6 resolved). LH read-only on evidence. Server returns 403 when `me.role !== 'admin'` on the review POST.
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
- Tap into a job → `/phil/jobs/[jobId]` → header + site notes + area groups → areas visible (archived items hidden).
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
- [ ] Phil bottom tab bar: **Jobs** tab is live; Snag tab is still UC (flips live in Phase D.5).

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
| D-06 | Permission scope leak (worker sees other workers' captures unintentionally) | Low | High | Server filters by `capturedById === me.id` for tradie role on the Phil endpoints (decision §15.0 #5 resolved). Server-side double-check on every read; tested by Playwright with two fixture tradies. |
| D-07 | Evidence accumulates without admin review (review SLA absent) | High | Low (Phase D); Medium (later) | Surface "X items pending review" on admin Command Centre once real data lands. Phase F adds SLA alerts. |
| D-08 | `data.json` blob grows unbounded with evidence array | Medium | Medium | §9.4 Option A accepts the growth for Phase D; Phase F Postgres migration breaks it out. If growth becomes painful pre-Phase-F, flip to §9.4 Option B (separate blob) with a single migration script. |
| D-09 | Cutover of `/admin/jobs` and `/jobs` regresses the legacy 4,772-line `public/admin/job.html` | High | High | The legacy file is preserved at `/legacy/admin-jobs/:jobId` for one billing cycle. PR-D4 is its own PR with rollback plan. Deploy Monday with on-call. |
| D-10 | Workers conflate "evidence captured" with "task complete" | Medium | Medium | Capture flow explicitly separates them: capture sheet does **not** auto-mark task done. Visual hierarchy keeps them as separate actions. |
| D-11 | Snag flow remains UC after Phase D, confusing workers who expect to raise issues | Medium | Low | UC pill is consistent with the existing pattern from Phase A. Decision confirmed: snags = Phase D.5 (the next slice after D exit). UC tap on the Snag tab shows a "Snags coming in Phase D.5 — raise via legacy `/my-day` until then" line item. Phase D release notes call this out. |
| D-12 | Capture-then-tab-close loses the photo if upload was in flight | Medium | Low | Documented limitation. Phase D not offline-first. Workers told via release notes; Phase F+ adds proper queue. |
| D-13 | Audit log unification (introducing `audit/{yyyy-mm}.json`) silently diverges from per-domain logs | Medium | Medium | Phase D writes both: unified `audit/` and per-domain (where they exist) for one cycle. Phase E migrates remaining domains and deletes the duplication. |
| D-14 | New `/api/jobs/[jobId]/evidence` endpoint is the first new Phase D API surface — easy to drift from legacy conventions | Medium | Medium | Schema-first (Zod). Mirror the patch-shape conventions used in `api/_lib/blob.js` and `api/task-toggle.js`. Code-review reads existing patterns before reviewing the new endpoint. |
| D-15 | Phase C (My Gear) not yet merged — Phase D plan assumes its scope ships first | High | Low | Phase D start gate (§13 sequence) blocks on PR #5 merge + 7-day quiet period per [16-migration-strategy.md] §E.3. |
| D-16 | Plan-acknowledgement modal expectation creep (workers expect plans in Phase D since "evidence" sounds plan-shaped) | Low | Low | Phase D scope doc + release notes explicitly call out "no plans yet — Phase E." |
| D-17 | Scope creep within Phase D itself: a single PR creeps from "Phil jobs read-only" to "Job Builder rebuild" | High | High | Build sequence (§13) enforces D1–D6 as separate PRs. Any new feature requires Oskar approval before being added to the Phase D build prompt. |
| D-18 | Two devices capturing evidence on the same job race on `data.json` write (legacy full-doc write semantics) | Medium | Medium | Worst case: one capture loses on the merge. Mitigation: the evidence write endpoint (§9.2 #2) reads `data.json`, appends to `evidence[]`, writes back — same race window as `api/task-toggle.js`. The window is ~50ms per write. Phase D accepts the tiny race risk; Phase F+ Postgres migration eliminates. If two captures lose in real-world testing, add an optimistic-concurrency `version` field to `data.json` and reject stale writes. |
| D-19 | EXIF location data preserved on Phil photos could leak worker home address if a worker captures a test photo from home | Low | Medium | Documented in release notes: "capture only on site." Server preserves EXIF (no strip in Phase D). Phase E adds optional strip toggle per org policy. Workers educated; no on-screen warning needed. |
| D-20 | Worker captures evidence without attaching to a task → admin sees "loose" evidence with no work-item context | High | Low | Task attachment is optional in §8. Admin Evidence panel groups by `(area, stage, task)` with an explicit "Unattached" section so loose captures don't hide. Phase D acceptance criteria do NOT require 100% task-attachment. Phase E adds gentle prompts ("attach to task before submit?") if the data shows >30% loose captures. |
| D-21 | Admin reviews evidence but doesn't realise the captured photo is stale (taken hours before submit due to slow upload retry) | Low | Low | EvidenceItem renders both `capturedAt` (client time on photo capture) and `createdAt` (server time on POST success). Admin Evidence panel shows both with a friendly gap indicator if >5 minutes. |
| D-22 | A worker submits the same photo twice (double-tap on Submit) | Medium | Low | Capture sheet disables the Submit button on tap until POST returns. If the network is flaky, the disabled state survives until success/failure (not auto-re-enabled by a timeout). Server is idempotent by `clientCapturedAt + capturedById` — a duplicate within 5s returns the same EvidenceItem rather than creating a new one. |
| D-23 | Field workers running an old Phil PWA cached version miss the new Jobs tab activation | Medium | Low | SW cache version is bumped in PR-D1 (Phil tab bar change). Cached clients update on next page load per the existing SW behaviour. Release notes call out: "force-refresh if Jobs tab doesn't appear after Phase D deploy." |
| D-24 | Workers tap "Mark task done" on the wrong task because the task list rendered while they were scrolling | Medium | Low | Confirmation dialog (modal) on the task-done tap, with the task name in big text. Per [14-technical-architecture-deep-dive.md] §E "no `confirm()`", this is a proper React modal. Cancel button is the default focused button. |
| D-25 | `api/_lib/job-tasks.js` `effectiveRoughInTasks` returns `[]` for a job with no task templates at all, and the Phil UI shows an empty task list with no explanation | Medium | Low | Phil renders explicit empty state: "No tasks defined for this area's rough-in stage yet. Tap Capture to record evidence anyway." Acceptance criteria (§12.1) test this case with a fixture job that has area-groups but no task templates. |

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
- [ ] Snag tab on Phil bottom bar remains UC. Goes live in Phase D.5.
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
- [ ] [11-operational-workflow-map.md](11-operational-workflow-map.md) #10, #11 marked "shipped" (with Phase D ref) for the slices that did ship; #12 (snags) reassigned from "Phase D" to "Phase D.5" in the same docs PR.
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

### Post-D · 7-day quiet + Phase D.5 kickoff (snags)

**Phase D.5 is confirmed** (Oskar, 2026-05-24). After Phase D exit + the standard 7-day quiet period, open a separate planning session for Phase D.5 (snag triage). That planning session produces `docs/rebuild-audit/26-phase-d5-snags-plan.md` (or the next available number) following the same shape as this doc. The Phase D.5 build session is then unblocked.

Phase D.5 scope sketch (not a plan — just the shape):

- `src/domains/snags/{schema,types,fixtures,client,service}.ts` (the `Defect` schema from [12-domain-model-deep-dive.md]).
- Phil `/phil/snags` (raise sheet: photo + area + 1-line description → submit). Snag tab flips from UC to live.
- Admin `/snags` triage queue (status filters, assign, set priority, close-reason).
- Cutover `/admin/snags → /snags` (Next.js owns).
- Reuses Phase D's `api/photos.js?action=upload-snag-photo` legacy primitive verbatim.
- Reuses the `AuditLog` unified log Phase D bootstraps.
- Existing legacy snag notification cron (`api/snag-notify.js`, `api/snag-email.js`) kept untouched; the new admin queue triggers them on assignment.

Phase D.5 must not bundle anything else (no ITP, no RFI, no materials).

---

## 14 · Claude Code build prompts

Paste-ready prompts for every Phase D build slice (D1 through D6) live in their own sibling doc:

→ **[25-phase-d-build-prompts.md](25-phase-d-build-prompts.md)**

That doc is self-contained: each prompt names its scope, its branch, its hard rules, its preflight reads, its checks, its PR title, and its expected report. Each Dx slice gets its own build session, its own PR, its own preview verification, its own merge. No single prompt covers more than one slice — that's the discipline that keeps Phase D from regressing into "everything jobs".

Pre-flight for any Phase D build session (binding regardless of slice):

- Phase C (PR #5) is merged to `main` and has had 7 days of quiet (per [16-migration-strategy.md] §E.3).
- This plan (this document) is approved by Oskar.
- §15 decisions 1–7 are resolved (all RESOLVED 2026-05-24 in this document); §15.1 decisions 8–9 either resolved or explicitly acknowledged as "Phase D ships without them — re-decide later."
- The build session is started **in a fresh worktree**, not in the Session 2 (Phase C hardening) worktree.
- `git status` confirms a clean working tree on the build branch.

If any of the above is uncertain, **STOP and ask** before writing code (per [20-agent-rules.md] #5, #29).

---

## 15 · Decisions

### 15.0 · Resolved decisions

#### Decision 1 (RESOLVED 2026-05-24) · Snag scoping

- **Question:** Do snags ship in Phase D, or defer to Phase D.5 / E?
- **Resolution (Oskar):** **Defer to Phase D.5.** Phase D stays focused on Jobs + Evidence only. Phase D.5 is a dedicated PR set after Phase D exit and before Phase E starts (see §13 Post-D).
- **Consequence:**
  - Phil Snag tab stays UC through all of Phase D; flips live with Phase D.5.
  - The `Defect` schema lands in Phase D.5, not Phase D.
  - The `/admin/snags → /snags` cutover happens in Phase D.5.
  - The Phase D build prompt in §14 has been tightened to reflect this — D1–D6 do not touch snags at all.
  - Audit doc reassignments will be made in the Phase D shipping docs PR ([11-operational-workflow-map.md] #12 moves from "Phase D" to "Phase D.5"; [21-rebuild-decision-record.md] gets a new ADR formalising the split).
- **Override mechanism if reversed later:** a new ADR superseding this would reopen Phase D scope. No code path silently re-enables snags in Phase D — the tab UC state, the missing schema, and the missing admin page are all explicit.

#### Decision 2 (RESOLVED 2026-05-24 · Session 3) · `EvidenceItem` storage shape

- **Question:** Append to `jobs/{jobId}/data.json` under a new `evidence[]` array, or split to a separate `jobs/{jobId}/evidence.json` blob?
- **Resolution (Session 3 — recommended):** **§9.4 Option A** — append to `data.json.evidence[]`.
- **Rationale:**
  - Consistency: `data.json` already carries `dwellings[]`, `snags[]`, `notes[]` per legacy convention. Adding `evidence[]` matches the established shape (api/jobs.js:366).
  - One-fetch admin rendering: the new `/jobs/[jobId]` Evidence tab is a sub-view of the job page; reading `data.json` already pulls everything the page needs.
  - The full-doc-write risk (audit risk 7) is bounded by Phase D's volume: ~5–20 EvidenceItems per active job before Phase E reporting cycles them out. At typical photo metadata size (~200B per row) the blob impact is negligible.
  - Phase F+ Postgres migration: the `evidence[]` array becomes its own table via the same dual-write pattern planned for other domains (per [16-migration-strategy.md] §D.4). No throwaway work.
- **Override mechanism if reversed:** if real-world `data.json` blob size becomes painful before Phase F+, flip to Option B with a one-time backfill script reading `evidence[]` from each `data.json` and writing it to `jobs/{jobId}/evidence.json`. The API surface stays identical; only the persistence path changes.

#### Decision 3 (RESOLVED 2026-05-24 · Session 3) · Phil jobs list filtering

- **Question:** Server-side filter (existing endpoint) vs client-side filter (response-side)?
- **Resolution (Session 3 — verified in `api/jobs.js:188-195` and `api/jobs.js:174-178`):** **Server-side filter — already implemented and authoritative.**
- **Rationale:**
  - `GET /api/jobs` already filters: `visible = data.jobs.filter(j => (me.assignedJobIds || []).includes(j.id))` for non-admin/non-client roles (api/jobs.js:194).
  - `GET /api/jobs?id=<jobId>` returns 403 if a non-admin tradie tries to fetch a job not in their `assignedJobIds` (api/jobs.js:174-178: `if (!canSee) return res.status(403).json({ error: 'forbidden' })`).
  - No client-side filtering needed. No permission leak possible.
  - The Phil jobs client (`src/domains/jobs/client.ts`) just calls `GET /api/jobs` and consumes the (already-filtered) response.
- **Consequence:** D1 stays **"no backend changes"** as originally planned. Stronger guarantee than the plan originally hedged on.

#### Decision 4 (RESOLVED 2026-05-24 · Session 3) · Pre-cutover preview URL

- **Question:** Build the new admin Jobs surface at `/v2/jobs`, `/admin-v2/jobs`, or another path?
- **Resolution (Session 3 — recommended):** **`/v2/jobs`** for pre-cutover preview verification.
- **Rationale:**
  - Consistent with Phase A's `/v2/login` and `/v2/phil` precedent — establishes a recognisable "new-app preview lane" pattern.
  - `/v2/jobs` is not claimed by `vercel.json`.
  - At cutover time (PR-D4), Next.js takes over canonical `/jobs` and `/admin/jobs`; the `/v2/jobs` route is then either removed or kept as a permanent alias. Recommendation: **remove** at cutover so there is one canonical URL per concept (per [13-ui-information-architecture.md] §Foundational rules).

#### Decision 5 (RESOLVED 2026-05-24 · Session 3) · "Today's captures" strip on Phil job detail

- **Question:** Show own captures only, or team captures on the same job?
- **Resolution (Session 3 — recommended):** **Own captures only in Phase D.** Revisit in Phase E.
- **Rationale:**
  - Privacy-first default. Until the team-visibility permission model is explicit (Phase E), the safest default is to scope to `capturedById === me.id`.
  - Avoids a Phase D "Sarah saw my photo at 3pm" social-feed drift that this plan doesn't have UX patterns for.
  - The admin Evidence tab already shows all captures across the team — admin/PM has the team view.
  - Field workers who *want* to coordinate captures use SMS/Slack today; that's a Phase E "team timeline" concern, not Phase D.
- **Override mechanism:** when Phase E ships, add a `?scope=team` query to the evidence client + a server-side permission check (any worker assigned to the job sees the team strip).

#### Decision 6 (RESOLVED 2026-05-24 · Session 3) · LH evidence review

- **Question:** Can Leading Hand mark evidence reviewed/rejected for their crew, or read-only?
- **Resolution (Session 3 — recommended):** **LH read-only on evidence in Phase D.** Revisit in Phase E.
- **Rationale:**
  - LH hours-approval scope is well-defined and tested (excludes other LHs' submissions). Evidence review has no parallel precedent in legacy — extending without explicit testing would invent a permission gate at the wrong time.
  - Phase D's admin Evidence review surface is small (one panel inside `/jobs/[jobId]`). Adding LH branching adds matrix complexity to Phase D Playwright specs.
  - Workers' evidence still flows to the admin queue; LH can flag-via-chat for now.
  - Phase E's permissions revisit will define `evidence.review` capability per role; LH may get it then.
- **Server enforcement:** `POST /api/jobs/[jobId]/evidence/[evidenceId]/review` returns 403 if `me.role !== 'admin'` (no PM role exists in legacy; treat admin as the reviewer). LH is `(user.role === 'leadingHand')` in `api/_lib/auth.js:104` — gated out.

#### Decision 7 (RESOLVED 2026-05-24 · Session 3) · `/jobs` post-cutover audience

- **Question:** After Phase D cutover, does Next.js's `/jobs` serve admin (PM/admin) or Phil (worker)?
- **Resolution (Session 3 — recommended):** **`/jobs` = admin-facing.** Phil is at `/phil/jobs`.
- **Rationale:**
  - Consistent with `/command-centre` (admin), `/hours/approvals` (admin), `/v2/phil` (worker) — no overload of canonical URLs.
  - The legacy ambiguity goes away: today `/jobs → /admin/jobs.html` (admin) but workers reach jobs via `/phil`. Post-cutover, the worker path is `/phil/jobs` and the admin path is `/jobs`. Clean.
  - Bookmarks: any admin who bookmarked `/jobs` (which today is the admin jobs list) keeps working. Workers who somehow have `/jobs` bookmarked (unusual) get redirected per role at the middleware layer.
- **Middleware behaviour:** if a worker (`role: 'tradie' | 'leadingHand'`) hits `/jobs`, middleware redirects to `/phil/jobs`. If an admin hits `/phil/jobs`, no redirect (admins CAN view the Phil-shaped UI; useful for debugging). This mirrors the current `landingFor()` pattern in `src/lib/auth/landing.ts`.

### 15.1 · Open decisions still requiring Oskar's call before D1 starts

After Session 3's autonomous pass, **all 7 decisions in the original plan are now resolved with recommendations or hard verifications.** The list below captures decisions Session 3 *intentionally* did not resolve because they are founder calls (scope, money, business shape) rather than product-engineering trade-offs.

#### Decision 8 (OPEN · founder call) · "Activity" surface scope in Phase D

- **Question:** Phase D bootstraps the unified `AuditLog` (§5.9) and proposes a thin `/activity` admin feed (§13 D5) showing evidence captured/reviewed/rejected + task-toggled events. Should this also include the existing per-job audit events written by `api/_lib/job-audit.js` (rename, status change, basics-changed, area-structure changes, etc.) which today land in `jobs/{id}/job-audit/...`?
- **Session 3 leaning:** **Yes** — `/activity` should aggregate both new evidence events AND existing per-job legacy events so the surface is genuinely useful from day one. The Phase D `/activity` page reads the unified log AND fans out to per-job legacy logs as a fallback. Phase E consolidates by migrating per-job logs into the unified table.
- **Why a founder call:** this widens D5's read complexity and product scope (the "activity feed" suddenly looks like a real admin tool, not just an evidence audit trail). May want to keep it bounded to evidence-only in Phase D so the surface stays "small enough to not regress in cutover" and expand in Phase E.

#### Decision 9 (OPEN · founder call) · Phase D field-pilot strategy

- **Question:** When the Phase D build completes, do we pilot on production with one nominated tradie + one admin for 1 week before going wide, or release wide immediately after preview verification?
- **Session 3 leaning:** **Pilot.** Hours pilot pattern from Phase B worked; evidence has higher field-UX variance (camera, sunlight, glove use). One-week single-tradie pilot then wide rollout reduces blast radius.
- **Why a founder call:** depends on which tradie is available, scheduling, and whether the Phase D ship date conflicts with a high-pressure week on a real job.

---

## 16 · Cross-references

- [10-product-definition.md](10-product-definition.md) §A, §B (tradesman, PM, admin user groups), §C (product surfaces).
- [11-operational-workflow-map.md](11-operational-workflow-map.md) #7 (Job creation — deferred), #9 (Worker assignment — deferred), #10 (Task completion — partial), #11 (Photo/evidence — primary), #12 (Snag — Phase D.5), #19 (Stages — read-only), #20 (Areas — read-only).
- [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) §Jobs, §`Evidence`, §`Photo`, §`AuditLog`, §"Fields that must NOT be skipped", §"Per-phase minimum models" §"Phase D".
- [13-ui-information-architecture.md](13-ui-information-architecture.md) §Admin/Jobs, §Phil/Jobs, §"Inside a Job (Phil)", §"Capture screens", §"Banned patterns".
- [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md) §C (app structure: `src/domains/jobs/`, `src/domains/evidence/`, `src/app/phil/jobs/`, `src/app/(admin)/jobs/`), §D (coexistence rules), §E (binding code rules).
- [16-migration-strategy.md](16-migration-strategy.md) §A (principles), §B (Phase map row "D"), §C.3 (cutover sequencing).
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) §B.5 (route smoke), §B.11 (route collision), §C.4 (Phase D acceptance).
- [20-agent-rules.md](20-agent-rules.md) §"Build posture" #6 (don't overbuild beyond phase), #8 (UC default), §"Deploy posture" #11–#15, §"File posture" #21–#22 (no UI without data model; no entity without ownership/status/audit rules).
- [21-rebuild-decision-record.md](21-rebuild-decision-record.md) ADR-002 (retain backend), ADR-011 (jobs+evidence is third loop), ADR-013 (UC over fake-it), ADR-015 (mock data labelled), ADR-020 (Vercel Blob continues).
- [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md) — format precedent for this plan.
- [[project_buhlos_phil_hours_pipeline]] — user's six-step deployment order; Phase D follows the same pattern.
- [[feedback_hide_unfinished_features]] — Snag tab stays UC through Phase D; flips live in Phase D.5 (decision §15.0).
- [[project_buhlos_phil_naming]] — Phil + BuhlOS canonical names; "Switchboard" / "Site Office" banned in all new Phase D code.

---

## 17 · Document status

| Field | Value |
| --- | --- |
| Document | `docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md` |
| Phase | D · Jobs and evidence loop plan |
| Status | **Draft — §15 decision 1 (snag scoping) resolved 2026-05-24; §15 decisions 2–7 still open** |
| Author | Phase D planning agent (session 3 — separate from Session 2 / PR #5) |
| Author branch | `phase-d-jobs-evidence-plan` |
| Base commit | `origin/main` (Phase B + production hardening) |
| Assumed precondition | Phase C (PR #5 · My Gear) merged to `main` + 7-day quiet period |
| Confirmed phase split | **D = Jobs + Evidence**, **D.5 = Snags / defects** (new sub-phase), **E = ITP / RFI / Materials** (+ Plans / Variations per audit) |
| Next action | Oskar answers §15.1 open decisions 2–7 → build session opens for D1 with the paste-ready prompt in §14 |
