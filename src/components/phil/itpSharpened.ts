import { isPointApplicable } from "@/domains/itp/applicability";
import { formatProgress } from "@/domains/itp/format";
import type { ITPInstance, ITPTemplatePoint } from "@/domains/itp/types";

/**
 * Pure projections for the sharpened Checks/ITP detail (phil_sharpened,
 * dark — Wave 4a of the field-surface redesign; prompt §2.8).
 *
 * Everything here is derived from the REAL instance model — the
 * pending → in-progress → witnessed → signed-off machine in
 * src/domains/itp/service.ts and the photo/value/signoff/note point
 * kinds in the attach-time snapshot. Nothing is invented (P7):
 *
 *   - The sign-off chain has exactly the stations the model has:
 *     recording on site → the explicit submit-for-review handoff
 *     (status 'witnessed') → office sign-off (status 'signed-off',
 *     stamped signedOffBy). There is NO named witness station on an
 *     instance — witnessing exists only as a per-point `witnessRole`
 *     on signoff-type points, which the point cards already gate — so
 *     the prototype's "Witness Dave" station is deliberately absent.
 *   - "Required proof" is the real proof-kind split the snapshot
 *     carries: value points (readings, with unit + recorded value) and
 *     photo-bearing points (photo-type + `evidenceRequired`). When a
 *     template has neither, the section is absent — the points list is
 *     the whole story and no taxonomy is fabricated.
 *   - The owed line mirrors the ACTUAL submit gate
 *     (canSubmitForReview → required applicable points recorded); it
 *     never claims a photo or snag blocks sign-off when the server
 *     wouldn't.
 *
 * Cross-ref:
 *   src/components/phil/PhilItpSharpened.tsx — consumer (NB: this file is deliberately NOT named philItpSharpened — that base name collides with the component on a case-insensitive FS)
 *   src/domains/itp/format.ts — formatProgress (the one done/total rule)
 *   src/domains/itp/service.ts — state machine + canSubmitForReview
 */

/* ---------------------------------------------------------------------
 * Applicable points — the same filter ITPRecording.visiblePoints uses
 * -------------------------------------------------------------------*/

/** Non-archived, applicability-filtered snapshot points in render order. */
export function itpApplicablePoints(
  instance: ITPInstance,
): ITPTemplatePoint[] {
  const ctx = { scope: instance.scope };
  return (instance.templateSnapshot?.points ?? [])
    .filter((p) => !p.archived && isPointApplicable(p, ctx))
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/* ---------------------------------------------------------------------
 * Sign-off chain — the three REAL stations
 * -------------------------------------------------------------------*/

export type ItpStationState = "done" | "current" | "pending";

export interface ItpStation {
  key: "recorded" | "submitted" | "signoff";
  /** Short station word (site voice). */
  label: string;
  /** Second line — a role word or the real signer's name. Never invented. */
  sub: string;
  state: ItpStationState;
}

/**
 * Derive the chain from status + real progress:
 *   recorded  — done once every required point is recorded (or the
 *               instance has moved past recording); current before that.
 *   submitted — the explicit in-progress → witnessed handoff.
 *   signoff   — office's step; shows the real signedOffBy name once
 *               signed, the role word "office" before.
 */
export function itpStations(instance: ITPInstance): ItpStation[] {
  const progress = formatProgress(instance);
  const recordingDone = progress.total > 0 && progress.done >= progress.total;
  const submitted =
    instance.status === "witnessed" || instance.status === "signed-off";
  const signedOff = instance.status === "signed-off";

  return [
    {
      key: "recorded",
      label: "Recorded",
      sub: "on site",
      state: submitted || recordingDone ? "done" : "current",
    },
    {
      key: "submitted",
      label: "Submitted",
      sub: "for review",
      state: submitted ? "done" : recordingDone ? "current" : "pending",
    },
    {
      key: "signoff",
      label: "Signed off",
      sub:
        signedOff && instance.signedOffBy?.trim()
          ? instance.signedOffBy.trim()
          : "office",
      state: signedOff
        ? "done"
        : instance.status === "witnessed"
          ? "current"
          : "pending",
    },
  ];
}

/* ---------------------------------------------------------------------
 * Required proof — the real proof-kind projection
 * -------------------------------------------------------------------*/

export interface ItpProofSummary {
  /** Value-type points, render order — readings with unit + recorded value. */
  readings: ITPTemplatePoint[];
  /** Photo-bearing points (photo-type or evidenceRequired): real attached
   *  count over the total. Null when the snapshot has none. */
  photos: { attached: number; total: number } | null;
}

/**
 * Null when the snapshot genuinely doesn't distinguish proof-type points
 * (no value points, no photo-type points, no evidenceRequired flags) —
 * the section then folds into the points list rather than fabricating a
 * taxonomy.
 */
export function itpProofSummary(instance: ITPInstance): ItpProofSummary | null {
  const points = itpApplicablePoints(instance);
  const readings = points.filter((p) => p.type === "value");
  const photoPoints = points.filter(
    (p) => p.type === "photo" || p.evidenceRequired === true,
  );
  if (readings.length === 0 && photoPoints.length === 0) return null;

  let attached = 0;
  for (const p of photoPoints) {
    const r = instance.results?.[p.id];
    if (r && typeof r.photoUrl === "string" && r.photoUrl.trim() !== "") {
      attached += 1;
    }
  }
  return {
    readings,
    photos:
      photoPoints.length > 0
        ? { attached, total: photoPoints.length }
        : null,
  };
}

/* ---------------------------------------------------------------------
 * The honest "still owed" line under the sticky primary
 * -------------------------------------------------------------------*/

/**
 * What still stands between the worker and "send it to the office".
 * Mirrors the real submit gate (required applicable points recorded);
 * the photo clause counts only unrecorded required points that need a
 * photo to be recordable (photo-type / evidenceRequired) — a true
 * subset of the owed points, never an extra invented obligation.
 */
export function itpOwedLine(instance: ITPInstance): string {
  const progress = formatProgress(instance);
  if (progress.total === 0) {
    return "No required points on this check — ask your PM.";
  }
  const remaining = progress.total - progress.done;
  if (remaining <= 0) {
    return "All points recorded — send it to the office for sign-off.";
  }
  const points = itpApplicablePoints(instance);
  const results = instance.results ?? {};
  const photosOwed = points.filter(
    (p) =>
      p.required !== false &&
      (p.type === "photo" || p.evidenceRequired === true) &&
      !results[p.id]?.at,
  ).length;
  const pointWord = remaining === 1 ? "point" : "points";
  const base = `${remaining} ${pointWord} still to record`;
  if (photosOwed > 0) {
    return `${base} — ${photosOwed} ${photosOwed === 1 ? "needs" : "need"} a photo`;
  }
  return base;
}
