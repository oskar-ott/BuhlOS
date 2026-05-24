import type { EvidenceKind, EvidenceStage, EvidenceStatus } from "./types";

/**
 * Pure display helpers for the evidence domain. Kept separate from the
 * client + schema + service layers so they can be imported by both
 * server and client components without dragging fetch / zod runtime cost.
 *
 * Status pill tones map to the 5-tone palette in doc 27 §6.2:
 *   uploading    → info     (client-only — "Uploading…")
 *   pending_sync → info     (client-only — "Pending sync")
 *   submitted    → info     (server received; awaiting review)
 *   reviewed     → success  (admin approved)
 *   rejected     → danger   (admin rejected with reason)
 *
 * Cross-ref:
 *   docs/rebuild-audit/27-interface-usability-pass.md §6.2
 *   docs/rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md §B.5
 *   src/domains/timesheets/format.ts — precedent
 *   src/domains/jobs/format.ts — precedent
 */

const STATUS_LABELS: Record<EvidenceStatus, string> = {
  uploading: "Uploading…",
  pending_sync: "Pending sync",
  submitted: "Submitted",
  reviewed: "Reviewed",
  rejected: "Rejected",
};

export function statusLabel(status: EvidenceStatus): string {
  return STATUS_LABELS[status];
}

export type EvidenceStatusTone = "info" | "success" | "danger";

export function statusTone(status: EvidenceStatus): EvidenceStatusTone {
  switch (status) {
    case "uploading":
    case "pending_sync":
    case "submitted":
      return "info";
    case "reviewed":
      return "success";
    case "rejected":
      return "danger";
  }
}

const KIND_LABELS: Record<EvidenceKind, string> = {
  photo: "Photo",
  note: "Note",
};

export function kindLabel(kind: EvidenceKind): string {
  return KIND_LABELS[kind];
}

const STAGE_LABELS: Record<EvidenceStage, string> = {
  roughIn: "Rough-in",
  fitOff: "Fit-off",
};

export function stageLabel(stage: EvidenceStage): string {
  return STAGE_LABELS[stage];
}
