# Phase E plan — operational loops beyond Jobs / Evidence / Snags

> **Status:** planning (docs-only). No app code in this session.
> **Audience:** Oskar (founder decisions), future Phase E build sessions.
> **Read alongside:** [11-operational-workflow-map.md](11-operational-workflow-map.md) §13–§22, [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) §"Pre-conditions for marking a task done" + §"ITPTemplate" / §"ITPCompletion" / §"RFI" / §"Material*", [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) §"Out of scope (deferred)", [27-interface-usability-pass.md](27-interface-usability-pass.md), [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md).

---

## 1 · Executive summary

Phase D shipped three operational loops:
- **Hours** (Phase B) — worker submits → admin approves → status flows back.
- **Gear** (Phase C) — admin assigns → worker receives → worker returns → admin sees history.
- **Jobs / Evidence / Snags** (Phase D + D.5) — worker captures evidence / raises snag → admin reviews → status returns to worker → audit-log records everything.

Phase E adds the operational loops that turn raw field data into auditable, controlled, billable work:

- **E1 · ITP / QA checklists** — recommended next slice.
- **E2 · RFIs** — deferred; depends on a working answer/response surface.
- **E3 · Materials** — deferred; depends on supplier + delivery foundations.

This plan recommends **E1 = ITP / QA checklist foundation**, with E2 and E3 sequenced behind it. The reasoning, comparison, and recommended scope follow.

### Why ITP first

1. **Highest direct connection to shipped Phase D data.** ITPs attach to job + stage + area + task — the same canonical task IDs Phil already uses for evidence and snags. Evidence (D2–D5) and snags (D.5) are the inputs an ITP checkpoint asks for; ITP gives them a structured purpose.
2. **Closed loop already documented.** [11-operational-workflow-map.md §15](11-operational-workflow-map.md) defines the full ITP lifecycle (`in_progress → ready_for_review → approved / needs_info`) with the "four-eyes" rule and audit requirements. The data model is mapped in [12-domain-model-deep-dive.md §"ITPTemplate"](12-domain-model-deep-dive.md). No discovery work required.
3. **Field utility from day one.** A sparky finishing rough-in on a power point needs a list — "earth tested? polarity? cable embedment? plate fastenings?" — and currently writes this on a phone note or paper. The ITP loop turns that into an auditable record without changing the worker's behaviour.
4. **Compliance proof.** Builder clients increasingly demand evidence that a stage was inspected before the next trade arrives. The ITP completion record is the artefact that proof needs.
5. **Already a stub in production.** `api/itp-templates.js`, `api/job-itps.js`, and `public/admin/itp.html` exist (v1 + v2 mentioned in doc 12). The legacy code is partial and not used in anger. Rebuilding cleanly avoids carrying it forward.

### What this plan defers

- **PDF certificate generation** for completed ITPs. Phase F+.
- **Client-portal sign-off** on ITPs. Phase F+.
- **AI plan interpretation** to auto-generate ITPs from drawings. Phase F+.
- **External regulator submission.** Phase F+.
- **Materials inventory** — moves into E3 once E1 ships.
- **RFIs** — moves into E2 once E1 ships.
- **Job-stage completion blocked by ITP** — toggleable, but default off in E1.

---

## 2 · Candidate comparison

| Dimension | E1 · ITP / QA | E2 · RFIs | E3 · Materials |
| --- | --- | --- | --- |
| **Business value** | High — compliance + rework reduction | Medium — only when external builder asks for plan clarity | High — but only with supplier integration |
| **Field usefulness** | High — workers want a list to tick | Medium — most RFIs today are SMS / phone | Medium — request flow is small; the value is in reconciliation |
| **Fit with shipped D data** | Strong — attaches to job/stage/area/task, links evidence + snags | Moderate — attaches to job/area, can attach evidence | Weak — needs supplier domain + order data Phase D doesn't have |
| **Data-model complexity** | Medium — Template + Instance + Item + Response | Medium — RFI + RFIResponse[] thread | High — Request + PO + Delivery + Reconciliation + Inventory |
| **Closed-loop achievable** | Yes — admin/LH reviews, worker sees status | Yes — admin closes after external response | Partial — closes admin-side only without supplier integration |
| **Differs from snags how?** | Pre-defined questions vs ad-hoc; gate vs issue | Communication request vs operational issue | Material request vs work issue |
| **Independent reviewer required** | Yes (four-eyes) — already documented | No | No |
| **Existing legacy code** | Stub: `api/itp-templates.js`, `api/job-itps.js`, `public/admin/itp.html` | None (new domain) | Partial: `api/materials-list.js`, `api/materials-summary.js`, `api/supplier-*.js` |
| **Implementation risk** | Medium — multi-table model, audit, four-eyes | Medium — external comms loop hard to model cleanly | High — inventory complexity, supplier sync |
| **Pilot feasibility** | High — one job, one template, one stage | Medium — needs a live builder/client to actually answer | Low — needs a real PO flow |
| **Score (subjective, 1-5)** | **4.4** | 3.0 | 2.6 |

**E1 winner: ITP / QA checklist foundation.**

### Why not RFIs first?
RFIs need a back-and-forth thread with someone outside the org (builder / client). Without that recipient surface (email or external portal), an "RFI" in BuhlOS is just a snag with a different name. Build it once the rest of the system makes the external link cheap.

### Why not materials first?
Materials only delivers business value when it covers the full chain — request → PO → delivery → reconciliation → inventory. That's a Phase F-shaped commitment, not a Phase E slice. E3 will pick it up once supplier integration is on the table.

---

## 3 · E1 recommended loop

```
                         Phil (worker)                              BuhlOS (admin/LH)
                    ┌────────────────────┐                    ┌──────────────────────┐
   admin assigns →  │  ITP Instance      │ ←─ assigns ──────  │  Pick template       │
   template to job  │  appears in Phil   │                    │  Set scope: stage,   │
                    │  job detail        │                    │  area (optional)     │
                    └─────────┬──────────┘                    └──────────────────────┘
                              │
                              │  Phil opens ITP                                              
                              ▼                                                              
                    ┌────────────────────┐                                                  
                    │  Tick each item    │                                                  
                    │  Attach evidence   │ ← already-captured items only (no new capture
                    │  for items that    │   flow buried inside the checklist)
                    │  require photo     │
                    │  Add note if       │
                    │  needed            │
                    │  Submit            │
                    └─────────┬──────────┘
                              │
                              │  status: in_progress → ready_for_review
                              ▼                                                              
                                                              ┌──────────────────────┐
                                                              │  Admin/LH review     │
                                                              │  queue                │
                                                              │  See each item       │
                                                              │  + evidence + note   │
                                                              │  Accept whole, or    │
                                                              │  Reject with reason  │
                                                              │  (per-item rework    │
                                                              │  in v2)              │
                                                              └─────────┬────────────┘
                                                                        │
                                                                        │  status:
                                                                        │  accepted | rejected
                                                                        │     (needs_rework)
                                                                        ▼
                    ┌────────────────────┐
                    │  Phil sees status  │  ← rejection reason inline (same pattern as
                    │  + reason if       │     D.5 snags PR #20 — rose-bordered alert)
                    │  rejected          │
                    └────────────────────┘
```

This is the same loop shape as evidence (D2–D5) and snags (D.5). The implementation can reuse the audit-log, role-tier helpers (`api/_lib/auth.js`), per-job blob storage pattern, `/v2/jobs/[jobId]/...` admin pages, and the Phil `JobSnagsPanel`-style card.

### Why "four-eyes" matters in E1
[11-operational-workflow-map.md §15](11-operational-workflow-map.md): "Independent reviewer (cannot be the submitter)." The reviewer must be a different licensed person. E1 enforces this server-side in the transition handler — same shape as `canRoleTransition` in `api/snags.js`.

---

## 4 · E1 in scope

### Data
- New ITP domain: `ITPTemplate`, `ITPTemplateItem`, `ITPInstance`, `ITPItemResponse`, `ITPReview`.
- Storage: per-job blob `jobs/<jobId>/data.json` adds `itpsV1[]` array (NEW namespace; legacy `data.itps` if any stays untouched).
- Templates: separate blob `itp-templates.json` at the root (small set, shared across jobs).
- Audit verbs: `itp.instance.created`, `itp.instance.submitted`, `itp.instance.accepted`, `itp.instance.rejected`, `itp.instance.reopened`.

### API
- `GET /api/itp-templates` — list/admin
- `POST /api/itp-templates` — admin only
- `GET /api/itps?jobId=` — list instances on a job
- `POST /api/itps?jobId=` — create instance from template
- `POST /api/itps?jobId=&action=submit` — worker submits
- `POST /api/itps?jobId=&action=review` — admin/LH (different person) accepts / rejects with reason
- `POST /api/itps?jobId=&action=reopen` — admin re-opens a closed ITP if needed
- `GET /api/audit-log?targetType=itp&targetId=<id>&jobId=<id>` — D2/D5 pattern extended

### Phil UI
- `JobITPPanel` on `/phil/jobs/[jobId]` — below Snags panel. Mirrors `JobSnagsPanel` shape.
- `ITPCompletionSheet` — full-screen sheet listing template items, with required-evidence pickers per item.
- Rejection reason visible inline (same pattern as snags PR #20).

### Admin UI
- `/v2/jobs/[jobId]/itp` — instance queue (mirror of snags queue).
- `ITPDrawer` — per-instance detail.
- `ITPRejectModal` — required reason, ≤500 chars (mirror of snag reject modal).
- `/v2/itp/templates` — template admin (later in E1, may slip to E1.1).

### Tests
- Unit tests for state machine, validation, role gates (Vitest, ~50+).
- Component test for `matchesFilter`-style helper.
- Playwright route-gate tests + skipped authenticated flows (same shape as snags).

### Docs
- Add `phase-e1-itp-runbook.md` when the build session opens.
- Update [23-rebuild-index.md](23-rebuild-index.md) ship table.

---

## 5 · E1 out of scope

- **PDF / certificate generation** — Phase F+. The completed record persists; rendering can come later.
- **Per-item rework** (admin rejects individual items, worker re-submits only those). v2 — keep E1 as accept-whole / reject-whole-with-reason.
- **Template inheritance / parent-child templates**. v2.
- **Conditional checkpoints** (item shows only if a previous item was set to X). v2.
- **Client portal sign-off**. Phase F+.
- **External-email notifications** (e.g. notify builder client on ITP acceptance). Phase F+.
- **AI plan interpretation** to auto-generate ITP templates. Phase F+.
- **Stage completion blocked by ITP completion**. Toggleable flag, default off in E1. Wire on/off in E1.1 if Oskar wants the gate.
- **Snag auto-creation on rejected item**. Tempting, but adds an unintended cross-domain side-effect. Defer to E1.1 once we see real reject patterns.
- **RFI integration**. E2.
- **Materials integration**. E3.

---

## 6 · Roles

Same tiers as PR #23 normalisation (`api/_lib/auth.js`):

| Role tier | Roles | Can do in E1 |
| --- | --- | --- |
| `admin` | admin, boss, owner, manager, office, pm, estimator | Create templates, assign instances, accept/reject (subject to four-eyes), re-open |
| `leadingHand` | leadinghand, leading_hand, leading-hand, lh | Submit on assigned jobs, **review on assigned jobs subject to four-eyes** |
| `field` | tradie, apprentice, labourer, electrician | Submit on assigned jobs; tick items; attach own evidence |
| `client` | client | 403 (read-only at later stage) |

The four-eyes rule: the user transitioning `ready_for_review → accepted/rejected` MUST NOT be the same user who created the instance OR submitted it. Server enforces; UI hides the button when the viewer would fail.

---

## 7 · Data model (Zod, mirrors snags shape)

### `ITPTemplate`
```ts
{
  id: 'itpt_<nanoid>',
  name: string,                           // ≤120
  description: string | null,             // ≤1000
  jobType: string | null,                 // freeform tag, e.g. 'residential'
  stage: 'roughIn' | 'fitOff' | 'any',
  items: ITPTemplateItem[],
  source: 'admin' | 'system',
  createdById, createdByName, createdAt,
  updatedAt,
  archived: boolean,                      // soft-delete; templates with instances can't be hard-deleted
}
```

### `ITPTemplateItem`
```ts
{
  id: 'iti_<nanoid>',
  order: number,
  title: string,                          // ≤120
  description: string | null,             // ≤500 — acceptance criteria
  severity: 'critical' | 'major' | 'minor',
  requiresPhoto: boolean,
  requiresNote: boolean,
}
```

### `ITPInstance`
```ts
{
  id: 'itpi_<nanoid>',
  jobId: string,
  templateId: string,
  templateName: string,                   // denormalised snapshot at create time
  stage: 'roughIn' | 'fitOff' | null,
  areaId: string | null,
  areaName: string | null,                // denormalised
  status: 'in_progress' | 'ready_for_review' | 'accepted' | 'rejected' | 'closed',
  responses: ITPItemResponse[],
  rejectionReason: string | null,
  evidenceIds: string[],                  // top-level supporting evidence, in addition to per-item
  snagIds: string[],                      // snags raised against this ITP
  createdById, createdByName, createdAt,
  submittedById, submittedByName, submittedAt,
  reviewedById, reviewedByName, reviewedByRole, reviewedAt,
  auditLogIds: string[],
  updatedAt: string,
}
```

### `ITPItemResponse`
```ts
{
  itemId: string,                         // refs ITPTemplateItem.id (denormalised)
  itemTitle: string,                      // snapshot at submit time
  state: 'pass' | 'fail' | 'na',
  note: string | null,                    // ≤500
  evidenceIds: string[],                  // captures attached to this item
  respondedById, respondedByName, respondedAt,
}
```

### Validation invariants
- Submit (`in_progress → ready_for_review`) requires every item to have a response, and every `requiresPhoto: true` item to have at least one `evidenceId`.
- Review (`ready_for_review → accepted`) requires no item state to be `fail`. If any item is `fail`, admin must reject with reason instead.
- Reject (`* → rejected`) requires `rejectionReason` ≥1 trimmed char, ≤500.
- Reopen (`closed → ready_for_review`) is admin-only.

---

## 8 · Status lifecycle (state machine)

```
   null ──► in_progress ──► ready_for_review ──► accepted ──► closed
                ▲                  │                              ▲
                │                  ▼                              │
                └────────── rejected (reason required)            │
                                   │                              │
                                   └──► in_progress (worker fixes)│
                                                                  │
   closed ──► ready_for_review (admin re-opens) ─────────────────┘
```

| From | To | Who | Notes |
| --- | --- | --- | --- |
| `null` | `in_progress` | admin / LH | "Assign template to job/stage" |
| `in_progress` | `ready_for_review` | worker / LH | All items answered; required photos attached |
| `ready_for_review` | `accepted` | admin / LH (≠ submitter, ≠ creator) | No fail items |
| `ready_for_review` | `rejected` | admin / LH (≠ submitter) | Reason required |
| `rejected` | `in_progress` | worker / admin | Worker fixes and re-submits |
| `accepted` | `closed` | admin | Optional; admin closes the loop |
| `closed` | `ready_for_review` | admin | Re-open if defect found later |

Direct `in_progress → accepted` blocked (no skip-review). Direct `null → accepted` blocked (no fake-completed).

Server enforces both `canTransition` and `canRoleTransition` (mirror of snags). Conflicts return 409 JSON.

---

## 9 · Routes

### Phil
- `/phil/jobs/[jobId]` — adds `<JobITPPanel>` below the snags panel
- (No separate Phil route; in-page sheet for completion, same shape as `ReportSnagSheet`)

### Admin (BuhlOS)
- `/v2/jobs/[jobId]/itp` — per-job ITP instance queue + drawer
- `/v2/itp/templates` — global template admin (optional in E1; may slip to E1.1)
- (No legacy `/admin/itp` cutover in E1)

Middleware adds `/v2/itp/templates` to PROTECTED with `surface: 'admin'` (admin-tier only, no LH).

---

## 10 · API plan

### `GET /api/itp-templates`
- Returns `{ templates: ITPTemplate[] }`
- Auth: admin/LH/field can list (workers need to see what's available); client → 403
- 200 / 401 / 403

### `POST /api/itp-templates`
- Admin-tier only (no LH)
- Body: `{ name, description?, jobType?, stage, items: ITPTemplateItem[] }`
- 201 returns canonical template
- 400 validation; 401; 403

### `GET /api/itps?jobId=<id>`
- Auth-gated to job. Returns `{ itps: ITPInstance[] }` newest-first by `createdAt`.
- 200 / 400 (no jobId) / 401 / 403 / 404 (job not found surfaces from same `loadJobOrFail` pattern as snags)

### `POST /api/itps?jobId=<id>` (create instance)
- Admin/LH on assigned jobs.
- Body: `{ templateId, stage?, areaId? }`
- Server creates instance, snapshots template fields, status=`in_progress`.
- 201 / 400 / 401 / 403 / 404

### `POST /api/itps?jobId=<id>&action=submit`
- Worker (creator/assignee/any-field-role on assigned job) submits.
- Body: `{ itpId, responses: ITPItemResponse[], evidenceIds?, snagIds? }`
- Server validates: all items answered; required photos present; no items missing IDs.
- Status `in_progress → ready_for_review`.
- 200 / 400 / 401 / 403 / 404 / 409 (already submitted)

### `POST /api/itps?jobId=<id>&action=review`
- Admin/LH reviewer (≠ submitter, ≠ creator).
- Body: `{ itpId, decision: 'accept' | 'reject', reason? }`
- `reason` required if `decision === 'reject'`.
- Server returns canonical updated instance.
- 200 / 400 / 401 / 403 / 404 / 409

### `POST /api/itps?jobId=<id>&action=reopen`
- Admin only.
- Body: `{ itpId, reason? }`
- Status `closed → ready_for_review` OR `accepted → ready_for_review`.
- 200 / 400 / 401 / 403 / 404 / 409

### `GET /api/audit-log?targetType=itp&targetId=<id>&jobId=<id>`
- Pattern extended from D5. `targetType=itp` accepted.
- Same auth as snag audit-log.

### Error conventions (mirror snags + evidence)
- 400 = request-validation error (invalid body shape, missing required, too-long)
- 401 = unauthenticated
- 403 = role / job access denied
- 404 = job or itp not found
- 409 = state-machine conflict (transition not allowed from current status; four-eyes violation)
- 500 = unexpected server error

---

## 11 · Storage strategy

### Templates
- Single global blob: `itp-templates.json` at root (small set, shared across jobs).
- Schema: `{ templates: ITPTemplate[] }`.
- Reads cached via the existing `readBlob` (5s in-memory TTL, write-through after PR #26).
- Trim policy: archived templates kept indefinitely (they're tiny).

### Instances
- Per-job blob: `jobs/<jobId>/data.json` adds `itpsV1[]` array.
- Same write-through cache benefits as snags (PR #26).
- Full-doc rewrite race acceptable (small per-job counts).
- Read-after-write consistency: use `readBlob` after `writeBlob` on the same instance (write-through cache hit); fall back to `readBlobFresh` + 750ms on `canTransition` reject (same pattern as snags).
- Audit dual-write: new monthly `audit/<yyyy-mm>.json` AND legacy `api/_lib/job-audit.js` per-job log.

### Canonical updated object
Every mutation API returns the canonical updated `ITPInstance` so the client doesn't have to refetch through the cache.

### Future migration
When ITP volume grows beyond comfortable per-job blob sizes (~100 instances per job is the soft cap), split out `jobs/<jobId>/itps.json`. This is a flag day; defer until needed.

---

## 12 · Phil UI plan

### Discoverability
On `/phil/jobs/[jobId]`, add a new `<JobITPPanel>` card **below** the Snags panel. Order top-to-bottom:

1. Site context
2. Today's captures (evidence)
3. Snags
4. **ITP / inspections (new)**

### `JobITPPanel` shape
- Card header: "Inspections" + `N to do` pill if any in `in_progress` or `rejected`.
- Empty state: "No inspections assigned for this job."
- List of `needsWorkerAttention(status)` instances: open + ready_for_review (worker can recall) + rejected (with reason inline, rose-bordered same as snag rejection).
- Primary action per row: "Open inspection" → opens full-screen `<ITPCompletionSheet>`.

### `ITPCompletionSheet`
- Header: template name, scope chip (stage + area).
- Body: scrollable list of items. Each item:
  - Title (large, ≥18px on mobile)
  - Acceptance criteria below in muted text
  - Severity pill (critical = rose, major = amber, minor = neutral)
  - Three-button pass/fail/na (big touch targets per doc 27 §4)
  - Note input if `requiresNote` or if `state === 'fail'`
  - "Attach photo" CTA if `requiresPhoto` — opens existing capture sheet inline OR picks from this job's recent captures.
- Footer: "Submit for review" (disabled until all items answered and required photos attached).
- "Save draft" auto-fires on every change so the worker can leave and come back.

### UX rules (per doc 27 §4)
- Mobile-first. Phil never gets the admin queue UI.
- One primary action per screen.
- Tap targets ≥48px.
- Status pills use the 5-tone palette (info / success / danger / warning / neutral).
- No fake metrics, no fake completion.
- Rejection reason rendered inline with rose alert (verbatim copy of snag pattern).

### Offline / unsaved-state
Draft responses persist to `localStorage` keyed by `itpInstanceId`. On reconnect, sync to server on next "Save". This matches Phase D3's capture-sheet retry pattern. Detailed in the build prompt.

---

## 13 · BuhlOS admin UI plan

### Discoverability
- `/v2/jobs/[jobId]/itp` — new admin page, mirror of `/v2/jobs/[jobId]/snags`.
- `/v2/jobs` index already shows pending counts per job (D6). Add an `Inspections N` chip beside the existing Snags chip.

### `ITPQueue` (mirror of `SnagsQueue`)
- Active / Done / All filter; default = active (ready_for_review + in_progress + rejected).
- Status-first rows: status pill, scope (template + stage + area), submitter, submitted-when.
- Primary next-step button:
  - `ready_for_review` → "Accept" (if four-eyes passes) + "Reject" (if four-eyes passes)
  - `in_progress` → "View progress" (read-only drawer)
  - `accepted` → "Close" (admin only)
  - `rejected` → "View" (read-only)
- Read-only LH (when reviewer would violate four-eyes) shows "You created/submitted this — pass to another reviewer."

### `ITPDrawer`
- Right-slide panel mirror of `SnagDrawer`.
- Header: template name + scope + status pill.
- Body: per-item list with the worker's response, attached evidence thumbnails, notes.
- Footer:
  - Accept / Reject buttons (gated by four-eyes)
  - Re-open button if `closed`
- History: full audit-log of all transitions on this instance.

### `ITPRejectModal`
- Mirror of `SnagRejectModal`. Required reason ≤500 chars, counter visible.

### Templates admin (lighter — may slip to E1.1)
- `/v2/itp/templates` shows the global template list + create button.
- Create: name, description, jobType tag, stage, items (each with title, description, severity, requiresPhoto, requiresNote).
- Edit: archives the old version and creates a new one (templates with instances become immutable).
- Admin-tier only.

### UX rules
- Queues, not dashboards (doc 27 §5).
- Status-first rows.
- Drawer for detail, not full page.
- No three-dot menus for primary actions.
- No fake metrics.

---

## 14 · Testing plan

### Unit (Vitest)
- Domain schema: ITPTemplate, ITPInstance, ITPItemResponse — happy paths + invalid bodies.
- State machine: full transition matrix (mirror of `snags.test.ts`).
- Role gates: four-eyes enforcement (submitter ≠ reviewer; creator ≠ reviewer).
- Validation: submit requires all items answered + required photos; review reject requires reason.

### Component / integration
- Filter helper for ITPQueue (mirror of `evidence-filter.test.ts`).
- Phil panel renders `needsWorkerAttention` set (mirror of snag panel test).

### API smoke (`scripts/smoke-evidence-routes.js` extended)
- Add 5+ checks: `/api/itp-templates`, `/api/itps?jobId=`, the three POST actions, `/api/audit-log?targetType=itp`.
- All unauth → 401 JSON.
- Total target: 30+ checks.

### Authenticated end-to-end (`scripts/auth-smoke-d55-snags.sh` companion)
- New `scripts/auth-smoke-e1-itp.sh`.
- Tradie: log in, list templates, create instance is admin-only so this is a 403 check, then submit a pre-assigned instance.
- Admin: log in, create template, assign instance, then on the OTHER admin login (four-eyes), accept.
- Admin: reject another instance with reason.
- Verify audit-log carries all transitions.
- Cleanup: close all TEST E1 ITP instances; archive the test template.

### Local checks (must all pass on every PR)
- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run check:admin-shell`
- `npm run check:sw-cache-version`
- `npm run check:production-shell`
- `npm run smoke:admin-routes`

### Preview + production smoke
- Preview deploy must reach READY before merge.
- Unauth: `npm run smoke:evidence-routes` extended.
- Authenticated: `npm run smoke:auth-d55-snags` (regression) + `npm run smoke:auth-e1-itp` (new) on the preview, then on production after merge.

---

## 15 · Rollout plan

### Pre-rollout
1. Land E1 via PR. Merge only after preview is green and authenticated smoke passes.
2. Verify production deployment auto-attaches `buhlos.com` (no manual promotion).
3. Run `npm run smoke:evidence-routes` against production — should be 30+/30+ pass.

### Pilot (one job, one template, one tradie, one admin)
1. Pick a job: Birdwood IV3232 (already the canonical test bed).
2. Create one template: e.g. "Power point rough-in checks" with 5 items (earth, polarity, embedment, plate, brand-tag — `requiresPhoto: true` on earth + polarity).
3. Assign to one stage on one area.
4. Tradie (`oskar`) submits.
5. Admin (`tom`) accepts via the four-eyes path (different user than the submitter — `tom` ≠ `oskar`).
6. Verify Phil sees `accepted` status; audit-log has all events.

### Field test
- Run for one week on Birdwood with one ITP template.
- Capture worker friction (sheet too long? items unclear? evidence requirement annoying?).
- Capture admin friction (four-eyes blocked legitimate review? reject reason too short?).
- Hardening PR follows if friction found (same shape as D.5-fix-1 + D.5-fix-2 + PR #26).

### Wider rollout
- Add 2–3 more templates (fit-off checks, switchboard checks, handover checks).
- Roll to 2–3 more tradies and one LH.
- After 4 weeks of clean operation, E2 RFI planning opens.

---

## 16 · Open founder decisions

Real decisions Oskar must answer before E1 build starts:

1. **Naming.** "ITP" (Inspection Test Plan — industry standard, but jargon), "QA Checklist" (clearer to staff), "Inspection" (clearest to clients), or "Hold Point" (compliance language)? **Recommended:** "Inspection" in the UI (clearest), "ITP" internally in code (industry standard).
2. **Can tradies submit, or only LH?** The legacy docs (doc 10) say "ITPCompletion (where licensed to)" — meaning licensed tradies submit, apprentices can mark ready-for-review but not submit. **Recommended for E1:** any field role on the assigned job can submit; admin/LH reviews. Defer the "licensed-to-submit" gate to E1.1 once we see real licensing data.
3. **Is evidence required per item or only for flagged items?** **Recommended:** per item, with `requiresPhoto: true` flag on the template item. Worker only forced to attach when the item demands it. Photo can be a previously-captured evidence row (no double-capture).
4. **Who can accept / reject?** Admin + LH (subject to four-eyes). Tradies cannot. **Recommended:** lock this in; no exceptions in E1.
5. **Should rejected items create a snag automatically?** **Recommended:** no in E1. The cross-domain side-effect adds complexity. Worker can raise a snag manually from the rejected ITP if needed. Re-evaluate at E1.1 once we see real reject patterns.
6. **Should ITP completion block stage completion?** **Recommended:** no in E1 (feature-flag default off). Add the gate in E1.1 with a per-job toggle. Don't lock workers out of completing stages on day one.
7. **Pilot job + tradie + admin.** **Recommended:** Birdwood IV3232 / `oskar` / `tom` (the same triple used throughout Phase D auth smoke).
8. **Template authoring — admin-side only in E1, or self-serve LH?** **Recommended:** admin-only in E1. LH self-serve is E1.1.
9. **Per-item rework (admin rejects items individually)?** **Recommended:** no in E1 — accept-whole / reject-whole-with-reason. Per-item rework is E1.1.
10. **Stage / area scope mandatory?** **Recommended:** stage mandatory, area optional. An ITP without a stage is too vague; an area constraint is sometimes useful (e.g. switchboard-room-only check) but often not (e.g. job-wide induction check).

---

## 17 · E1 build prompt

See [33-phase-e-build-prompts.md](33-phase-e-build-prompts.md).

## 18 · E1 QA prompt

See [33-phase-e-build-prompts.md](33-phase-e-build-prompts.md) (paired with the E1 prompt).

## 19 · Testing checklist

See [34-phase-e-testing-checklist.md](34-phase-e-testing-checklist.md).

---

## Cross-references

- [11-operational-workflow-map.md §15](11-operational-workflow-map.md) — ITP loop spec (binding business definition).
- [12-domain-model-deep-dive.md §"ITPTemplate" / §"ITPCompletion"](12-domain-model-deep-dive.md) — legacy data-model audit.
- [24-phase-d-jobs-evidence-plan.md §"Out of scope (deferred)"](24-phase-d-jobs-evidence-plan.md) — Phase E carve-out from Phase D.
- [27-interface-usability-pass.md §15 + §3](27-interface-usability-pass.md) — UI rules ITP must respect.
- [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md) — proven implementation pattern E1 mirrors.
- `api/snags.js` — proven API shape E1 mirrors.
- `api/_lib/auth.js` — role tiers E1 uses.
- `src/components/admin/SnagsQueue.tsx` + `SnagDrawer.tsx` + `SnagRejectModal.tsx` — proven admin patterns.
- `src/components/phil/JobSnagsPanel.tsx` + `ReportSnagSheet.tsx` — proven Phil patterns.
