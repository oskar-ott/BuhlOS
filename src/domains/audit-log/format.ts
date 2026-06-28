import type { AuditAction, AuditLogEntry, AuditTargetType } from "./types";

/**
 * Human-friendly labels and grouping for audit-log entries — used by the
 * per-job activity feed (PR 9) and the row-history panels.
 *
 * Verb labels are short ("Captured evidence", "Raised snag") so a worker or
 * an office user reads the timeline as English instead of system events. The
 * `summary` field on the entry stays the system-generated detail line.
 */

const ACTION_LABELS: Record<AuditAction, string> = {
  "document.uploaded": "uploaded a document",
  "document.superseded": "document superseded",
  "document.made_current": "marked a drawing current",
  "document.acknowledged": "acknowledged a drawing revision",
  "credential.added": "added a licence/ticket",
  "credential.updated": "updated a licence/ticket",
  "credential.removed": "removed a licence/ticket",
  "induction.confirmed": "confirmed site induction",
  "induction.backfilled": "recorded a site induction (backfill)",
  "leave.recorded": "recorded a not-worked day",
  "leave.decided": "decided a leave request",
  "leave.cancelled": "cleared a not-worked day",
  "contact.saved": "saved a job contact",
  "contact.removed": "removed a job contact",
  "evidence.captured": "Captured evidence",
  "evidence.reviewed": "Reviewed evidence",
  "evidence.rejected": "Rejected evidence",
  "evidence.unreviewed": "Re-opened evidence review",
  "snag.created": "Raised snag",
  "snag.transitioned": "Moved snag",
  "itp.attached": "Attached ITP",
  "itp.point.recorded": "Recorded ITP point",
  "itp.submitted": "Submitted ITP for review",
  "itp.signed_off": "Signed off ITP",
  "itp.reopened": "Re-opened ITP",
  "itp.archived": "Archived ITP",
  "proof.approved": "Approved proof",
  "proof.sent_back": "Sent proof back",
  "employee.created": "Added employee",
  "employee.updated": "Updated employee",
  "employee.role_changed": "Changed employee role",
  "employee.disabled": "Disabled employee",
  "employee.activated": "Activated employee",
  "invite.issued": "Issued invite",
  "invite.revoked": "Revoked invite",
  "invite.send_failed": "Invite email failed",
  "invite.opened": "Worker opened invite",
  "invite.accepted": "Worker accepted invite",
  "observation.converted_to_snag": "Converted observation to snag",
  "observation.created": "Raised observation",
  "observation.transitioned": "Updated observation",
  "observation.converted_to_material_request": "Converted observation to material request",
  "material_request.created": "Raised material request",
  "material_request.transitioned": "Updated material request",
  // #280: variation claim module.
  "variation.created": "Raised variation claim",
  "variation.transitioned": "Updated variation claim",
  "observation.converted_to_variation": "Converted observation to variation",
  // #151: scheduled blob backup runs (targetType 'system' groups as Other).
  "backup.completed": "Ran data backup",
  "storage.write_rejected": "Blocked a bad data write",
  // #390: hours / time-entry events (the office approvals pass + worker submits).
  "hours.approved": "Approved hours",
  "hours.rejected": "Rejected hours",
  "hours.reject_undone": "Undid an hours rejection",
  "hours.reopened": "Re-opened hours",
  "hours.bulk_approved": "Bulk-approved hours",
  "hours.bulk_rejected": "Bulk-rejected hours",
  "hours.submitted": "Submitted hours",
  "hours.resubmitted": "Resubmitted hours",
  // #370: daywork register (targetType 'daywork' groups as Other, like time_entry).
  "daywork.created": "Raised daywork docket",
  "daywork.signed": "Signed daywork docket",
  "daywork.transitioned": "Updated daywork docket",
  "daywork.amended": "Amended daywork docket",
  // #371: pre-start readiness gate (targetType 'prestart' groups as Other).
  "readiness.item_ticked": "Updated pre-start checklist",
  "readiness.overridden": "Overrode pre-start readiness",
  "readiness.override_cleared": "Cleared pre-start override",
  // #581: job-creating actions (targetType 'job'/'quote' group as Other).
  "job.created": "Created job",
  "quote.converted": "Converted quote to job",
  // #349: job closeout lifecycle.
  "job.closed": "Closed out job",
  "job.reopened": "Re-opened job",
  // #224: rule-based task generation.
  "job.tasks_generated": "Generated tasks",
  // #219: safety documents.
  "safety_doc.uploaded": "Uploaded a safety document",
  "safety_doc.acknowledged": "Acknowledged a safety document",
  // #231: certificates register.
  "certificate.uploaded": "Uploaded a certificate",
  // #276: RFI register.
  "rfi.created": "Raised RFI",
  "rfi.transitioned": "Updated RFI",
  // #210: site diary (targetType 'diary' groups as Other, like daywork).
  "diary.created": "Wrote a diary entry",
  "diary.amended": "Amended a diary entry",
};

export function actionLabel(action: AuditAction): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * Coarse grouping by surface, for the per-job feed's filter chips. Onboarding
 * verbs (employee/invite) are excluded — they don't carry a jobId so they
 * never appear in the per-job feed; the type is kept here for the row-history
 * paths that DO surface them on a future per-employee view.
 */
export type AuditTargetGroup =
  | "evidence"
  | "snag"
  | "itp"
  | "observation"
  | "material_request"
  | "variation"
  | "other";

export function targetGroup(targetType: AuditTargetType): AuditTargetGroup {
  switch (targetType) {
    case "evidence":
      return "evidence";
    case "snag":
      return "snag";
    case "itp_template":
    case "itp_instance":
      return "itp";
    case "observation":
      return "observation";
    case "material_request":
      return "material_request";
    case "variation":
      return "variation";
    // #210: diary entries group as Other (like daywork / time_entry / prestart)
    // — they surface in the per-job feed but don't get their own filter chip.
    case "diary":
      return "other";
    default:
      return "other";
  }
}

const GROUP_LABELS: Record<AuditTargetGroup, string> = {
  evidence: "Evidence",
  snag: "Snags",
  itp: "ITPs",
  observation: "Observations",
  material_request: "Material requests",
  variation: "Variations",
  other: "Other",
};

export function groupLabel(group: AuditTargetGroup): string {
  return GROUP_LABELS[group];
}

/**
 * Per-job feed summary: counts by group, for the filter strip. Pure.
 */
export interface JobActivitySummary {
  total: number;
  evidence: number;
  snag: number;
  itp: number;
  observation: number;
  material_request: number;
  variation: number;
  other: number;
}

export function summariseJobActivity(
  entries: ReadonlyArray<AuditLogEntry>
): JobActivitySummary {
  const s: JobActivitySummary = {
    total: entries.length,
    evidence: 0,
    snag: 0,
    itp: 0,
    observation: 0,
    material_request: 0,
    variation: 0,
    other: 0,
  };
  for (const e of entries) {
    s[targetGroup(e.targetType)] += 1;
  }
  return s;
}
