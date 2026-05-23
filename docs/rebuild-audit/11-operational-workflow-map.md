# 11 · Operational workflow map

> The real electrical/construction workflows the system must support. Every workflow is described as a *closed loop* between Phil (field) and BuhlOS Admin (office) with a defined data tail, audit trail, and reporting upside. Coding agents should not invent workflows that aren't here without an audit update.

---

## How to read this document

For each workflow:

| Field | Meaning |
| --- | --- |
| **Trigger** | The real-world event that starts the loop. |
| **Phil action** | What the field worker does. |
| **Admin action** | What the office user does. |
| **Data created** | The entities and records produced. |
| **Status lifecycle** | The state machine of the primary entity. |
| **Approval / review** | Who signs off and how. |
| **Audit** | What must be written to `AuditLog`. |
| **Future intelligence** | The reporting / learning value once data accumulates. |
| **Current legacy** | What the existing `public/*.html` + `api/*.js` does (if anything). |
| **Rebuild phase** | When this workflow is built in the rebuild roadmap. |

**Phase legend:**

- **A** Foundation (no workflows)
- **B** Hours
- **C** Gear
- **D** Jobs & evidence
- **E** ITP / RFI / materials
- **F** Reporting / integrations / intelligence

---

## MVP loops (Phase B–D)

### 1. Daily hours capture

| | |
| --- | --- |
| **Trigger** | End of work day; tradie ready to knock off. |
| **Phil action** | Open My Day → tap **Standard day (7h 36m)** OR enter custom hours, pick job(s), submit. |
| **Admin action** | Reviews submitted entries in Hours queue; approves or rejects with reason. |
| **Data created** | `TimesheetEntry` (one per user per day, with allocations[] across jobs) |
| **Status lifecycle** | `draft → submitted → approved` *(or `rejected`, can be edited and resubmitted)* |
| **Approval** | Admin (always). LH may approve their crew's entries excluding other LHs (legacy supports; rebuild reuses). |
| **Audit** | Submit, approve, reject, edit-after-submit each writes an `AuditLog` event. |
| **Future intelligence** | Per-worker fatigue trends. Per-job labour actuals vs estimate. Job-cost trueing. |
| **Current legacy** | `api/time-entries.js` + 9 siblings; `public/my-day.html` for capture; `public/admin/hours.html` + `public/admin/approvals.html` for approval. **The only end-to-end loop today.** |
| **Rebuild phase** | **B** (first real feature loop). |

### 2. Weekly timesheet roll-up + approval

| | |
| --- | --- |
| **Trigger** | Monday morning before payroll cutoff. |
| **Phil action** | None (the entries are already submitted). |
| **Admin action** | Bulk-approve / bulk-reject pending week. Spot edits where allowed. Mark week ready for export. |
| **Data created** | `TimesheetApproval` (a per-week per-worker rollup) + `AuditLog` entries. |
| **Status lifecycle** | week is `pending → ready_for_export → exported` |
| **Approval** | Admin only. |
| **Audit** | Bulk-approve action recorded with the list of entry IDs. |
| **Future intelligence** | Approval turnaround time. % of weeks needing rejection. |
| **Current legacy** | `api/time-entries-bulk-approve.js`, `api/time-entries-bulk-reject.js`, `api/time-entries-overview.js`. |
| **Rebuild phase** | **B** (immediately after #1). |

### 3. CSV / payroll export

| | |
| --- | --- |
| **Trigger** | Admin clicks Export on an approved week. |
| **Phil action** | None. |
| **Admin action** | Download CSV. Mark week exported. |
| **Data created** | `IntegrationEvent` recording the export with file hash + recipient. |
| **Status lifecycle** | Week becomes `exported`. |
| **Approval** | N/A (the export itself is the consequence of approval). |
| **Audit** | Export event with row count + file hash. |
| **Future intelligence** | Discrepancy detection between exported hours and payroll system numbers. |
| **Current legacy** | `api/time-entries-export.js` exists. |
| **Rebuild phase** | **B**. |

### 4. Job costing snapshot (read-only)

| | |
| --- | --- |
| **Trigger** | Admin opens a job's Hours tab. |
| **Phil action** | None. |
| **Admin action** | Views job actuals: hours by stage, hours by worker, total cost (rate × hours), variance against estimate. |
| **Data created** | None (read-only aggregation). |
| **Status lifecycle** | N/A. |
| **Approval** | N/A. |
| **Audit** | N/A. |
| **Future intelligence** | Foundation for #28 (business learning). |
| **Current legacy** | `api/job-glance.js`, `api/hot-areas.js` partial coverage. |
| **Rebuild phase** | **B** (the closing read on the hours loop). |

### 5. Gear assignment

| | |
| --- | --- |
| **Trigger** | Admin assigns a gear asset (tool, drill, meter) to a worker. |
| **Phil action** | Receives notification; sees gear in My Gear. |
| **Admin action** | Pick worker → pick asset → assign. Optional return date. |
| **Data created** | `GearAssignment` linking `GearAsset` → `WorkerProfile`. |
| **Status lifecycle** | `assigned → returned → lost / damaged` |
| **Approval** | N/A; assignment is the action. |
| **Audit** | Every assignment / return / change writes `AuditLog`. |
| **Future intelligence** | Asset utilisation. Loss/damage rates per worker. |
| **Current legacy** | `api/assets.js`, `public/admin/assets.html`. Phil partial in `public/my-gear.html`. |
| **Rebuild phase** | **C**. |

### 6. Gear check-out / check-in (worker-initiated)

| | |
| --- | --- |
| **Trigger** | Worker borrows a tool from the van / depot. |
| **Phil action** | Scan QR / pick from list → confirm. To return: same. |
| **Admin action** | Sees current holders in real time. |
| **Data created** | `GearScan` (timestamped, with worker + asset). Updates `GearAssignment.currentHolder`. |
| **Status lifecycle** | Asset is `with worker X` or `at depot`. |
| **Approval** | N/A. |
| **Audit** | Each scan logged. |
| **Future intelligence** | Asset whereabouts at any moment. Disputes resolved by scan history. |
| **Current legacy** | None — scan flow is new. |
| **Rebuild phase** | **C**. |

### 7. Job creation

| | |
| --- | --- |
| **Trigger** | Quote accepted; PM wants to set up a new job. |
| **Phil action** | None. |
| **Admin action** | Job Builder: name, client, address, scope modules (switchboards / circuits / data / lighting...), default stages and areas. |
| **Data created** | `Job` + `JobStage[]` + `JobArea[]` + initial `JobTask[]`. |
| **Status lifecycle** | `draft → active → on_hold → complete → archived` |
| **Approval** | Admin / PM creates; activates when client confirmed. |
| **Audit** | Job creation + each status change. |
| **Future intelligence** | Time-from-quote-to-active. Template reuse rate. |
| **Current legacy** | `public/admin/job-builder.html`, `api/job-draft.js`, `api/jobs.js`. Heavy logic in `public/admin/job.html` (4,772 lines). |
| **Rebuild phase** | **D**. |

### 8. Quote / estimate connection

| | |
| --- | --- |
| **Trigger** | Estimator wins a quote; converts it to a job. |
| **Phil action** | None. |
| **Admin action** | From Quote: "Convert to job" → seeds Job Builder with quote scope and pricing. |
| **Data created** | `Job` linked to source `Quote` via `quoteId`. Quote becomes `won`. |
| **Status lifecycle** | Quote: `draft → sent → won / lost`. |
| **Approval** | N/A. |
| **Audit** | Conversion event records quote ID + total + variance. |
| **Future intelligence** | Win rate by client / scope / estimator. Quote accuracy vs job actuals. |
| **Current legacy** | `api/quotes.js`, `public/admin/quotes.html`, `public/admin/quote.html`. |
| **Rebuild phase** | **E+** (separated from job creation initially). |

### 9. Worker assignment to a job

| | |
| --- | --- |
| **Trigger** | PM schedules a crew for a job/week. |
| **Phil action** | Receives notification; job appears in Phil. |
| **Admin action** | Crew planner: assign workers to jobs by day or week. |
| **Data created** | `JobAssignment` (worker × job × date range). |
| **Status lifecycle** | `assigned → confirmed → completed` |
| **Approval** | N/A; PM owns. |
| **Audit** | Each assignment / change. |
| **Future intelligence** | Utilisation by worker. Crew composition patterns. |
| **Current legacy** | `public/admin/crew.html`, `api/crew.js`, `api/crew-utilization.js`. |
| **Rebuild phase** | **D**. |

### 10. Task completion (Phil)

| | |
| --- | --- |
| **Trigger** | Worker finishes a task on their current area. |
| **Phil action** | Tap task → confirm complete; optionally attach photo. |
| **Admin action** | Sees task closed; rolls up to area / stage % done. |
| **Data created** | `JobTask.status = done`, optional `Evidence` (photo + note). |
| **Status lifecycle** | `pending → in_progress → done` (`blocked → blocked_with_reason`) |
| **Approval** | None for routine; ITP tasks have separate sign-off (see #15). |
| **Audit** | Completion writes the actor + timestamp. |
| **Future intelligence** | Throughput per stage. Bottleneck identification. |
| **Current legacy** | `api/task-toggle.js`, partial in `public/phil.html`. |
| **Rebuild phase** | **D**. |

### 11. Photo / evidence capture

| | |
| --- | --- |
| **Trigger** | Worker needs to record proof of work, condition, defect, before/after. |
| **Phil action** | Tap camera → take photo → tag job/stage/area/task → optional note → submit. |
| **Admin action** | Sees photos in job timeline; can attach to snags / variations. |
| **Data created** | `Photo` + `Evidence` linking it to entity. |
| **Status lifecycle** | `captured → processed → archived` |
| **Approval** | N/A. |
| **Audit** | Capture event with EXIF location if available. |
| **Future intelligence** | Time-on-site verification. Job progress timelines. Variation evidence. |
| **Current legacy** | `api/photos.js`, `api/photos-catalog.js`. |
| **Rebuild phase** | **D**. |

### 12. Snag / defect lifecycle

| | |
| --- | --- |
| **Trigger** | Worker finds a defect (or admin gets a client complaint). |
| **Phil action** | Tap Raise Snag → pick area → describe → optional photo → submit. |
| **Admin action** | Snag queue: triage, assign to worker, set priority, close when fixed. |
| **Data created** | `Defect` linked to job/area + `Evidence`. |
| **Status lifecycle** | `open → assigned → in_progress → fixed → verified → closed` (or `wont_fix`). |
| **Approval** | PM closes verified snags. |
| **Audit** | Every status transition. |
| **Future intelligence** | Defect rate per worker / per job type. Recurrence patterns. |
| **Current legacy** | Extensive: `api/snags-all.js`, `snag-quick-raise.js`, `snag-quick-close.js`, `snags-bulk-close.js`, `snag-stats.js`, `snag-notify.js`, `snag-duplicates.js`, `snag-email.js`. `public/admin/snags.html`, `public/admin/approvals.html`. |
| **Rebuild phase** | **D**. |

---

## Secondary loops (Phase E)

### 13. Material request

| | |
| --- | --- |
| **Trigger** | Worker needs material on site; admin needs to order. |
| **Phil action** | Tap Request Material → pick item from catalog (or freeform) → qty → submit. |
| **Admin action** | Combines requests across jobs; raises supplier orders. |
| **Data created** | `MaterialRequest` → may roll into supplier `Order`. |
| **Status lifecycle** | `requested → ordered → delivered → consumed` |
| **Approval** | Admin / PM gates large orders. |
| **Audit** | Each transition. |
| **Future intelligence** | Material spend per job. Stockout patterns. |
| **Current legacy** | `api/materials-list.js`, `api/materials-summary.js`, `public/admin/materials.html`. Phil request flow doesn't exist. |
| **Rebuild phase** | **E**. |

### 14. Material delivery tracking

| | |
| --- | --- |
| **Trigger** | Goods arrive on site. |
| **Phil action** | Confirm delivery → optional photo of pallet / packing slip. |
| **Admin action** | Reconciles delivery against order; flags shortfalls. |
| **Data created** | `MaterialDelivery` linked to request. |
| **Status lifecycle** | `expected → delivered → reconciled → discrepancy_open / closed` |
| **Approval** | Admin reconciles. |
| **Audit** | Delivery + reconciliation events. |
| **Future intelligence** | Supplier reliability. |
| **Current legacy** | Partial; primarily admin-side. |
| **Rebuild phase** | **E**. |

### 15. ITP / QA completion + independent sign-off

| | |
| --- | --- |
| **Trigger** | Stage reaches an ITP gate (rough-in done, fit-off done, etc.). |
| **Phil action** | Open ITP → tick checkpoints (with photos where required) → submit for review. |
| **Admin action** | Reviewer (different licensed person — the "four-eyes" rule) approves / requests more info. |
| **Data created** | `ITPCompletion` linked to `ITPTemplate` + `JobStage`. |
| **Status lifecycle** | `in_progress → ready_for_review → approved / needs_info` |
| **Approval** | Independent reviewer (cannot be the submitter). |
| **Audit** | Submission, each review action, sign-off. |
| **Future intelligence** | Compliance proof for clients / regulators. Rework rate. |
| **Current legacy** | `api/itp-templates.js`, `api/job-itps.js`, `public/admin/itp.html`. v1 + v2 present. |
| **Rebuild phase** | **E**. |

### 16. Plan / document upload

| | |
| --- | --- |
| **Trigger** | PM receives new plans from architect / client. |
| **Phil action** | None (admin-side upload). |
| **Admin action** | Upload PDF → tag job/stage/area → mark active. |
| **Data created** | `PlanDocument` + first `PlanRevision`. |
| **Status lifecycle** | `draft → active → superseded` |
| **Approval** | Admin publishes; this revokes prior revisions for that document. |
| **Audit** | Upload + publish events. |
| **Future intelligence** | Plan-revision frequency (proxy for client design churn). |
| **Current legacy** | `api/plans.js`, `public/admin/plans.html`. v1 + v2. |
| **Rebuild phase** | **E**. |

### 17. Plan revision / versioning

| | |
| --- | --- |
| **Trigger** | Architect issues a Rev B of an existing drawing. |
| **Phil action** | Receives notification of new revision. |
| **Admin action** | Upload as revision of existing `PlanDocument`. |
| **Data created** | `PlanRevision` (Rev letter + date + uploader). Previous revision auto-superseded. |
| **Status lifecycle** | Same as #16. |
| **Approval** | Admin. |
| **Audit** | Each revision is one event. |
| **Future intelligence** | Build vs current-revision detection. |
| **Current legacy** | Plans v2 supports. |
| **Rebuild phase** | **E**. |

### 18. Plan acknowledgement

| | |
| --- | --- |
| **Trigger** | Worker arrives on site and a new revision exists they haven't seen. |
| **Phil action** | Phil shows blocking modal: "Acknowledge Rev B before continuing". Worker reads, taps acknowledge. |
| **Admin action** | Sees who has acknowledged each revision. |
| **Data created** | `PlanAcknowledgement` per worker per revision. |
| **Status lifecycle** | per worker: `unread → acknowledged` |
| **Approval** | N/A. |
| **Audit** | Each acknowledgement. |
| **Future intelligence** | Compliance / litigation defence. |
| **Current legacy** | Not implemented end-to-end. |
| **Rebuild phase** | **E**. |

### 19. Job stages

| | |
| --- | --- |
| **Trigger** | Job setup. |
| **Phil action** | Sees stages in nav. |
| **Admin action** | Defines stages per job (Rough-in, Fit-off, Commissioning, Handover). Templated from job type. |
| **Data created** | `JobStage[]`. |
| **Status lifecycle** | `not_started → in_progress → complete` |
| **Approval** | Stage closure rolled up from task closure (with PM override). |
| **Audit** | Stage open/close events. |
| **Future intelligence** | Cycle time per stage. |
| **Current legacy** | `api/job-areas.js` partial; `public/admin/job.html`. |
| **Rebuild phase** | **D**. |

### 20. Areas / zones

| | |
| --- | --- |
| **Trigger** | Job structure setup. |
| **Phil action** | Selects area when capturing photo / completing task. |
| **Admin action** | Defines areas per job (Kitchen, Master Bedroom, Garage, Switchboard...). |
| **Data created** | `JobArea[]`. |
| **Status lifecycle** | `not_started → in_progress → complete` |
| **Approval** | N/A. |
| **Audit** | Creation only. |
| **Future intelligence** | Area-level progress visualisation. |
| **Current legacy** | `api/area-detail.js`. |
| **Rebuild phase** | **D**. |

### 21. RFI

| | |
| --- | --- |
| **Trigger** | Worker can't proceed without a design clarification. |
| **Phil action** | Raise RFI → describe → attach photo → send. |
| **Admin action** | PM forwards to architect / client; logs response; closes. |
| **Data created** | `RFI` + thread of `RFIResponse[]`. |
| **Status lifecycle** | `open → awaiting_response → answered → closed` |
| **Approval** | N/A; PM closes when satisfied. |
| **Audit** | Each transition. |
| **Future intelligence** | RFI frequency per architect — proxy for plan quality. |
| **Current legacy** | Not implemented (new domain). |
| **Rebuild phase** | **E**. |

### 22. Variation / unplanned work

| | |
| --- | --- |
| **Trigger** | PM realises scope has changed during the job. |
| **Phil action** | Worker can flag potential variation from Phil → goes to PM queue. |
| **Admin action** | PM creates variation, prices it, sends to client; client accepts/rejects. |
| **Data created** | `Variation` linked to job, with line items. |
| **Status lifecycle** | `draft → sent → accepted / rejected → invoiced` |
| **Approval** | Client accepts (Phase F+); admin invoices. |
| **Audit** | Each transition. |
| **Future intelligence** | Variation revenue per job. Estimator quote-accuracy feedback. |
| **Current legacy** | `api/variations` (implied by `backend/admin-tools-hardening-pass-1` branch). `public/admin/variations.html` exists. |
| **Rebuild phase** | **E**. |

### 23. Handover readiness

| | |
| --- | --- |
| **Trigger** | All stages of a job report complete. |
| **Phil action** | None (rolled up from stage closure). |
| **Admin action** | Handover checklist: all ITPs approved, all snags closed, all plans current, all hours approved. |
| **Data created** | `HandoverReadiness` snapshot per job. |
| **Status lifecycle** | `incomplete → ready → handed_over` |
| **Approval** | PM / boss signs off. |
| **Audit** | Snapshot at sign-off. |
| **Future intelligence** | Time-to-handover trend. |
| **Current legacy** | `api/handover-readiness.js` exists. |
| **Rebuild phase** | **E**. |

---

## Tertiary loops (Phase F+)

### 24. Xero / payroll integration

| | |
| --- | --- |
| **Trigger** | Approved week ready. |
| **Phil action** | None. |
| **Admin action** | Push to Xero (or download Xero-compatible CSV). |
| **Data created** | `IntegrationEvent` records the push. |
| **Status lifecycle** | Week becomes `synced_to_xero`. |
| **Approval** | Admin. |
| **Audit** | Push event with row count + Xero batch ID. |
| **Future intelligence** | Reconciliation. |
| **Current legacy** | None. |
| **Rebuild phase** | **F+** (deliberately deferred until hours loop is stable for weeks). |

### 25. Reporting / business intelligence

| | |
| --- | --- |
| **Trigger** | Boss / admin reviews business health. |
| **Phil action** | None. |
| **Admin action** | Open Reports → pick report → filter. |
| **Data created** | None (aggregations). |
| **Status lifecycle** | N/A. |
| **Approval** | N/A. |
| **Audit** | View events optional. |
| **Future intelligence** | This *is* the intelligence layer. |
| **Current legacy** | `public/admin/reports.html` partial, mostly UC. |
| **Rebuild phase** | **F**. |

### 26. Business learning / quote improvement

| | |
| --- | --- |
| **Trigger** | New quote being estimated for similar job to past work. |
| **Phil action** | None. |
| **Admin action** | Quote draft shows similar past jobs' actuals (hours, materials, profit margin). Estimator uses to calibrate. |
| **Data created** | `QuoteCalibration` snapshot per quote. |
| **Status lifecycle** | N/A. |
| **Approval** | N/A. |
| **Audit** | Snapshot at quote-sent. |
| **Future intelligence** | Estimator accuracy improves over time. |
| **Current legacy** | None. |
| **Rebuild phase** | **F+**. |

### 27. Cash watch / overrun detection

| | |
| --- | --- |
| **Trigger** | Cron at 22:30 daily. |
| **Phil action** | None. |
| **Admin action** | Receives alert if any job's labour cost exceeds threshold % of estimate. |
| **Data created** | `Alert` rows. |
| **Status lifecycle** | `raised → acknowledged → resolved` |
| **Approval** | Admin acknowledges. |
| **Audit** | Alert lifecycle. |
| **Future intelligence** | Early warning for losing jobs. |
| **Current legacy** | `api/cash-watch.js` exists (cron). |
| **Rebuild phase** | **F+**. |

### 28. AI plan interpretation (assisted estimating)

| | |
| --- | --- |
| **Trigger** | Estimator uploads plans during quote prep. |
| **Phil action** | None. |
| **Admin action** | Reviews AI-extracted scope items (circuits, GPOs, lights) against the plan. Accepts / corrects. |
| **Data created** | `PlanInterpretation` + `QuoteScopeSuggestion[]`. |
| **Status lifecycle** | `processing → suggested → estimator_accepted` |
| **Approval** | Estimator owns the final scope. |
| **Audit** | AI cost (tokens × $/Mtok) per request. |
| **Future intelligence** | Estimating speed and consistency. |
| **Current legacy** | `api/plans.js` integrates Anthropic SDK (`ANTHROPIC_API_KEY`, `PLANS_AI_MODEL`, `PLANS_AI_*_USD_PER_MTOK`, `PLANS_MAX_USD_PER_JOB`). |
| **Rebuild phase** | **F+** (existing infra retained; rebuild defers UI rebuild). |

---

## Workflow tiers

### MVP — Phase B–D (must ship)

1, 2, 3, 4 (hours pipeline). 5, 6 (gear). 7, 9, 10, 11, 12, 19, 20 (jobs + evidence).

### Secondary — Phase E

8, 13, 14, 15, 16, 17, 18, 21, 22, 23.

### Tertiary — Phase F+

24, 25, 26, 27, 28.

### Do NOT build until the data model exists

- Reporting (#25), business learning (#26), cash watch (#27), AI plan interpretation (#28) all aggregate over many entities. They cannot be built on placeholder data — they will produce false signal that damages trust. Wait for the underlying loops to be live and stable for at least one billing cycle (~4 weeks) before flipping them on with real data.
- Subcontractor and client portal surfaces require the entity structures from #22 (variations), #18 (plan acknowledgement), and #23 (handover) to be solid.

---

## Cross-references

- [10-product-definition.md](10-product-definition.md) — who the users are and what surfaces they use.
- [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) — the entities each workflow operates on.
- [13-ui-information-architecture.md](13-ui-information-architecture.md) — how these workflows map to nav and screens.
- [16-migration-strategy.md](16-migration-strategy.md) — phase ordering for these workflows.
- [../product/00-core-operational-loops.md](../product/00-core-operational-loops.md) — Phase 1A loops document (lighter; this supersedes for the rebuild).
