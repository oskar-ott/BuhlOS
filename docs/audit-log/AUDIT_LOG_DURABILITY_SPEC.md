# Audit Log Durability Spec

## Status

PLANNED / NOT IMPLEMENTED

This document is a design and planning artifact only. It describes the desired audit-log durability guarantee for future implementation. It does not claim that blocking audit enforcement exists today.

## Current problem

The current product intent is that important business mutations leave an audit trail. The verified implementation does not yet guarantee that in all paths.

Current findings:

- Some mutation APIs continue when an audit append fails.
- Some mutation APIs write the main record before a best-effort audit append.
- Some mutation APIs write an audit entry before the main record, which can leave an audit row for a mutation that later fails.
- Some mutation APIs use a local per-domain history file rather than the cross-surface AuditLog.
- Some mutation APIs have no audit write today.
- Whole-blob read-modify-write storage creates race windows for both business records and audit blobs.

The field-readiness risk is simple: a real business change can exist with no durable audit record, or an audit row can exist without the corresponding final business state.

## Product rule

Every important business mutation should create an AuditLog entry.

Not every event requires blocking durability. Field capture and low-risk operational notes may remain best-effort when blocking would harm onsite capture, but the product must explicitly classify those exceptions.

## Audit failure classes

### Blocking audit required

The mutation must fail if the audit write fails. The API should return an error before the user-visible business state changes, or use a future transactional/outbox pattern that can guarantee both the mutation and audit entry.

Use this class for compliance, payroll, permission, publication, assignment, procurement status, safety-critical, or destructive mutations.

### Best-effort audit acceptable

The mutation may continue if audit write fails, but the failure must be observable. At minimum, it should be logged with enough context for later triage. Prefer a retryable audit-outbox queue once available.

Use this class only when blocking the user would create a worse operational outcome, such as losing field evidence or onsite notes in poor connectivity.

### No audit required

Read-only events, validation failures before mutation, idempotent UI fetches, and non-business interactions do not need AuditLog entries.

## Verified current AuditLog shape

The current cross-surface audit helper is `api/_lib/audit-log.js`. It stores monthly blobs at `audit/<yyyy-mm>.json` with an `entries` array.

Verified current entry fields are:

- `id`
- `ts`
- `action`
- `actorId`
- `actorName`
- `actorRole`
- `jobId`
- `targetType`
- `targetId`
- `summary`
- `metadata`

The TypeScript schema in `src/domains/audit-log/schema.ts` accepts the same core shape and passes through unknown forward-compatible fields.

## Suggested AuditLog schema guarantee

Future hardening should define a canonical append payload and persisted entry shape. Recommended fields:

- `id`: stable audit entry id.
- `actorUserId`: canonical user id. Current field is `actorId`.
- `actorRole`: normalized role at the time of action.
- `actorName`: display-only actor label at the time of action.
- `action`: typed verb such as `hours.approved`.
- `domain`: broad domain such as `hours`, `materials`, `evidence`, `jobs`, `plans`, `assets`, or `users`.
- `entityType`: canonical entity type. Current field is `targetType`.
- `entityId`: canonical entity id. Current field is `targetId`.
- `jobId`: nullable job id when the mutation is job-scoped.
- `before`: sanitized bounded previous values for blocking mutations.
- `after`: sanitized bounded next values for blocking mutations.
- `metadata`: sanitized bounded action-specific data.
- `requestId`: request or correlation id when available.
- `createdAt`: server timestamp. Current field is `ts`.
- `result`: `succeeded`, `failed`, or `attempted` if attempted audit rows are introduced later.
- `source`: `admin`, `phil`, `api`, `cron`, `system`, or another controlled source.
- `reason`: optional human reason for rejection, cancellation, reopen, override, or destructive actions.

Do not claim these suggested fields exist until the implementation PR adds them or maps them from current fields.

## Sensitive data rule

Audit logs must not store:

- Passwords, PINs, or one-time setup secrets.
- `passwordHash`.
- Session tokens, invite tokens, reset tokens, API keys, webhook secrets, or OAuth secrets.
- Raw files, raw images, full PDFs, or raw base64 payloads.
- Unnecessary personal information.
- Full request bodies unless explicitly sanitized and bounded.

Before/after and metadata fields must be allowlisted per action. They must not use generic request-body spreading.

## Immutability rule

Audit entries should be append-only. No user-facing API should update or delete an audit row.

The current monthly blob implementation is append-only at helper/API shape, but physically rewrites the whole blob on each append and trims old rows after a monthly cap. Future durability work should document retention separately from append semantics.

## Correlation rule

Important mutations should include a `requestId` or correlation id when available. If the platform does not provide one, the API should generate one at request entry and pass it to both the mutation and audit helper.

Correlation is especially important for:

- Bulk hours approval/rejection.
- Payroll export.
- Material status transitions.
- Job publish/archive/delete.
- User assignment and role changes.
- Plan visibility changes.
- Asset transfer and condition changes.

## Current audit table

This audit was performed from `origin/main` on branch `docs/audit-log-durability-spec`. It inspected audit helpers, mutation APIs, docs, tests, and blob write helpers. It did not edit app code while auditing.

| Domain | Mutation | Current audit behaviour | Failure behaviour | Risk | Recommended policy |
| ------ | -------- | ----------------------- | ----------------- | ---- | ------------------ |
| Time entries | Submit/create via `api/time-entries.js` POST | Per-user time-entry audit row via `_lib/time-entries.appendAudit`; no cross-surface AuditLog | Helper catches internally, logs to console, and never blocks after `writeEntry` | Submitted hours can exist without durable audit | NEEDS_DECISION, likely REQUIRED_BEST_EFFORT for worker submit and REQUIRED_BLOCKING for office on-behalf submit |
| Time entries | Edit via `api/time-entries.js` PATCH | Per-user time-entry audit with diff | Helper catches internally after `writeEntry`; mutation succeeds | Edits can change payroll-adjacent data without durable audit | REQUIRED_BLOCKING for admin edits; NEEDS_DECISION for worker edits before approval |
| Time entries | Approve via `api/time-entries-approve.js` | Per-user time-entry audit | Helper catches internally after `writeEntry`; mutation succeeds | Approved hours can lack audit trail | REQUIRED_BLOCKING |
| Time entries | Reject via `api/time-entries-reject.js` | Per-user time-entry audit, including undo path | Helper catches internally after `writeEntry`; mutation succeeds | Rejection/undo can lack audit trail and reason durability | REQUIRED_BLOCKING |
| Time entries | Bulk approve via `api/time-entries-bulk-approve.js` | Per-user audit per processed entry | Helper catches internally after each `writeEntry`; partial success possible | Bulk payroll decisions can lack audit and be hard to reconstruct | REQUIRED_BLOCKING with bulk correlation id |
| Time entries | Bulk reject via `api/time-entries-bulk-reject.js` | Per-user audit per processed entry | Helper catches internally after each `writeEntry`; partial success possible | Bulk rejection reasons can lack audit durability | REQUIRED_BLOCKING with bulk correlation id |
| Time entries | Reopen via `api/time-entries-reopen.js` | Per-user time-entry audit with status diff | Helper catches internally after `writeEntry`; mutation succeeds | Reopened payroll state can lack audit | REQUIRED_BLOCKING |
| Time entries | Export via `api/time-entries-export.js` | Per-user `exported` audit row and `payroll-runs.json` append | Audit catches internally; payroll-runs write is separate after entry updates | Exported payroll rows can lack per-entry audit or payroll-run record consistency | REQUIRED_BLOCKING |
| Material requests | Create direct via `api/material-requests.js` POST | Cross-surface `material_request.created` before request write; audit id stamped if present | Audit failure is caught and request still writes; audit success with later write failure can leave attempted row | Procurement request can exist without audit, or audit can precede failed write | NEEDS_DECISION for field/direct create; likely REQUIRED_BEST_EFFORT for field-origin capture and REQUIRED_BLOCKING for office create |
| Material requests | Approve/order/deliver/cancel via PATCH status | Cross-surface `material_request.transitioned` after write when status/urgency/supplier/orderRef changes | Audit failure caught after mutation; mutation succeeds | Procurement status can change with no audit | REQUIRED_BLOCKING |
| Material requests | Supplier/orderRef/urgency edit | Cross-surface transition audit only for urgency, supplier, orderRef | Audit failure caught after mutation | Commercially relevant metadata can lack audit | REQUIRED_BLOCKING for supplier/orderRef; REQUIRED_BEST_EFFORT or NEEDS_DECISION for urgency |
| Evidence | Create/upload via `api/evidence.js` POST | Cross-surface `evidence.captured` before evidence write and legacy per-job audit after write | Monthly audit failure caught; evidence still writes; legacy audit is fire-and-forget | Field evidence can exist without AuditLog, or audit can precede failed evidence write | REQUIRED_BEST_EFFORT unless compliance-critical capture is identified |
| Evidence | Review/approve via `api/evidence.js?action=review` to reviewed | Cross-surface `evidence.reviewed` before evidence write and legacy per-job audit after write | Monthly audit failure caught; review still writes | Approval can lack durable audit | REQUIRED_BLOCKING |
| Evidence | Reject via `api/evidence.js?action=review` to rejected | Cross-surface `evidence.rejected` before evidence write and legacy per-job audit after write | Monthly audit failure caught; rejection still writes | Rejection and reason can lack durable audit | REQUIRED_BLOCKING |
| Evidence | Unreview via `api/evidence.js?action=review` to submitted | Cross-surface `evidence.unreviewed` before evidence write and legacy per-job audit after write | Monthly audit failure caught; unreview still writes | Reversal can lack durable audit | REQUIRED_BLOCKING |
| Evidence | Delete/archive | No route found in `api/evidence.js` | Not applicable today | Future destructive evidence action would be high-risk | REQUIRED_BLOCKING if added |
| Jobs | Create via `api/jobs.js` POST | No job audit and no cross-surface AuditLog | Mutation writes `jobs.json` and seed blobs without audit | New jobs can appear with no audit | REQUIRED_BEST_EFFORT or REQUIRED_BLOCKING before rollout decision |
| Jobs | Edit via `api/jobs.js` PUT | Legacy per-job structural audit after `jobs.json` write | Wrapped in try/catch; failure warns and mutation succeeds | Structural changes can lack durable audit | REQUIRED_BLOCKING for status, client, modules, major structure; REQUIRED_BEST_EFFORT for minor basics |
| Jobs | Publish/unpublish via status PUT | Legacy per-job structural audit after write | Audit failure swallowed | Field-visible publication state can change without audit | REQUIRED_BLOCKING |
| Jobs | Archive/delete via status PUT | Legacy per-job structural audit after write; no separate DELETE route in `api/jobs.js` | Audit failure swallowed | Destructive/visibility state can lack audit | REQUIRED_BLOCKING |
| Jobs | Assignment changes | No assignment mutation in `api/jobs.js`; assignments mutate through users | No job audit on user assignment change | Worker access can change without audit | REQUIRED_BLOCKING in users/assignments |
| Plans | Upload/register plan via `api/plans.js` POST | No AuditLog | Mutation writes plan file and `plans-index.json` | Plan register can change without audit | REQUIRED_BEST_EFFORT or REQUIRED_BLOCKING for current/supersession policy |
| Plans | Register pages via `api/plans.js?action=set-pages` | No AuditLog | Mutation writes page PNGs and plan index | Raster page registration can lack audit | OPTIONAL or REQUIRED_BEST_EFFORT |
| Plans | Edit metadata/status/supersession via `api/plans.js` PATCH | No AuditLog | Mutation writes plan index | Drawing status and supersession can change without audit | REQUIRED_BLOCKING for status/supersession; REQUIRED_BEST_EFFORT for metadata |
| Plans | Archive plan via `api/plans.js` DELETE | No AuditLog | Mutation writes plan index | Plan can disappear from normal views without audit | REQUIRED_BLOCKING |
| Plan markups | Create markup via `api/plan-markups.js` POST | No AuditLog | Mutation writes `drawing-markups.json` | Field/admin overlay context can lack audit | NEEDS_DECISION; likely REQUIRED_BEST_EFFORT |
| Plan markups | Update markup via PATCH | No AuditLog | Mutation writes `drawing-markups.json` | Markup content/visibility can change without audit | REQUIRED_BLOCKING for `visibleToPhil`; REQUIRED_BEST_EFFORT for content/position |
| Plan markups | Archive markup via DELETE or PATCH `archived` | No AuditLog | Mutation writes `drawing-markups.json` | Markup can be removed from view without audit | REQUIRED_BEST_EFFORT or REQUIRED_BLOCKING if compliance-critical |
| Plan markups | `visibleToPhil` toggle via PATCH | No AuditLog | Mutation writes `drawing-markups.json` | Field-visible instruction can change without audit | REQUIRED_BLOCKING |
| Assets/Gear | Create asset via `api/assets.js` POST | Asset record only; history only if created with holder; no cross-surface AuditLog | Mutation writes asset and maybe history; history write failure would fail after asset write because it is awaited | Asset can be created without history; create-and-assign can partially write | REQUIRED_BEST_EFFORT for create; REQUIRED_BLOCKING if assigned on create |
| Assets/Gear | Transfer holder via `api/assets.js?action=transfer` | Per-asset history entry after asset write; no cross-surface AuditLog | History write is awaited after asset write; if it fails, API can error after holder changed | Holder can change without history, or user can see error despite changed holder | REQUIRED_BLOCKING |
| Assets/Gear | Report damaged/missing/check via `api/assets.js?action=report` | Per-asset history entry after asset write; no cross-surface AuditLog | History write is awaited after asset write | Condition can change without durable history if history write fails after asset write | REQUIRED_BLOCKING for damaged/missing; NEEDS_DECISION for check |
| Assets/Gear | Mark good via `api/assets.js?action=mark-good` | Per-asset history entry after asset write; no cross-surface AuditLog | History write is awaited after asset write | Admin reset can lack durable history | REQUIRED_BLOCKING |
| Assets/Gear | Edit metadata via `api/assets.js` PUT | No history except holder changes are blocked | Mutation writes asset | Metadata can change without audit | REQUIRED_BEST_EFFORT |
| Assets/Gear | Archive/delete via `api/assets.js` DELETE | No history and no AuditLog | Mutation writes asset archived flag | Asset can disappear from active register without audit | REQUIRED_BLOCKING |
| Users | Create client via `api/users.js?action=createClient` | No AuditLog; creates user and links job | User write can succeed before job link write; no audit | Client access can be created with no audit | REQUIRED_BLOCKING |
| Users | Create user via `api/users.js` POST | No AuditLog | Mutation writes `users.json` | Account can be created with role/assignments and no audit | REQUIRED_BLOCKING |
| Users | Role changes | PUT currently does not accept role changes in inspected route | Not applicable in this route today | Future role changes are high-risk | REQUIRED_BLOCKING |
| Users | Assigned job changes via `api/users.js` PUT | No AuditLog; best-effort push after write | Mutation writes `users.json`; push failures swallowed | Worker access can change without audit | REQUIRED_BLOCKING |
| Users | Password/PIN changes via `api/users.js` PUT | No AuditLog; password hash updated | Mutation writes `users.json` | Secret reset can occur without audit; must not log secret/hash | REQUIRED_BLOCKING with sanitized metadata |
| Users | Archive/restore/hard delete/sweep | No AuditLog | Mutations write `users.json`; pending-hours check blocks hard delete | Account lifecycle changes can lack audit | REQUIRED_BLOCKING |
| ITPs | Attach/record/signoff/reopen/archive via `api/job-itps.js` | Cross-surface AuditLog plus legacy per-job audit for attach/signoff/reopen/archive | Audit calls are fire-and-forget after mutation | ITP compliance state can lack durable audit | REQUIRED_BLOCKING for signoff/reopen/archive; REQUIRED_BEST_EFFORT or NEEDS_DECISION for record |
| Observations | Create via `api/observations.js` POST | Cross-surface `observation.created` after observation write | Audit failure caught; mutation succeeds | Field/admin observation can lack audit | NEEDS_DECISION; likely REQUIRED_BEST_EFFORT |
| Observations | Transition via PATCH | Cross-surface `observation.transitioned` after write when status/priority/assignment changes | Audit failure caught; mutation succeeds | Triage state can lack audit | REQUIRED_BEST_EFFORT or REQUIRED_BLOCKING for assignment/status needing action |
| Observations | Convert to snag/material request | Cross-surface create/convert audit entries around downstream writes | Audit failures caught; multi-blob partial failures already documented in code | Conversion can leave orphan downstream record or missing audit | REQUIRED_BLOCKING for office conversion once outbox/transaction pattern exists |

## Existing tests reviewed

Current tests cover schema parsing, accepted action/target enums, audit-log read API filtering, and domain-specific API behavior for evidence, observations, material requests, ITPs, users, assets, and time entries. They do not yet establish mutation durability semantics for blocking audit writes.

## Known implementation risks

- Whole-blob write race in both business stores and audit stores.
- Partial failure when audit write succeeds but mutation write fails.
- Partial failure when mutation write succeeds but audit write fails.
- Post-write audit failures that surface as API errors even though the business record changed.
- Retries creating duplicate or misleading audit entries.
- Bulk actions producing partial success without a bulk correlation id.
- Large before/after payloads bloating monthly blobs.
- Sensitive data leakage through generic metadata or before/after payloads.
- Trimmed monthly audit blobs weakening retention expectations.
- Local per-domain history files and cross-surface AuditLog diverging.

## Future test requirements

Before code enforcement changes merge, add tests proving:

1. Mutation fails when blocking audit append fails.
2. Mutation succeeds when best-effort audit append fails.
3. Audit entry sanitises `passwordHash`, secrets, tokens, and raw files.
4. Audit before/after is bounded and safe.
5. Duplicate retry does not create misleading audit entries.
6. Material status transition audit is required.
7. Hours approval audit is required.
8. Job publish/archive audit is required.
9. Worker assignment audit is required.
10. Field capture best-effort policy is tested.

