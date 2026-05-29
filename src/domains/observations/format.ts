import type { StatusTone } from "@/components/ui/StatusChip";
import type {
  ObservationConvertTarget,
  ObservationPriority,
  ObservationSource,
  ObservationStatus,
  ObservationType,
} from "./types";

/**
 * Display formatting for the observations domain — admin/office-facing
 * labels and the semantic StatusChip tone for each enum value. Worker-facing
 * capture labels live in service.ts (WORKER_CAPTURE_OPTIONS) instead.
 *
 * Cross-ref: src/domains/snags/format.ts — precedent.
 */

const TYPE_LABELS: Record<ObservationType, string> = {
  note: "Note",
  blocker: "Blocker",
  rfi: "Question (RFI)",
  variation: "Variation",
  defect: "Defect",
  safety: "Safety",
  material_request: "Material request",
  plan_mismatch: "Plan mismatch",
  client_instruction: "Client instruction",
  evidence: "Evidence",
};

export function typeLabel(type: ObservationType): string {
  return TYPE_LABELS[type] ?? type;
}

const STATUS_LABELS: Record<ObservationStatus, string> = {
  new: "New",
  needs_action: "Needs action",
  in_review: "In review",
  converted: "Converted",
  resolved: "Resolved",
  record_only: "Record only",
};

export function statusLabel(status: ObservationStatus): string {
  return STATUS_LABELS[status] ?? status;
}

const STATUS_TONES: Record<ObservationStatus, StatusTone> = {
  new: "info",
  needs_action: "warning",
  in_review: "navy",
  converted: "info",
  resolved: "success",
  record_only: "neutral",
};

export function statusTone(status: ObservationStatus): StatusTone {
  return STATUS_TONES[status] ?? "neutral";
}

const PRIORITY_LABELS: Record<ObservationPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export function priorityLabel(priority: ObservationPriority): string {
  return PRIORITY_LABELS[priority] ?? priority;
}

const PRIORITY_TONES: Record<ObservationPriority, StatusTone> = {
  urgent: "danger",
  high: "warning",
  normal: "neutral",
  low: "neutral",
};

export function priorityTone(priority: ObservationPriority): StatusTone {
  return PRIORITY_TONES[priority] ?? "neutral";
}

const SOURCE_LABELS: Record<ObservationSource, string> = {
  phil: "Phil (field)",
  buhlos: "BuhlOS (office)",
  system: "System",
};

export function sourceLabel(source: ObservationSource): string {
  return SOURCE_LABELS[source] ?? source;
}

const CONVERT_TARGET_LABELS: Record<ObservationConvertTarget, string> = {
  rfi: "RFI",
  variation: "Variation",
  defect: "Defect",
  snag: "Snag",
  material_request: "Material request",
  task: "Task",
};

export function convertTargetLabel(target: ObservationConvertTarget): string {
  return CONVERT_TARGET_LABELS[target] ?? target;
}
