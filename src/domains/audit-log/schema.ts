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
 * five `itp.*` verbs covering the legacy api/job-itps.js mutating
 * actions (attach, record, signoff, reopen, archive). Future phases
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
  "snag.created",
  "snag.transitioned",
  "itp.attached",
  "itp.point.recorded",
  "itp.signed_off",
  "itp.reopened",
  "itp.archived",
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
