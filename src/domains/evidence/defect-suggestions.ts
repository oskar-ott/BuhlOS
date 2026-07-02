/**
 * #267 — snag suggestions from defect photos. PURE PROJECTION, no state
 * machine: a suggestion exists exactly when the classification layer (#262)
 * says "possible-defect" confidently AND no human has already dealt with it.
 *
 * The suggestion has NO write path of its own — accepting routes through the
 * EXISTING snag creation (POST /api/snags with evidenceIds), dismissing stamps
 * a sticky record on the evidence row. No snag ever exists without an explicit
 * human accept; a wrong suggestion costs one dismissal tap.
 */

import {
  POSSIBLE_DEFECT_CONFIDENCE_MIN,
  type EvidenceLabelEntry,
  type LabelledEvidence,
} from "./labels";

export const DEFECT_LABEL = "possible-defect";

/** The sticky per-photo dismissal record (additive evidence-row field). */
export interface DefectSuggestionDismissal {
  at: string;
  byId: string | null;
  byName: string | null;
  label: string;
  /** the suggestion's confidence at dismissal time — precision is measurable */
  confidence: number | null;
  modelVersion: string | null;
}

export interface DefectSuggestionEvidence extends LabelledEvidence {
  id: string;
  kind?: string | null;
  status?: string | null;
  jobId?: string | null;
  defectSuggestionDismissed?: DefectSuggestionDismissal | null;
}

/** The slice of a snag row the projection needs. */
export interface SnagEvidenceLink {
  id: string;
  evidenceIds?: string[] | null;
  status?: string | null;
}

export type DefectSuggestionState =
  | { state: "suggested"; label: EvidenceLabelEntry }
  | { state: "dismissed"; dismissal: DefectSuggestionDismissal }
  | { state: "linked"; snagIds: string[] }
  | { state: "none" };

/** The defect entry that qualifies a photo, or null. A human-confirmed or
 *  accepted defect label qualifies at ANY confidence (a human said so); an
 *  unreviewed AI suggestion needs the conservative floor. Rejected never
 *  qualifies — a human corrected the label away, so the suggestion dies. */
export function qualifyingDefectLabel(item: DefectSuggestionEvidence): EvidenceLabelEntry | null {
  const entries = Array.isArray(item.labels) ? item.labels : [];
  let best: EvidenceLabelEntry | null = null;
  for (const e of entries) {
    if (!e || e.label !== DEFECT_LABEL || e.status === "rejected") continue;
    if (e.status === "confirmed" || e.status === "accepted") return e;
    const confidence = typeof e.confidence === "number" ? e.confidence : null;
    if (confidence !== null && confidence >= POSSIBLE_DEFECT_CONFIDENCE_MIN) {
      if (!best || (best.confidence ?? 0) < confidence) best = e;
    }
  }
  return best;
}

/**
 * Project the suggestion state for one photo.
 *   linked    — a snag already carries this photo (existing-link state wins;
 *               no fresh suggestion for a photo that already spawned work)
 *   dismissed — a human flicked it away; sticky, never resurfaces
 *   suggested — confident possible-defect, nothing done about it yet
 *   none      — everything else (incl. rejected evidence rows: rejected
 *               evidence suggests nothing)
 */
export function defectSuggestionFor(
  item: DefectSuggestionEvidence,
  snags: SnagEvidenceLink[]
): DefectSuggestionState {
  const snagIds = (snags || [])
    .filter((s) => s && Array.isArray(s.evidenceIds) && s.evidenceIds.includes(item.id))
    .map((s) => s.id);
  if (snagIds.length > 0) return { state: "linked", snagIds };

  if (item.kind !== "photo") return { state: "none" };
  if (item.status === "rejected") return { state: "none" };

  if (item.defectSuggestionDismissed) {
    return { state: "dismissed", dismissal: item.defectSuggestionDismissed };
  }

  const label = qualifyingDefectLabel(item);
  if (!label) return { state: "none" };
  return { state: "suggested", label };
}

/** Prefill for the existing snag-create path — human edits before save. */
export function snagPrefillFor(
  item: DefectSuggestionEvidence & {
    areaId?: string | null;
    stage?: string | null;
    taskId?: string | null;
    note?: string | null;
  },
  label: EvidenceLabelEntry
): {
  title: string;
  description: string;
  areaId: string | null;
  stage: string | null;
  taskId: string | null;
  evidenceIds: string[];
} {
  const pct = typeof label.confidence === "number" ? Math.round(label.confidence * 100) : null;
  const originNote =
    label.source === "human"
      ? "Raised from a photo a human labelled possible-defect."
      : `Raised from a photo the AI classifier labelled possible-defect${pct !== null ? ` (confidence ${pct}%)` : ""}.`;
  return {
    title: "Possible defect in site photo",
    description: [originNote, item.note ? `Photo note: ${item.note}` : null]
      .filter(Boolean)
      .join("\n"),
    areaId: item.areaId ?? null,
    stage: item.stage ?? null,
    taskId: item.taskId ?? null,
    evidenceIds: [item.id],
  };
}
