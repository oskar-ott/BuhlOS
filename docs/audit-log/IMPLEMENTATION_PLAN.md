# Audit Log Durability Implementation Plan

## Status

PLANNED / NOT IMPLEMENTED

This plan is intentionally phased. Do not implement the durability rules in this docs-only PR.

## Phase 0 - spec only

### Scope

- Land this design pack.
- Confirm the policy matrix with product/ops.
- Do not change app code, APIs, tests, workflows, storage helpers, or production data.

### Files likely touched

- `docs/audit-log/AUDIT_LOG_DURABILITY_SPEC.md`
- `docs/audit-log/MUTATION_POLICY_MATRIX.md`
- `docs/audit-log/IMPLEMENTATION_PLAN.md`
- `docs/audit-log/README.md`

### Risks

- Policy may be over-broad before field operations confirm which capture paths must stay non-blocking.
- Current audit comments and product docs may use "best-effort" and "immutable" loosely; this pack must not imply enforcement exists.

### Test requirements

- No app tests required.
- Manual docs link check inside `docs/audit-log/`.
- `git diff --name-only origin/main...HEAD` must show only `docs/audit-log/*`.

### Rollback plan

- Revert the docs-only PR.
- No production data or runtime behavior is affected.

## Phase 1 - audit helper hardening

### Scope

- Add a central audit append helper with explicit mode:
  - `blocking`
  - `bestEffort`
- Add typed action/domain constants.
- Add a sanitisation helper for metadata and before/after fields.
- Add request/correlation id support where available.
- Add bounded payload handling for before/after and metadata.
- Decide how to represent idempotency keys for retry safety.
- Keep current read endpoint behavior stable.

### Files likely touched

- `api/_lib/audit-log.js`
- `src/domains/audit-log/schema.ts`
- `src/domains/audit-log/types.ts`
- `src/domains/audit-log/format.ts`
- Existing audit-log tests under `src/domains/audit-log/`
- Possibly `api/_lib/blob.js` only if a narrowly scoped helper needs fresh reads or compare-and-set-like behavior. Avoid broad storage churn.

### Risks

- Whole-blob monthly audit writes can lose concurrent appends.
- Blocking mode on a non-transactional blob can still leave mismatch if audit succeeds and mutation fails later.
- Retrying blocking audit can duplicate entries unless idempotency is defined.
- Sanitization gaps can leak `passwordHash`, tokens, or raw files.
- Existing enum consumers may reject new action/target values if not updated consistently.

### Test requirements

- Unit test blocking mode propagates append failure.
- Unit test best-effort mode swallows append failure but logs/records observability.
- Unit test sanitizer removes passwords, password hashes, tokens, secrets, and raw file payloads.
- Unit test metadata and before/after payloads are bounded.
- Unit test duplicate retry/idempotency behavior.
- Existing `/api/audit-log` read tests still pass.

### Rollback plan

- Keep helper changes additive.
- Existing callers remain on current best-effort mode until migrated.
- Revert helper PR if schemas or read consumers regress.

## Phase 2 - high-risk mutation enforcement

### Scope

Migrate only high-risk mutations first:

- Hours approve/reject/bulk approve/bulk reject/reopen/export.
- Material request approve/order/deliver/cancel.
- Job publish/unpublish/archive and high-risk structural/module/client changes.
- Worker assignment changes.
- Asset transfer, damaged/missing/good, archive.
- Plan `visibleToPhil` toggle.
- Evidence approval/rejection/unreview.
- ITP signoff/reopen/archive.

### Files likely touched

- `api/time-entries-approve.js`
- `api/time-entries-reject.js`
- `api/time-entries-bulk-approve.js`
- `api/time-entries-bulk-reject.js`
- `api/time-entries-reopen.js`
- `api/time-entries-export.js`
- `api/material-requests.js`
- `api/jobs.js`
- `api/users.js`
- `api/assets.js`
- `api/plan-markups.js`
- `api/evidence.js`
- `api/job-itps.js`
- Targeted tests in the matching `src/domains/**` folders.

### Risks

- Blocking audit before mutation can create audit rows for mutations that later fail.
- Blocking audit after mutation can still leave data changed if audit fails.
- Multi-blob writes, especially observation conversions and payroll exports, can partially complete.
- Existing callers may not expect 5xx/409 style failures from audit storage outages.
- Bulk actions need clear partial-success semantics before enforcement.

### Test requirements

- Hours approval fails and leaves entry unchanged when blocking audit append fails.
- Hours rejection fails and leaves entry unchanged when blocking audit append fails.
- Bulk approve/reject uses one request id and does not silently skip audit failures.
- Material status transitions fail when blocking audit append fails.
- Job publish/archive fails when blocking audit append fails.
- Worker assignment changes fail when blocking audit append fails and do not send misleading push notifications.
- Asset transfer/condition/archive fail without changing holder/condition/archive state when blocking audit append fails.
- Plan `visibleToPhil` toggle fails when blocking audit append fails.
- Evidence approval/rejection/unreview fail when blocking audit append fails.
- ITP signoff/reopen/archive fail when blocking audit append fails.

### Rollback plan

- Ship per-domain PRs behind small, reviewable changes.
- If a domain causes operational blocking, revert that domain migration only.
- Keep best-effort helper available for field capture paths.

## Phase 3 - field capture policy

### Scope

- Decide which field capture paths remain best-effort:
  - Phil hours submit.
  - Evidence upload.
  - Observation create.
  - Material request create from field, if enabled.
  - ITP point recording.
  - Gear check/report, if considered routine.
  - Plan markup create, if used onsite.
- Add visible admin surfacing for audit append failures.
- Consider an audit outbox so field capture can proceed while audit failure is retried.

### Files likely touched

- `api/time-entries.js`
- `api/evidence.js`
- `api/observations.js`
- `api/material-requests.js` or conversion paths in `api/observations.js`
- `api/job-itps.js`
- `api/assets.js`
- Admin observability surface later, if scoped.

### Risks

- Blocking onsite capture can lose field data.
- Best-effort capture without observability can hide audit outages.
- Outbox retries can duplicate entries without idempotency.
- User messaging must avoid claiming audit durability when the audit entry is pending.

### Test requirements

- Best-effort field capture succeeds when audit append fails.
- Audit failure is observable in logs or pending-failure storage.
- Retry does not create misleading duplicate audit rows.
- Field capture response does not claim audit success when audit failed.
- Admin-facing failure indicator, if built, is role-gated.

### Rollback plan

- Keep field capture on best-effort mode until outbox/observability is stable.
- Revert per-domain field capture changes independently.

## Phase 4 - observability and review tooling

### Scope

- Add audit failure logging with structured context.
- Add admin-visible audit failure queue or health indicator.
- Add request id/correlation display in future admin audit viewer.
- Consider audit-retention policy and monthly blob trim behavior.
- Consider an outbox worker or scheduled retry path if platform constraints allow it.

### Files likely touched

- `api/_lib/audit-log.js`
- Admin audit/activity UI, if scoped later.
- New docs for audit operations/runbook.
- Tests for read/triage behavior.

### Risks

- Failure logs can leak sensitive data if context is not sanitized.
- Admin UI may imply complete audit history when retention/trimming still applies.
- Retry queues can grow unbounded.
- Monitors can create noise if transient Blob errors are common.

### Test requirements

- Structured failure context is sanitized.
- Admin failure views are admin-only.
- Retry/outbox queue is bounded and idempotent.
- Audit viewer handles unknown future actions gracefully.

### Rollback plan

- Observability should be additive.
- If retry queues misbehave, disable retry processing while preserving current append helper behavior.

## Later PR sequence

Recommended follow-up PRs:

1. `audit-helper-modes`: central helper, blocking/best-effort modes, sanitizer, request id, tests.
2. `audit-hours-durability`: hours approval/rejection/bulk/export enforcement.
3. `audit-materials-durability`: material request status transition enforcement.
4. `audit-access-durability`: user roles, assignments, account lifecycle, and job publish/archive.
5. `audit-asset-plan-evidence-durability`: asset custody/condition, plan visibility, evidence review.
6. `audit-field-capture-observability`: field capture best-effort policy, outbox or admin failure surfacing.

Do not combine all domains into one implementation PR unless the storage/audit abstraction has already been proven by tests.

