/**
 * AI photo labels — typed client mirror + display rules (#262).
 *
 * The server authority is api/_lib/photo-labels.js (taxonomy whitelist,
 * merge + correction rules). This module re-declares the constants for typed
 * UI use — a sync test in labels.test.ts keeps the two identical (audit-log
 * enum precedent) — and owns the DISPLAY contract:
 *
 *   - human `confirmed` + AI `accepted` entries render as solid chips
 *   - AI `suggested` entries render as visually-tentative chips, and only at
 *     or above LABEL_CONFIDENCE_DISPLAY_MIN — no confident-looking wrong
 *     answers below the floor
 *   - `rejected` entries never render (they exist for stickiness + eval)
 *   - no labels is a NORMAL state, never spoofed
 */

export const PHOTO_LABEL_TAXONOMY = [
  "switchboard",
  "rough-in",
  "fit-off",
  "cable-tray",
  "containment",
  "outlet",
  "lighting",
  "data-comms",
  "possible-defect",
  "progress",
  "materials",
  "equipment",
] as const;

export type PhotoLabel = (typeof PHOTO_LABEL_TAXONOMY)[number];

export const LABEL_CONFIDENCE_DISPLAY_MIN = 0.5;
export const POSSIBLE_DEFECT_CONFIDENCE_MIN = 0.75;

export interface EvidenceLabelEntry {
  label: string;
  source: "ai" | "human";
  status: "suggested" | "accepted" | "rejected" | "confirmed";
  confidence?: number | null;
  modelVersion?: string | null;
  promptVersion?: string | null;
  at: string;
  byId?: string | null;
  byName?: string | null;
  reviewedById?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
}

export interface AiLabelRun {
  modelVersion: string;
  promptVersion: string;
  at: string;
  labelCount: number;
}

/** The additive fields #262 puts on an evidence row (passthrough-safe). */
export interface LabelledEvidence {
  labels?: EvidenceLabelEntry[] | null;
  aiLabelRuns?: AiLabelRun[] | null;
}

export interface VisibleLabel {
  label: string;
  /** true = unreviewed AI suggestion (render tentative, offer accept/remove) */
  tentative: boolean;
  confidence: number | null;
  source: "ai" | "human";
}

/** The labels a surface should show for a row, dedup'd, human/accepted first. */
export function visibleLabels(item: LabelledEvidence): VisibleLabel[] {
  const entries = Array.isArray(item.labels) ? item.labels : [];
  const confirmed: VisibleLabel[] = [];
  const tentative: VisibleLabel[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e || !e.label || e.status === "rejected" || seen.has(e.label)) continue;
    if (e.status === "confirmed" || e.status === "accepted") {
      confirmed.push({
        label: e.label,
        tentative: false,
        confidence: typeof e.confidence === "number" ? e.confidence : null,
        source: e.source,
      });
      seen.add(e.label);
    } else if (e.status === "suggested") {
      const confidence = typeof e.confidence === "number" ? e.confidence : null;
      if (confidence === null || confidence < LABEL_CONFIDENCE_DISPLAY_MIN) continue;
      tentative.push({ label: e.label, tentative: true, confidence, source: e.source });
      seen.add(e.label);
    }
  }
  return [...confirmed, ...tentative];
}

/** No visible labels — filterable as its own honest state. */
export function isUnlabelled(item: LabelledEvidence): boolean {
  return visibleLabels(item).length === 0;
}

/** Does the row carry a given visible label? (filter predicate) */
export function hasVisibleLabel(item: LabelledEvidence, label: string): boolean {
  return visibleLabels(item).some((l) => l.label === label);
}

/** Photo rows an admin can still classify at the given modelVersion. */
export function needsClassification(
  item: LabelledEvidence & { kind?: string | null },
  modelVersion: string
): boolean {
  if (item.kind !== "photo") return false;
  const runs = Array.isArray(item.aiLabelRuns) ? item.aiLabelRuns : [];
  return !runs.some((r) => r && r.modelVersion === modelVersion);
}
