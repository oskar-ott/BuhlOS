import type { ExceptionActionState, ExceptionSeverity, ExceptionSource } from "./types";

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

/**
 * Per-action-state badge: a short label + tone + whether the action is
 * clickable. Lets the inbox make "exact vs fallback vs not-built vs future"
 * visually distinct and honest at a glance. Single source of truth (UI + tests).
 */
export const ACTION_STATE_BADGE: Record<
  ExceptionActionState,
  { label: string; tone: PillTone; clickable: boolean }
> = {
  available: { label: "Exact action", tone: "success", clickable: true },
  fallback: { label: "Fallback", tone: "warning", clickable: true },
  unavailable: { label: "Not built", tone: "neutral", clickable: false },
  future: { label: "Future", tone: "neutral", clickable: false },
};
