import type { VariationApprovalStatus, WorkAtRiskReason } from "./types";

/** Display helpers for the variation/daywork approval workflow — pure, no
 *  state. Site language (P11): plain words an admin and a builder both read. */

export function variationApprovalStatusLabel(status: VariationApprovalStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "sent_to_builder":
      return "Sent to builder";
    case "approved":
      return "Approved";
    case "released_for_work":
      return "Released for work";
    case "work_at_risk":
      return "Work at risk";
    case "completed":
      return "Completed";
    case "claimed":
      return "Claimed";
    case "invoiced":
      return "Invoiced";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    case "disputed":
      return "Disputed";
  }
}

export function workAtRiskReasonLabel(reason: WorkAtRiskReason): string {
  switch (reason) {
    case "builder_verbal_instruction":
      return "Builder verbal instruction";
    case "boss_internal_approval":
      return "Boss / internal approval";
    case "emergency_safety":
      return "Emergency / safety";
    case "programme_delay_risk":
      return "Programme delay risk";
    case "other":
      return "Other";
  }
}
