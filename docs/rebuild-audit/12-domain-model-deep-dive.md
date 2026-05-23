# 12 · Domain model deep dive

> Defines the target domain model entity-by-entity, deeply enough that Phase A/B/C can be built without random UI-only objects appearing in components. Future Postgres/Prisma schema descends from these definitions.

---

## How to read this document

For each entity:

| Field | Meaning |
| --- | --- |
| **Purpose** | The one thing this entity exists for. |
| **Required fields** | Must be present at creation; reject otherwise. |
| **Optional fields** | May be added later. |
| **Relationships** | Foreign keys / containment. |
| **Status values** | The state machine, where applicable. |
| **Created by** | Who can create rows. |
| **Edited by** | Who can mutate rows. |
| **Approval / review** | Who signs off, if applicable. |
| **Audit** | What writes to `AuditLog`. |
| **Reporting value** | What downstream reports depend on this. |
| **Current repo** | Legacy storage path / endpoint / equivalent. |
| **Migration** | Can current data be brought forward? |
| **Recommendation** | Keep / rebuild / discard. |

---

## Universal field set

Every domain row should be able to link to:

- `id` — string (nanoid)
- `organisationId` — string (single tenant today; field present anyway)
- `createdBy` — `userId`
- `createdAt` — ISO timestamp
- `updatedBy` — `userId`
- `updatedAt` — ISO timestamp
- `auditLogIds` — string[] (back-references to mutation history)

Field-capture entities additionally link to:

- `jobId` — string
- `stageId` — string
- `areaId` — string (optional)
- `taskId` — string (optional)
- `workerId` — string
- `evidenceIds` — string[] (photos)
- `status` — enum (entity-specific)
- `reviewedBy` — `userId` (when applicable)

---

## Identity & access

### `Organisation`

| | |
| --- | --- |
| **Purpose** | Tenant boundary. Currently one row ("buhl electrical"). |
| **Required** | `id`, `name`, `slug` |
| **Optional** | `logoUrl`, `address`, `abn`, `defaultTimezone` |
| **Relationships** | parent of all other entities |
| **Status** | `active` (single value today) |
| **Created by** | system (seed) |
| **Edited by** | system / boss |
| **Audit** | rare; settings changes only |
| **Reporting** | scoping key for every report |
| **Current repo** | implicit; no `organisations.json` |
| **Migration** | seed at boot |
| **Recommendation** | **rebuild** — add the explicit row even though there's one tenant |

### `User`

| | |
| --- | --- |
| **Purpose** | A person who can log in. |
| **Required** | `id`, `email` *or* `username`, `passwordHash` *or* `pinHash`, `role` |
| **Optional** | `name`, `phone`, `defaultJobId`, `lastSeenAt` |
| **Relationships** | `organisationId`; 1:1 with `WorkerProfile` for field roles |
| **Status** | `active → inactive → archived` |
| **Created by** | admin |
| **Edited by** | admin (any field) / self (name, phone, password) |
| **Approval** | self password reset writes audit; admin role change writes audit |
| **Audit** | every role change, every status change, every password reset |
| **Reporting** | hours-by-worker, snags-by-worker, etc. |
| **Current repo** | `users.json` (Vercel Blob), `api/users.js`, `api/_lib/auth.js` HMAC session cookie |
| **Migration** | direct; cookie format stays the same per [00-executive-summary.md] |
| **Recommendation** | **keep** the table; **rebuild** the API client and admin UI |

### `WorkerProfile`

| | |
| --- | --- |
| **Purpose** | Field-specific facts about a worker (licence, rate, default crew). |
| **Required** | `userId`, `licenceClass`, `payRate` (or `payRateRef`) |
| **Optional** | `apprenticeYear`, `defaultCrewId`, `tagIds[]` |
| **Relationships** | 1:1 with `User`; references `Tag[]` |
| **Status** | inherits user status |
| **Created by** | admin |
| **Edited by** | admin |
| **Audit** | rate changes (always); licence changes (always) |
| **Reporting** | labour cost = hours × rate; licence compliance |
| **Current repo** | merged into `users.json` today |
| **Migration** | split out as profile during rebuild |
| **Recommendation** | **rebuild** as separate row; user-vs-profile separation cleans up admin UX |

### `Role`

| | |
| --- | --- |
| **Purpose** | The string carried on `User.role` for routing / gating. |
| **Required** | enum: `admin`, `boss`, `owner`, `manager`, `office`, `pm`, `estimator`, `leadinghand` (and aliases), `tradie`, `apprentice`, `labourer`, `electrician`, `client` |
| **Relationships** | 1:1 to permission set |
| **Recommendation** | **keep** as string enum to preserve cookie compatibility |

### `Permission`

| | |
| --- | --- |
| **Purpose** | Per-feature capabilities mapped from `Role`. |
| **Required** | `key` (e.g. `hours.approve`), `roles[]` |
| **Recommendation** | **rebuild** as a simple table in `src/lib/auth/permissions.ts`; no row in DB yet |

---

## Jobs domain

### `Job`

| | |
| --- | --- |
| **Purpose** | The unit of paid work. Centre of gravity for everything else. |
| **Required** | `id`, `name`, `clientId` *or* `clientName`, `status` |
| **Optional** | `address`, `quoteId`, `siteContactPhone`, `startDate`, `targetCompletionDate`, `modules[]` (switchboards, circuits, data, lighting...), `templateRef` |
| **Relationships** | `JobStage[]`, `JobArea[]`, `JobTask[]`, `JobAssignment[]`, `TimesheetEntry[]` (via allocations), `Photo[]`, `Defect[]`, `RFI[]`, `Variation[]`, `PlanDocument[]`, `ITPCompletion[]` |
| **Status** | `draft → active → on_hold → complete → archived` |
| **Created by** | PM / admin |
| **Edited by** | PM / admin |
| **Approval** | activation = PM action |
| **Audit** | every status change |
| **Reporting** | every job-aggregated number |
| **Current repo** | `jobs.json` index + `jobs/{id}/data.json` per-job blob; `api/jobs.js`, `api/job-*.js` (10+ endpoints) |
| **Migration** | direct read viable; full-doc writes need patch replacement |
| **Recommendation** | **keep schema, rebuild API contract** (patch endpoints instead of full-doc writes) |

### `JobStage`

| | |
| --- | --- |
| **Purpose** | Phases of work within a job (Rough-in, Fit-off, Commissioning, Handover). |
| **Required** | `id`, `jobId`, `name`, `order`, `status` |
| **Optional** | `templateId`, `targetDate`, `completedAt` |
| **Status** | `not_started → in_progress → complete` |
| **Created by** | PM (from template or manual) |
| **Edited by** | PM |
| **Audit** | status transitions |
| **Reporting** | cycle time per stage |
| **Current repo** | nested in `jobs/{id}/data.json.stages` |
| **Migration** | flatten to separate rows; keep the same names |
| **Recommendation** | **rebuild** as first-class row |

### `JobArea`

| | |
| --- | --- |
| **Purpose** | Physical zones (Kitchen, Master Bedroom, Garage, Switchboard). |
| **Required** | `id`, `jobId`, `name`, `order` |
| **Optional** | `stageScope[]` (which stages apply here), `area_m2`, `photoIds[]` |
| **Status** | `not_started → in_progress → complete` |
| **Created by** | PM |
| **Edited by** | PM |
| **Audit** | creation only |
| **Reporting** | per-area progress visualisation |
| **Current repo** | `jobs/{id}/data.json.areas`, `api/job-areas.js`, `api/area-detail.js` |
| **Migration** | flatten; same names |
| **Recommendation** | **rebuild** as first-class row |

### `JobTask`

| | |
| --- | --- |
| **Purpose** | A unit of work small enough for one worker to complete (1–8 hours typically). |
| **Required** | `id`, `jobId`, `stageId`, `areaId`, `name`, `status` |
| **Optional** | `assignedTo` (`userId`), `estimateHours`, `requirementIds[]`, `evidenceIds[]`, `parentTaskId` |
| **Status** | `pending → in_progress → done`; `blocked` is parallel with reason |
| **Created by** | PM (often from template) |
| **Edited by** | PM + assignee (status only) |
| **Audit** | status changes, assignment changes |
| **Reporting** | throughput, bottleneck identification |
| **Current repo** | nested in `jobs/{id}/data.json.tasks`; `api/task-toggle.js`, `api/_lib/job-tasks.js` |
| **Migration** | flatten |
| **Recommendation** | **rebuild** as first-class row |

### `TaskRequirement`

| | |
| --- | --- |
| **Purpose** | Pre-conditions for marking a task done (photo, ITP step, sign-off). |
| **Required** | `id`, `taskId`, `kind`, `description` |
| **Optional** | `templateRef` |
| **Status** | derived (`met` / `unmet`) |
| **Created by** | PM via template |
| **Edited by** | PM |
| **Audit** | met / unmet flips |
| **Reporting** | compliance proof |
| **Current repo** | partial in `jobs/{id}/data.json.tasks[].reqs` |
| **Migration** | promote to separate rows |
| **Recommendation** | **rebuild** |

---

## Hours domain

### `TimesheetEntry`

| | |
| --- | --- |
| **Purpose** | One worker's hours for one day. |
| **Required** | `id`, `date` (YYYY-MM-DD), `userId`, `totalHours`, `ordinaryHours`, `overtimeHours`, `allocations[]`, `status` |
| **Optional** | `notes`, `startTime`, `endTime`, `breakMinutes`, `submittedAt`, `approvedBy`, `approvedAt`, `rejectedAt`, `rejectionReason` |
| **`allocations[]` shape** | `{ id, jobId, hours, notes? }` — sum must equal `totalHours` |
| **Status** | `draft → submitted → approved` (or `rejected`, editable + resubmittable) |
| **Created by** | worker (own); admin (any) |
| **Edited by** | worker (own draft/rejected); admin (any) |
| **Approval** | admin always; LH for crew (excludes other LHs) per legacy rule |
| **Audit** | submit / approve / reject / edit-after-submit all write `AuditLog` |
| **Reporting** | labour cost per job, per worker, payroll export |
| **Current repo** | `users/{userId}/time-entries/{date}.json` + `users/{userId}/time-entries-audit/{yyyy-mm}.json`; `api/time-entries.js` + 9 sibling endpoints (approve, bulk-approve, bulk-reject, export, on-site, overview, recent-jobs, reject, reopen); `api/_lib/time-entries.js` |
| **Migration** | **direct keep**; this is the rebuild's reference schema |
| **Recommendation** | **keep** entirely (this is the only end-to-end loop in the legacy system that works); reuse exact storage + endpoints in Phase B |

### `TimesheetApproval`

| | |
| --- | --- |
| **Purpose** | Week-level rollup for payroll export. |
| **Required** | `id`, `weekStart` (Monday), `userId`, `status`, `totalHours`, `entryIds[]` |
| **Optional** | `exportedAt`, `exportedFileHash`, `notes` |
| **Status** | `pending → ready_for_export → exported` |
| **Created by** | admin (implicit at bulk-approve) |
| **Edited by** | admin |
| **Audit** | bulk-approve, export |
| **Reporting** | payroll reconciliation |
| **Current repo** | not explicit; derived from approved entries today |
| **Migration** | materialise at Phase B |
| **Recommendation** | **rebuild** as explicit row to support export tracking |

---

## Gear domain

### `GearAsset`

| | |
| --- | --- |
| **Purpose** | A physical tool / instrument / piece of equipment with an identity. |
| **Required** | `id`, `name`, `serial`, `category` |
| **Optional** | `qrCode`, `purchaseDate`, `replacementCost`, `tagIds[]`, `photoUrl` |
| **Relationships** | current `GearAssignment` |
| **Status** | `available → assigned → maintenance → retired` |
| **Created by** | admin |
| **Edited by** | admin |
| **Audit** | status changes |
| **Reporting** | utilisation, loss rate |
| **Current repo** | `api/assets.js`, `public/admin/assets.html` |
| **Migration** | direct |
| **Recommendation** | **rebuild** UI; keep storage |

### `GearAssignment`

| | |
| --- | --- |
| **Purpose** | Link between an asset and a worker (or depot). |
| **Required** | `id`, `assetId`, `holderType` (`worker` / `depot`), `holderId`, `assignedAt` |
| **Optional** | `returnDueAt`, `returnedAt`, `notes` |
| **Status** | `assigned → returned` (or `lost / damaged`) |
| **Created by** | admin (assignment) / worker (return scan) |
| **Edited by** | admin |
| **Audit** | each transition |
| **Reporting** | who has what at any moment |
| **Current repo** | partial in `assets.js` |
| **Migration** | promote to first-class |
| **Recommendation** | **rebuild** |

### `GearScan`

| | |
| --- | --- |
| **Purpose** | Append-only log of every check-out / check-in event. |
| **Required** | `id`, `assetId`, `actorId`, `kind` (`out` / `in`), `at` |
| **Optional** | `location`, `notes` |
| **Status** | n/a |
| **Created by** | worker (Phil) / admin (manual) |
| **Edited by** | none (append-only) |
| **Audit** | the entity *is* the audit trail |
| **Reporting** | asset whereabouts history |
| **Current repo** | new |
| **Recommendation** | **build new** in Phase C |

---

## Materials domain

### `MaterialItem`

| | |
| --- | --- |
| **Purpose** | Catalog entry for an orderable thing. |
| **Required** | `id`, `sku`, `name`, `category` |
| **Optional** | `unit`, `defaultSupplierId`, `unitCost` |
| **Recommendation** | **rebuild** in Phase E |

### `MaterialRequest`

| | |
| --- | --- |
| **Purpose** | A field-initiated need for materials. |
| **Required** | `id`, `jobId`, `requestedBy`, `lines[]` (each `{ itemId | freeform, qty }`), `status` |
| **Optional** | `urgency`, `requiredBy`, `orderId`, `deliveryId` |
| **Status** | `requested → ordered → delivered → consumed` |
| **Audit** | each transition |
| **Current repo** | partial (`api/materials-list.js`, `api/materials-summary.js`) |
| **Recommendation** | **rebuild** |

---

## Evidence & defects

### `Evidence`

| | |
| --- | --- |
| **Purpose** | Generic link between a piece of media (photo, note) and a domain entity. |
| **Required** | `id`, `kind` (`photo` / `note` / `doc`), `targetEntity`, `targetId` |
| **Optional** | `capturedBy`, `capturedAt`, `location`, `tags[]` |
| **Audit** | creation only |
| **Recommendation** | **build new** in Phase D |

### `Photo`

| | |
| --- | --- |
| **Purpose** | A captured image with EXIF metadata. |
| **Required** | `id`, `blobUrl`, `mimeType`, `capturedBy`, `capturedAt` |
| **Optional** | `width`, `height`, `gpsLat`, `gpsLng`, `evidenceIds[]` |
| **Audit** | capture only |
| **Current repo** | `api/photos.js`, `api/photos-catalog.js` |
| **Recommendation** | **rebuild** schema with explicit Evidence link |

### `Note`

| | |
| --- | --- |
| **Purpose** | A short text annotation attachable to entities. |
| **Required** | `id`, `body`, `targetEntity`, `targetId`, `authorId` |
| **Audit** | edit / delete |
| **Recommendation** | **build new** in Phase D |

---

## Documents & compliance

### `PlanDocument`

| | |
| --- | --- |
| **Purpose** | A logical drawing/spec (multiple revisions). |
| **Required** | `id`, `jobId`, `title`, `drawingNumber`, `kind` |
| **Optional** | `areaIds[]`, `stageIds[]`, `philReadiness` (`yes` / `no` / `pending`) |
| **Status** | `draft → active → superseded` |
| **Current repo** | `api/plans.js`, `public/admin/plans.html` v1 + v2 |
| **Recommendation** | **rebuild** UI; keep storage schema |

### `PlanRevision`

| | |
| --- | --- |
| **Purpose** | A specific version of a PlanDocument (Rev A, Rev B, ...). |
| **Required** | `id`, `documentId`, `revision`, `blobUrl`, `uploadedBy`, `uploadedAt` |
| **Optional** | `notes`, `supersedesId` |
| **Audit** | upload + supersede |
| **Current repo** | nested in plans data |
| **Recommendation** | **rebuild** as first-class |

### `PlanAcknowledgement`

| | |
| --- | --- |
| **Purpose** | Per-worker confirmation that they've seen a revision. |
| **Required** | `id`, `revisionId`, `userId`, `acknowledgedAt` |
| **Audit** | the row *is* the audit |
| **Recommendation** | **build new** in Phase E |

### `ITPTemplate`

| | |
| --- | --- |
| **Purpose** | Reusable checklist for inspection/test (per scope). |
| **Required** | `id`, `name`, `checkpoints[]` |
| **Optional** | `jobTypeRef` |
| **Current repo** | `api/itp-templates.js` |
| **Recommendation** | **rebuild** with proper schema |

### `ITPCheckpoint`

| | |
| --- | --- |
| **Purpose** | One item on an ITP. |
| **Required** | `id`, `templateId`, `description`, `order`, `severity` |
| **Optional** | `requiresPhoto`, `acceptanceCriteria` |
| **Recommendation** | **rebuild** |

### `ITPCompletion`

| | |
| --- | --- |
| **Purpose** | An instance of an ITP filled in for a stage. |
| **Required** | `id`, `templateId`, `jobId`, `stageId`, `submittedBy`, `responses[]`, `status` |
| **Optional** | `reviewedBy`, `reviewedAt`, `needsInfoReason` |
| **Status** | `in_progress → ready_for_review → approved` (or `needs_info`) |
| **Approval** | independent reviewer (cannot be `submittedBy`) |
| **Audit** | each transition |
| **Current repo** | `api/job-itps.js` |
| **Recommendation** | **rebuild** with stricter four-eyes enforcement |

---

## Operational events

### `RFI`

| | |
| --- | --- |
| **Purpose** | Request For Information against a design ambiguity. |
| **Required** | `id`, `jobId`, `raisedBy`, `body`, `status` |
| **Optional** | `areaId`, `attachmentIds[]`, `responseBody`, `responseAt`, `closedAt` |
| **Status** | `open → awaiting_response → answered → closed` |
| **Current repo** | none (new domain) |
| **Recommendation** | **build new** in Phase E |

### `Defect` (snag)

| | |
| --- | --- |
| **Purpose** | A reported flaw needing remediation. |
| **Required** | `id`, `jobId`, `raisedBy`, `description`, `status`, `priority` |
| **Optional** | `areaId`, `assignedTo`, `evidenceIds[]`, `closedAt`, `closeReason` |
| **Status** | `open → assigned → in_progress → fixed → verified → closed` (or `wont_fix`) |
| **Current repo** | extensive: `api/snags-all.js`, `snag-quick-raise.js`, `snag-quick-close.js`, etc. |
| **Recommendation** | **rebuild** schema; keep notification cron logic |

### `Variation`

| | |
| --- | --- |
| **Purpose** | Scope/price change captured for the client. |
| **Required** | `id`, `jobId`, `createdBy`, `description`, `lines[]`, `status` |
| **Optional** | `clientAcceptedAt`, `invoicedAt`, `invoiceRef` |
| **Status** | `draft → sent → accepted / rejected → invoiced` |
| **Current repo** | `public/admin/variations.html` + (work in `backend/admin-tools-hardening-pass-1` branch) |
| **Recommendation** | **rebuild** |

### `Alert`

| | |
| --- | --- |
| **Purpose** | Cross-cutting notification raised by crons / mutation triggers. |
| **Required** | `id`, `kind`, `body`, `targetEntity`, `targetId`, `severity`, `status` |
| **Optional** | `acknowledgedBy`, `acknowledgedAt` |
| **Current repo** | implicit via notifications cron (`api/cash-watch.js`, `api/notifications.js`) |
| **Recommendation** | **rebuild** as first-class row |

### `AuditLog`

| | |
| --- | --- |
| **Purpose** | Immutable log of every mutation in the system. |
| **Required** | `id`, `actorId`, `action`, `targetEntity`, `targetId`, `at` |
| **Optional** | `before`, `after`, `reason`, `metadata` |
| **Created by** | every mutation API |
| **Edited by** | nobody (append-only) |
| **Reporting** | "who did what when" for legal / compliance / debugging |
| **Current repo** | per-domain audit logs (e.g. `users/{userId}/time-entries-audit/{yyyy-mm}.json`); no unified table |
| **Recommendation** | **build new** unified `AuditLog` table in Phase D when first mutation domain ships; consolidate per-domain logs into it in Phase E |

### `IntegrationEvent`

| | |
| --- | --- |
| **Purpose** | Record of an outbound call (Xero push, CSV export, AI inference). |
| **Required** | `id`, `kind`, `actorId`, `at`, `outcome` |
| **Optional** | `payloadHash`, `responseHash`, `costUsd`, `latencyMs` |
| **Reporting** | spend tracking, error rates |
| **Current repo** | none |
| **Recommendation** | **build new** in Phase F when integrations land |

---

## Per-phase minimum models

### Phase A — Foundation (no domain code required)

Phase A renders empty shells. The only schema it needs is:

- `User` (decoded session cookie, shape-checked)
- `Role` (enum)

No DB writes, no fixtures beyond compile-time placeholders.

### Phase B — Hours

Minimum:

- `User` + `WorkerProfile` (existing storage)
- `Job` (read-only; legacy storage)
- `TimesheetEntry` + `allocations[]` (existing storage; reused exactly as-is)
- `TimesheetApproval` (materialised at bulk-approve time)
- `AuditLog` minimum: submit / approve / reject events

### Phase C — Gear

Add:

- `GearAsset` (legacy storage)
- `GearAssignment` (promote from inline)
- `GearScan` (new)

### Phase D — Jobs & evidence

Add:

- `JobStage`, `JobArea`, `JobTask` (promote from inline)
- `Photo`, `Evidence`, `Note`
- `Defect` (rebuild schema)
- `AuditLog` (unified)

### Phase E — ITP / RFI / materials / plans / variations

Add the remaining entities. Build all four loops in parallel feature streams within Phase E.

### Phase F+ — Integrations / intelligence

Add `IntegrationEvent`, `Alert`, reporting materialised views.

---

## Fields that must NOT be skipped

The following fields exist for good reasons learned the hard way; never drop them:

- `auditLogIds` on every entity that mutates (Phase D+ entities).
- `createdBy` + `updatedBy` on every row.
- `status` on every entity with a lifecycle.
- `reviewedBy` on any entity that has an approval step (ITPCompletion, Variation, TimesheetEntry, PlanRevision).
- `evidenceIds[]` on any entity where field workers can attach photos (Defect, JobTask, ITPCompletion, MaterialRequest, RFI).
- `jobId` on every operational row (everything except User / Organisation / Tag / catalog rows).

---

## Future Postgres / Drizzle shape

When the rebuild moves off Vercel Blob:

- One schema per domain, mirrored on `src/domains/<domain>/schema.ts`.
- Audit log as a single table with polymorphic target (`targetEntity` + `targetId`).
- Soft-delete via `archivedAt` rather than hard-delete; honor in queries.
- Indices: every foreign key, `(jobId, status)`, `(userId, date)` for hours queries.
- Migrations: Drizzle preferred (TS-first); Prisma acceptable.
- Multi-tenant readiness: `organisationId` on every row from day one.

---

## Mock data rules

While the rebuild has fixtures (Phase A–D), the following rules apply:

- Fixtures live in `src/domains/<domain>/fixtures.ts`. Never in components.
- Whenever any fixture is rendered, `DemoModeBanner` is visible at shell level.
- `fixtures.isDemoMode()` returns true; flipping a per-domain `live` flag turns the banner off.
- The legacy `window.BUHLOS_MOCK` mechanism (silent fallback on empty API) is **banned** in the new app.
- Fixtures must be type-checked against the domain schema (compile-time, not runtime).

---

## Cross-references

- [10-product-definition.md](10-product-definition.md) — who creates / consumes these entities.
- [11-operational-workflow-map.md](11-operational-workflow-map.md) — which workflows touch which entities.
- [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md) — where the schemas live.
- [03-data-model-audit.md](03-data-model-audit.md) — Phase 1A field-by-field audit of the legacy.
