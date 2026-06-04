import type { ExceptionSeverity, ExceptionSource } from "./types";

/**
 * Shared presentation labels/tones for the exceptions projection — used by both
 * the projection (so group headers + the model carry a stable `sourceLabel`) and
 * the inbox UI (badges). Centralised + pure so labels stay consistent and
 * testable. `tone` values are the `Pill` palette (src/components/ui/Pill.tsx).
 */

export const SOURCE_LABEL: Record<ExceptionSource, string> = {
  hours: "Hours",
  observation: "Observation",
  evidence: "Evidence",
  snag: "Snags",
  itp: "ITP",
  job: "Jobs",
  material: "Materials",
  planMarkup: "Plan markup",
  gear: "Gear",
};

export type PillTone = "neutral" | "yellow" | "navy" | "success" | "danger" | "info" | "warning";

export const SOURCE_TONE: Record<ExceptionSource, PillTone> = {
  hours: "info",
  observation: "warning",
  evidence: "info",
  snag: "warning",
  itp: "info",
  job: "navy",
  material: "warning",
  planMarkup: "neutral",
  gear: "neutral",
};

export const SEVERITY_LABEL: Record<ExceptionSeverity, string> = {
  critical: "Critical",
  warning: "Action",
  info: "Info",
};

export const SEVERITY_TONE: Record<ExceptionSeverity, PillTone> = {
  critical: "danger",
  warning: "warning",
  info: "info",
};

export function sourceLabel(source: ExceptionSource): string {
  return SOURCE_LABEL[source] ?? source;
}
