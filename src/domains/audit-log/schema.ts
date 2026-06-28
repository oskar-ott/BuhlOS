import { z } from "zod";

/**
 * Zod schemas for the audit log domain (Phase D2 bootstrap).
 *
 * The audit log is an append-only journal of significant cross-surface
 * actions — evidence captures + admin reviews land here in D2 / D4,
 * with hours / gear migrations folded in by later phases.
 *
 * Storage shape: monthly rollover blobs at `audit/<yyyy-mm>.json`,
 * each containing `{ entries: AuditLogEntry[] }`. Append-only — no
 * update or delete operations are exposed.
 *
 * This is a NEW journal alongside the legacy `api/_lib/job-audit.js`
 * per-job structural log. Doc 28 §A.5 requires both to fire on every
 * evidence write so the legacy admin audit tab keeps working while
 * the new cross-job journal grows.
 *
 * Cross-ref:
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §5.9
 *   docs/rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md §A.5
 *   api/_lib/job-audit.js — legacy per-job log
 *   api/_lib/audit-log.js — new monthly journal storage helper
 */

/**
 * Action vocabulary. Closed set so we catch typos at schema-parse time
 * and so future analytics can rely on stable strings.
 *
 * D2 adds `evidence.captured`. D4 adds `evidence.reviewed` +
 * `evidence.rejected`. D5 adds `evidence.unreviewed`. D.5 (snags)
 * adds `snag.created` + `snag.transitioned`. E1a (ITPs) adds the
 * `itp.*` verbs covering the api/job-itps.js mutating actions (attach,
 * record, submit, signoff, reopen, archive). Future phases
 * append new verbs (`hours.submitted`, `gear.transferred`, ...)
 * without breaking existing rows.
 *
 * `snag.transitioned` is one verb covering every status change — the
 * audit row's `metadata.from` + `metadata.to` carry the actual
 * direction. The ITP verbs are split per action because they're
 * already distinct operational events: a "point.recorded" is
 * worker-side mid-flight, "signed_off" is admin-side terminal,
 * etc. Splitting up-front keeps later admin-side activity filters
 * straightforward.
 */
export const AUDIT_ACTIONS = [
  "evidence.captured",
  "evidence.reviewed",
  "evidence.rejected",
  "evidence.unreviewed",
  // #263: before/after pairing — linked/unlinked fire on the AFTER row
  // only. Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "evidence.linked",
  "evidence.unlinked",
  "snag.created",
  "snag.transitioned",
  "itp.attached",
  "itp.point.recorded",
  // Submit-for-review: the explicit in-progress → witnessed handoff
  // (replaced the implicit auto-witness on the last record).
  "itp.submitted",
  "itp.signed_off",
  "itp.reopened",
  "itp.archived",
  // #503 — office proof sign-off (the admin approve/send-back surface).
  "proof.approved",
  "proof.sent_back",
  // Onboarding (O1) — kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  // One verb per admin action the bible §10 S11 requires auditing.
  // `invite.issued` covers first send + resend (metadata.resentCount).
  "employee.created",
  "employee.updated",
  "employee.role_changed",
  "employee.disabled",
  "invite.issued",
  "invite.revoked",
  // O2: provider send failure (metadata only).
  "invite.send_failed",
  // O3: worker opens the invite + completes setup (metadata only).
  "invite.opened",
  "invite.accepted",
  "employee.activated",
  // PR 6: observation triage conversion to a real snag. The snag itself also
  // emits snag.created in the same write path. Kept in sync with
  // api/_lib/audit-log.js VALID_ACTIONS.
  "observation.converted_to_snag",
  // PR 10: observation lifecycle verbs. observation.created emits on POST
  // /api/observations; observation.transitioned emits on PATCH when status,
  // priority, or assignedToId changes (metadata.changedFields lists them;
  // metadata.from/to capture status flips so a timeline reads as English).
  "observation.created",
  "observation.transitioned",
  // PR 11: Material Request module. material_request.created emits on POST
  // /api/material-requests and on the convert-from-observation action.
  // material_request.transitioned emits on PATCH whenever status / urgency /
  // supplier / orderRef / approvedById / cancellation fields change.
  // observation.converted_to_material_request mirrors PR 6's snag conversion
  // verb — emitted by the convert action attributing the office decision.
  "material_request.created",
  "material_request.transitioned",
  // #151: scheduled blob backup — one entry per run (metadata.ok carries
  // success/failure). Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "backup.completed",
  // #157: a write guard refused a destructive/conflicting store write.
  "storage.write_rejected",
  "observation.converted_to_material_request",
  "document.uploaded",
  "document.superseded",
  "document.made_current",
  "document.acknowledged",
  "contact.saved",
  "contact.removed",
  "credential.added",
  "credential.updated",
  "credential.removed",
  "induction.confirmed",
  "induction.backfilled",
  "leave.recorded",
  "leave.decided",
  "leave.cancelled",
  // #280: variation CLAIM module. variation.created emits on POST
  // /api/variations; variation.transitioned emits on the status PATCH (one verb;
  // metadata.from/to carry the direction, metadata.method on the approve move).
  // observation.converted_to_variation mirrors observation.converted_to_snag —
  // the observation→claim promotion. Kept in sync with api/_lib/audit-log.js.
  "variation.created",
  "variation.transitioned",
  "observation.converted_to_variation",
  // #390: hours / time-entry events. The office approvals pass (bulk actions
  // write one summarising entry) plus the worker submissions that feed it —
  // submitted (first submission) + resubmitted (rejected→submitted correction).
  // Kept in sync with api/_lib/audit-log.js.
  "hours.approved",
  "hours.rejected",
  "hours.reject_undone",
  "hours.reopened",
  "hours.bulk_approved",
  "hours.bulk_rejected",
  "hours.submitted",
  "hours.resubmitted",
  // #370: daywork register (api/dayworks.js). daywork.created on POST;
  // daywork.signed on the supervisor sign; daywork.transitioned on the
  // signed → invoiced change (metadata.from/to); daywork.amended when a
  // signed/invoiced docket spawns a linked amendment. Kept in sync with
  // api/_lib/audit-log.js VALID_ACTIONS.
  "daywork.created",
  "daywork.signed",
  "daywork.transitioned",
  "daywork.amended",
  // #371: pre-start readiness gate (api/job-readiness.js) — manual-checklist
  // tick, override-with-reason, and clearing it. targetType 'prestart'. Kept in
  // sync with api/_lib/audit-log.js VALID_ACTIONS.
  "readiness.item_ticked",
  "readiness.overridden",
  "readiness.override_cleared",
  // #581: job-creating actions. job.created on every sanctioned job write (Job
  // Builder POST + won-quote convert); quote.converted on the quote→job
  // conversion. Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "job.created",
  "quote.converted",
  // #349: job closeout lifecycle (closed freezes the snapshot; reopened reverses).
  "job.closed",
  "job.reopened",
  // #224: rule-based task generation ("Generate tasks" in the builder).
  "job.tasks_generated",
  // #219: safety documents (api/safety-docs.js). safety_doc.uploaded on an admin
  // upload (incl. a new version); safety_doc.acknowledged when a worker taps
  // "I've read this". targetType 'safety_doc'. Kept in sync with
  // api/_lib/audit-log.js VALID_ACTIONS.
  "safety_doc.uploaded",
  "safety_doc.acknowledged",
  // #231: commissioning documents + certificates register (api/certificates.js).
  "certificate.uploaded",
  // #276: per-job RFI register (api/rfis.js). rfi.created on raise; rfi.transitioned
  // on send/answer/close (metadata.from/to carry the direction).
  "rfi.created",
  "rfi.transitioned",
  // #210: site diary (api/diary.js). diary.created on the day's entry POST;
  // diary.amended on an append-only amendment (the original is never mutated).
  // targetType 'diary'. Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "diary.created",
  "diary.amended",
  // #235: defect liability period — handover date set / cleared from the jobs
  // PUT. targetType 'job'. Kept in sync with api/_lib/audit-log.js.
  "job.handover_set",
  "job.handover_cleared",
  // #217: meeting-minutes register (api/job-minutes.js). minutes.recorded on a
  // new minute; minutes.amended on an append-only amendment (the original body
  // is never mutated). targetType 'minutes'. Kept in sync with
  // api/_lib/audit-log.js VALID_ACTIONS.
  "minutes.recorded",
  "minutes.amended",
] as const;
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);

export const AUDIT_TARGET_TYPES = [
  "evidence",
  "snag",
  "itp_template",
  "itp_instance",
  // Onboarding (O1).
  "employee",
  "invite",
  // PR 6: observations as audit targets.
  "observation",
  // PR 11: Material Request module.
  "material_request",
  // #151: platform-level events (backups).
  "system",
  "document",
  "contact",
  "credential",
  "induction",
  "leave",
  // #280: variation claim records (jobs/<id>/variations.json).
  "variation",
  // #390: timesheet day records (users/<id>/time-entries/<date>.json).
  "time_entry",
  // #370: daywork docket records (jobs/<id>/dayworks.json).
  "daywork",
  // #371: per-job pre-start readiness (jobs/<id>/prestart.json).
  "prestart",
  // #503: per-task proof review records (jobs/<id>/job-control.json proofReviews).
  "proof_review",
  // #581: a created job (job.created) and a converted quote (quote.converted).
  "job",
  "quote",
  // #219: per-job safety docs (jobs/<id>/safety-docs.json).
  "safety_doc",
  // #231: per-job certificates.
  "certificate",
  // #276: per-job RFI records.
  "rfi",
  // #210: per-job site diary entries (jobs/<id>/diary.json).
  "diary",
  // #217: per-job meeting-minutes records (jobs/<id>/minutes.json).
  "minutes",
] as const;
export const AuditTargetTypeSchema = z.enum(AUDIT_TARGET_TYPES);

/**
 * One row in the audit log. `metadata` is .passthrough() so action
 * verbs can attach action-specific fields (e.g. rejectionReason for
 * `evidence.rejected`) without expanding the schema for every variant.
 */
export const AuditLogEntrySchema = z
  .object({
    id: z.string(),
    ts: z.string(),
    action: AuditActionSchema,
    actorId: z.string(),
    actorName: z.string(),
    actorRole: z.string().nullable().optional(),
    jobId: z.string().nullable().optional(),
    targetType: AuditTargetTypeSchema,
    targetId: z.string(),
    summary: z.string(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const AuditLogFileSchema = z.object({
  entries: z.array(AuditLogEntrySchema),
});

/** GET /api/audit-log response — same shape as a monthly blob's
 *  contents, filtered/sorted by the server. */
export const AuditLogListResponseSchema = AuditLogFileSchema;

/**
 * Payload the server passes to api/_lib/audit-log.js#append(). Server
 * fills id + ts + persists to the current month's blob. Callers pass
 * the action verb + actor + target + summary.
 */
export const AppendAuditLogPayloadSchema = z.object({
  action: AuditActionSchema,
  actorId: z.string(),
  actorName: z.string(),
  actorRole: z.string().nullable().optional(),
  jobId: z.string().nullable().optional(),
  targetType: AuditTargetTypeSchema,
  targetId: z.string(),
  summary: z.string(),
  metadata: z.record(z.unknown()).optional(),
});
