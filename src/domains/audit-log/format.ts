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
  "evidence.captured": "Captured evidence",
  "evidence.reviewed": "Reviewed evidence",
  "evidence.rejected": "Rejected evidence",
  "evidence.unreviewed": "Re-opened evidence review",
  "snag.created": "Raised snag",
  "snag.transitioned": "Moved snag",
  "itp.attached": "Attached ITP",
  "itp.point.recorded": "Recorded ITP point",
  "itp.signed_off": "Signed off ITP",
  "itp.reopened": "Re-opened ITP",
  "itp.archived": "Archived ITP",
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
export type AuditTargetGroup = "evidence" | "snag" | "itp" | "observation" | "other";

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
    default:
      return "other";
  }
}

const GROUP_LABELS: Record<AuditTargetGroup, string> = {
  evidence: "Evidence",
  snag: "Snags",
  itp: "ITPs",
  observation: "Observations",
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
    other: 0,
  };
  for (const e of entries) {
    s[targetGroup(e.targetType)] += 1;
  }
  return s;
}
