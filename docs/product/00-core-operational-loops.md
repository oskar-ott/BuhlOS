# 00 · Core operational loops

The five loops that the rebuild must support end-to-end. Each loop has the same shape: **field captures → admin reviews → admin acts → record attaches → audit log writes → reporting updates.** The hours loop is the reference implementation; the other four follow its template.

A "loop" is closed only when **every step has a real owner and a real artefact**. Mock-up screens that look like the loop but don't actually move data do not count.

---

## Loop 1 — Hours

The first end-to-end loop. Per [[project_buhlos_phil_hours_pipeline]] this is the canonical reference for every other loop.

```
┌─ Phil (worker) ─────────────────────────────────────┐
│  1. Worker opens /phil/my-day                        │
│  2. Worker taps "Standard day (7h 36m)" OR custom    │
│  3. (optional) Worker types notes                    │
│  4. Worker taps "Submit"                              │
│      ↓ POST /api/time-entries                        │
└──────────────────────────────────────────────────────┘
                       │
┌─ BuhlOS Admin (approver) ───────────────────────────┐
│  5. Admin opens /hours/approvals                     │
│  6. Admin sees Pending queue with worker + date      │
│  7. Admin clicks row → side panel: hours, notes,     │
│     job context, day-of-week, comparison-to-norm     │
│  8. Admin clicks "Approve" OR "Reject + reason"      │
│      ↓ POST /api/time-entries-approve|reject         │
└──────────────────────────────────────────────────────┘
                       │
┌─ System ────────────────────────────────────────────┐
│  9. TimesheetApproval record created                 │
│     { approver, action, timestamp, reason? }         │
│ 10. AuditLog event: actor approved entry X          │
│ 11. Job.labourActuals updated (running total)       │
│ 12. Worker sees status update in /phil/hours        │
└──────────────────────────────────────────────────────┘
                       │
┌─ Reporting ─────────────────────────────────────────┐
│ 13. /reports rolls up approved hours per job/period  │
│ 14. /hours dashboard shows pending vs approved KPIs  │
│ 15. Cron: weekly-report includes hours roll-up       │
└──────────────────────────────────────────────────────┘
```

### Required entities

- `TimesheetEntry { id, userId, jobId, date, hours, type, notes, status, createdAt }`
- `TimesheetApproval { id, entryId, approverId, action: 'approved'|'rejected', reason?, timestamp }`
- `AuditLog { id, actor, action, target, timestamp, before?, after? }`

### Constraints

- **Standard-day = 7h 36m (decimal 7.6).** One-tap submission. Per [[project_buhlos_phil_hours_pipeline]].
- **Job context** — every entry must attach to a JobStage (and ideally a JobArea / JobTask).
- **No deletion** of approved entries — adjustments are new entries that reference the original.
- **Independent approver** — a worker cannot approve their own hours; rule enforced server-side.

### Acceptance

This loop is closed when:
1. A worker on Phil can submit a standard day in one tap.
2. The admin sees it in the approval queue within 5 seconds.
3. An approval / rejection writes an AuditLog event.
4. The worker sees the status update on their next /phil/hours load.
5. The reporting view shows the approved hours under the right job.
6. A Playwright E2E test walks all six steps without intervention.

---

## Loop 2 — Gear

Field-side gear assignment and accountability.

```
┌─ Admin assigns ─────────────────────────────────────┐
│  1. Admin opens /gear                                │
│  2. Admin selects an asset → "Assign to worker"      │
│  3. Admin picks worker + expected return date        │
│      ↓ POST /api/gear-assignments                    │
└──────────────────────────────────────────────────────┘
                       │
┌─ Phil (worker) ─────────────────────────────────────┐
│  4. Worker opens /phil/gear                          │
│  5. Worker sees the newly-assigned asset             │
│  6. Worker (optionally) scans the QR on the asset    │
│     to confirm receipt → GearScan record             │
└──────────────────────────────────────────────────────┘
                       │
┌─ Field use ─────────────────────────────────────────┐
│  7. Worker scans asset on / off site / vehicle       │
│  8. Each scan writes a GearScan record               │
│      ↓ POST /api/gear-scans                          │
└──────────────────────────────────────────────────────┘
                       │
┌─ Return / hand-off ─────────────────────────────────┐
│  9. Worker scans the "return" QR (yard / van)        │
│ 10. Or hands off to another worker via QR scan       │
│ 11. GearAssignment closes; new GearAssignment opens  │
└──────────────────────────────────────────────────────┘
                       │
┌─ Admin sees ────────────────────────────────────────┐
│ 12. /gear/:id shows current holder + scan history    │
│ 13. /gear lists overdue assets (expectedReturn < today) │
│ 14. /command-centre KPI: "Overdue gear: N"          │
│ 15. Daily-digest cron flags overdue assignments     │
└──────────────────────────────────────────────────────┘
```

### Required entities

- `GearAsset { id, name, kind, calibrationDue?, archived }`
- `GearAssignment { id, assetId, holderId, assignedAt, assignedBy, expectedReturn, returnedAt?, returnedTo? }`
- `GearScan { id, assetId, scannerId, location?, action: 'pickup'|'return'|'transfer', timestamp }`
- `AuditLog` rows for assign + return events.

### Constraints

- **One open assignment per asset.** Re-assigning auto-closes the previous assignment.
- **Workers see only their own assignments** in `/phil/gear`. Admin sees all.
- **Calibration dates** are first-class — testers / meters with `calibrationDue < today` flag overdue.

### Acceptance

This loop is closed when:
1. Admin can assign an asset and the worker sees it within 10 seconds.
2. A worker scan writes a GearScan record visible in `/gear/:id`.
3. Overdue assets surface in `/gear` AND the command-centre KPI.
4. A daily cron fires push notifications for items overdue by ≥1 day.
5. Playwright E2E covers assign → worker sees → scan → admin sees scan.

---

## Loop 3 — Job evidence (task completion with required photo)

```
┌─ Admin builds job ──────────────────────────────────┐
│  1. Admin opens /jobs/new (Job Builder)              │
│  2. Admin adds stages, areas, tasks                  │
│  3. For each task, admin sets evidenceRequired: bool │
│  4. Admin assigns the job to a crew                  │
│      ↓ POST /api/jobs                                │
└──────────────────────────────────────────────────────┘
                       │
┌─ Phil (worker) ─────────────────────────────────────┐
│  5. Worker opens /phil/jobs/:jobId                   │
│  6. Worker drills into stage → area → task           │
│  7. Worker taps task status → "Done"                 │
│  8. If evidenceRequired and no photo yet:            │
│      → Camera opens automatically                    │
│      → Worker takes photo (or picks from library)    │
│      → Photo uploads; Evidence record created        │
│  9. Task transitions to "Done"                       │
│      ↓ POST /api/task-toggle                         │
│      ↓ POST /api/photos                              │
└──────────────────────────────────────────────────────┘
                       │
┌─ Admin reviews ─────────────────────────────────────┐
│ 10. /jobs/:jobId/areas/:areaId shows completed tasks │
│ 11. Each Evidence record is reviewable in admin     │
│ 12. Admin can flag evidence as "needs better photo" │
│ 13. Worker sees the flag on next Phil load          │
└──────────────────────────────────────────────────────┘
                       │
┌─ Progress / reporting ──────────────────────────────┐
│ 14. Job completion % updates                         │
│ 15. /command-centre KPI: jobs at handover-readiness  │
│ 16. AuditLog: task completed, evidence captured     │
└──────────────────────────────────────────────────────┘
```

### Required entities

- `JobTask { id, stageId, areaId, name, evidenceRequired: boolean, status }`
- `Evidence { id, taskId?, itpCompletionId?, rfiId?, snagId?, photoId, capturedBy, capturedAt, location?, flagged: boolean, flagReason? }`
- `Photo { id, blobKey, mimeType, sizeBytes, originalFilename?, takenAt? }`

### Constraints

- **One task → many evidence records.** Workers can add more after the first if requested.
- **Photo size limit** — enforce client-side compression. The current `/api/photos` accepts base64 dataUrl up to ~4MB.
- **Evidence is immutable.** Flagging adds a flag record; the original photo stays.

### Acceptance

This loop is closed when:
1. A task with `evidenceRequired = true` cannot be marked done without a photo.
2. Photos appear in admin within 5 seconds of upload.
3. Admin flag is visible to the worker on next load.
4. Playwright E2E covers task creation → worker completes → photo capture → admin review.

---

## Loop 4 — ITP / QA

Independent reviewer checkpoint completion.

```
┌─ Admin sets up ────────────────────────────────────┐
│  1. Admin opens /jobs/:jobId/itp                    │
│  2. Admin picks an ITP template + applies to areas  │
│  3. ITPCompletion records created per area/checkpoint │
│      ↓ POST /api/job-itps                          │
└──────────────────────────────────────────────────────┘
                       │
┌─ Phil (worker) completes ──────────────────────────┐
│  4. Worker opens /phil/jobs/:id/itps                │
│  5. Worker drills into area + checkpoint           │
│  6. Worker captures required Evidence              │
│  7. Worker marks checkpoint "Submitted"             │
│      ↓ POST /api/itp-completion                    │
└──────────────────────────────────────────────────────┘
                       │
┌─ Independent reviewer ─────────────────────────────┐
│  8. Reviewer (different person from submitter)     │
│     opens /itp                                     │
│  9. Reviewer checks the checkpoint + evidence      │
│ 10. Reviewer signs off OR returns "needs info"    │
│      ↓ POST /api/itp-completion (with reviewer ID) │
│ 11. Server enforces itp_review_self rule          │
│      (submitter ≠ reviewer)                         │
└──────────────────────────────────────────────────────┘
                       │
┌─ Handover readiness ───────────────────────────────┐
│ 12. /jobs/:jobId/handover-readiness shows ITP %    │
│ 13. /command-centre KPI: jobs at handover threshold │
│ 14. AuditLog: checkpoint submitted, reviewed       │
└──────────────────────────────────────────────────────┘
```

### Required entities

- `ITPTemplate { id, name, jobType?, checkpoints: ITPCheckpoint[] }`
- `ITPCheckpoint { id, name, evidenceRequired, sortOrder }`
- `ITPCompletion { id, checkpointId, jobId, areaId, status: 'pending'|'submitted'|'needs_info'|'approved', submitterId?, reviewerId?, submittedAt?, reviewedAt?, returnReason? }`
- `Evidence` (linked via `itpCompletionId`).

### Constraints

- **Independent reviewer rule:** server rejects if `submitterId === reviewerId`.
- **Returns are explicit** — `needs_info` requires a reason which the worker sees.
- **No skip-ahead** — handover-readiness % counts only `approved` completions.

### Acceptance

This loop is closed when:
1. ITP completion cannot be approved by the submitter (server-enforced).
2. Worker sees `needs_info` returns inside Phil with the reason.
3. Handover-readiness % matches sum of approved completions.
4. Playwright E2E covers template assignment → worker submits → independent reviewer approves.

---

## Loop 5 — RFI / variation / defect

Field-raised issues, routed to the right outcome.

```
┌─ Worker raises ────────────────────────────────────┐
│  1. Worker opens /phil/rfis/raise (or /phil/snags) │
│  2. Worker selects job + area + category           │
│      ('Question / Variation / Defect / Note')     │
│  3. Worker types short description                  │
│  4. Worker optionally captures photo               │
│  5. Worker submits                                  │
│      ↓ POST /api/rfis (or /api/snag-quick-raise)  │
└──────────────────────────────────────────────────────┘
                       │
┌─ Admin triage ─────────────────────────────────────┐
│  6. Admin opens /rfis (combined inbox)             │
│  7. Admin sees new item with category, photo,      │
│     job context                                    │
│  8. Admin decides:                                  │
│     a) Reply + close (just a question)             │
│     b) Convert to Defect (Snag) for follow-up     │
│     c) Convert to Variation (with cost/time impact)│
│     d) Convert to Plan revision request           │
│     e) Note + leave open                           │
└──────────────────────────────────────────────────────┘
                       │
┌─ Tracked downstream ───────────────────────────────┐
│  9. If converted to Defect → /snags                │
│ 10. If converted to Variation → /jobs/:jobId#variations │
│      with cost/time deltas                          │
│ 11. Worker sees outcome in Phil                    │
│ 12. AuditLog every transition                      │
└──────────────────────────────────────────────────────┘
```

### Required entities

- `RFI { id, jobId, areaId?, category, description, raisedBy, raisedAt, status, resolution?, resolutionType?, linkedDefectId?, linkedVariationId? }`
- `Defect (Snag)` (existing — extended with `originRfiId?`)
- `Variation { id, jobId, sourceRfiId?, costImpact?, timeImpact?, status: 'draft'|'submitted'|'approved'|'rejected'|'invoiced' }`

### Constraints

- **One inbox** — admin sees all field-raised items in one place, even if they end up as different types.
- **No silent loss** — every RFI/Snag/Variation has a status; no archive without resolution.
- **Cost/time impact is mandatory** for variations submitted to the builder.

### Acceptance

This loop is closed when:
1. Worker can raise an RFI in ≤3 taps from /phil home.
2. Admin sees the item within 10 seconds.
3. Admin can convert to Defect / Variation / Plan request and the worker sees the converted entity.
4. AuditLog records the transition.
5. Playwright E2E covers raise → triage → convert → worker sees outcome.

---

## Cross-loop principles

These apply to every loop above.

1. **Field captures → admin reviews → admin acts → record attaches → audit log writes.** Every loop has all five steps. Skipping any step means the loop isn't a loop.
2. **AuditLog is immutable.** Every action that mutates user-visible state appends to AuditLog. The log is the source of truth for "what happened, when, by whom".
3. **No invisible state changes.** If a record's status changes server-side (e.g. a cron auto-closes stale snags), the worker sees it on next load with a visible indicator.
4. **Workers acknowledge changes.** When admin flags evidence as needing re-capture, the worker doesn't just see it — they have to acknowledge or act.
5. **Concurrency is real.** Two admins approving the same timesheet, or assigning the same asset, must not silently overwrite. Server-side guards (existing entries' `status` field reads must match the expected state before write succeeds).
6. **Offline graceful degradation** (Phil only) — submission failures show a clear retry banner, not a silent loss.
7. **Demo data is always marked.** Loaded fixtures show a banner across the shell. There is no path to confuse fixtures for real data.

---

## Loop priorities for the rebuild

Per [01-mvp-rebuild-scope.md](01-mvp-rebuild-scope.md):

| Loop                   | Build in phase | Priority         |
| ---------------------- | -------------- | ---------------- |
| Hours                  | Phase B        | First end-to-end |
| Gear                   | Phase C        | Second           |
| Job evidence (task + photo) | Phase D    | Third            |
| ITP / QA                | Future         | After D          |
| RFI / Variation / Defect | Future        | After D          |

The first three loops define the MVP. The other two are flagged as `UNDER CONSTRUCTION` until their phase comes.
