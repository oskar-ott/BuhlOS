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
  // #170: the AI assistant generated a job summary (api/ai-assistant.js).
  // targetType 'job'. Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "ai.job_summarised",
  // 2026-07 AI batch (#347/#373) + #171 office daily summary. Kept in sync
  // with api/_lib/audit-log.js.
  "ai.digest_generated",
  "ai.office_summary_generated",
  "job.contract_obligations_extracted",
  "job.contract_obligation_accepted",
  "evidence.captured",
  "evidence.reviewed",
  "evidence.rejected",
  "evidence.unreviewed",
  // #263: before/after pairing — linked/unlinked fire on the AFTER row
  // only. Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "evidence.linked",
  "evidence.unlinked",
  // #233: as-built designation — flagged/unflagged fire on the designated
  // capture. Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "evidence.flagged_asbuilt",
  "evidence.unflagged_asbuilt",
  // #262 AI photo labels + #267 defect suggestions. Kept in sync with
  // api/_lib/audit-log.js VALID_ACTIONS.
  "evidence.labels_suggested",
  "evidence.labels_corrected",
  "evidence.defect_suggestion_dismissed",
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
  // Crew sign-up link (public self-signup + admin review gate). Kept in sync
  // with api/_lib/audit-log.js VALID_ACTIONS.
  "signup.submitted",
  "signup.link_created",
  "signup.link_updated",
  "signup.approved",
  "signup.rejected",
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
  // #197: Epic 5 page understanding — AI extraction ran / human corrected a field.
  "document.ai_extracted",
  "document.ai_corrected",
  // #203: Epic 5 revision diff ran (classic CV) / a changed region was walked.
  "document.revision_diffed",
  "document.diff_region_reviewed",
  // #205: Epic 5 count review — a human accepted a device count.
  "document.count_accepted",
  // #211: Epic 5 cable estimates — calibration/run + human acceptance.
  "document.cable_estimated",
  "document.cable_estimate_accepted",
  // #213: Epic 5 takeoff sign-off — the quoting gate.
  "document.takeoff_signed_off",
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
  // #372: PROGRESS-claim register (jobs/<id>/claims.json). created on the
  // seeded draft; submitted on the immutable freeze; status_changed on the
  // manual certified/paid moves (metadata.to carries the direction). Kept in
  // sync with api/_lib/audit-log.js VALID_ACTIONS.
  "claim.created",
  "claim.submitted",
  "claim.status_changed",
  // #276: observation → real RFI conversion verb (mirrors the snag/variation
  // converts; the field's "Question for office" chip becomes a register RFI).
  "observation.converted_to_rfi",
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
  // #230: services-locations register (api/services-locations.js) — where the
  // pit/board/meter/temp-supply are. added on POST, updated on PATCH, removed on
  // DELETE. targetType 'service_location'. Kept in sync with api/_lib/audit-log.js.
  "service_location.added",
  "service_location.updated",
  "service_location.removed",
  // #283: site-instructions register (api/site-instructions.js). created on a
  // recorded instruction; transitioned on acknowledge / close. targetType
  // 'instruction'. Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "instruction.created",
  "instruction.transitioned",
  // #760: owner runtime feature-flag control. One verb for both the customer
  // launch-gate toggle and the owner-preview override; metadata.scope / value /
  // previous carry the change. targetType 'feature_flag'. Kept in sync with
  // api/_lib/audit-log.js VALID_ACTIONS.
  "feature_flag.toggled",
  // #760 PR2: owner per-feature config knob change.
  "feature_config.changed",
  // #366: scope-vs-quote reconciliation — resolve-or-accept decisions on
  // engine-named findings (accepted carries metadata.reason; targetId is the
  // deterministic findingKey). targetType 'scope_reconciliation'. Kept in sync
  // with api/_lib/audit-log.js VALID_ACTIONS.
  "scope.finding_resolved",
  "scope.finding_accepted",
  // #355: destructive-delete tombstone. Written (blocking) to the durable
  // cross-surface journal BEFORE api/jobs.js DELETE erases the per-job
  // audit blob, so a deleted job's existence survives its own trail.
  // targetType 'job'. Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "job.deleted",
  // #247: Xero connection lifecycle (api/xero/*.js). targetType 'integration',
  // targetId 'xero'. Never carries tokens, codes or OAuth response bodies.
  // Kept in sync with api/_lib/audit-log.js VALID_ACTIONS.
  "xero.connect_started",
  "xero.connected",
  "xero.organisation_selected",
  "xero.connection_checked",
  "xero.refresh_failed",
  "xero.disconnected",
  // #610: reference-data refresh (per-group outcomes in metadata.results).
  "xero.reference_synced",
  // #248: worker↔employee mapping confirm/remap/removal.
  "xero.worker_mapped",
  "xero.worker_unmapped",
  // #611: work-type ↔ earnings-rate mapping changes.
  "xero.worktype_mapped",
  "xero.worktype_unmapped",
  // #893: payroll-batch lifecycle (no Xero writes).
  "payroll.batch_created",
  "payroll.batch_correction_created",
  "payroll.batch_locked",
  "payroll.batch_unlocked",
  "payroll.batch_deleted",
  // #249: draft-timesheet export to Xero (the first Xero write).
  "payroll.export_previewed",
  "payroll.exported_to_xero",
  "payroll.export_retried",
  "xero.sync_retried",
  "xero.sync_acknowledged",
  "payroll.reconciled",
  // #895: batch-snapshot CSV fallback download (no Xero write).
  "payroll.csv_downloaded",
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
  // Crew sign-up link requests + link lifecycle.
  "signup",
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
  // #372: progress-claim records (jobs/<id>/claims.json).
  "claim",
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
  // #230: per-job services-locations records (jobs/<id>/services-locations.json).
  "service_location",
  // #283: per-job site-instructions records (jobs/<id>/site-instructions.json).
  "instruction",
  // #760: a feature flag (targetId = the flag key) for owner toggle/preview events.
  "feature_flag",
  // #760 PR2: a feature config knob (targetId = '<featureKey>.<key>').
  "feature_config",
  // #366: per-job scope reconciliation (jobs/<id>/scope-reconciliation.json);
  // targetId is the finding's deterministic key.
  "scope_reconciliation",
  // #247: an external integration connection (targetId = provider, e.g. 'xero').
  "integration",
  // #248: a worker↔Xero-employee link (targetId = the BuhlOS worker id).
  "xero_mapping",
  // #893: a durable payroll batch (targetId = the batch uuid).
  "payroll_batch",
  "xero_sync_item",
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
