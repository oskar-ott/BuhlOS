import { describe, expect, it } from "vitest";
import {
  DEFECT_LABEL,
  defectSuggestionFor,
  qualifyingDefectLabel,
  snagPrefillFor,
  type DefectSuggestionEvidence,
} from "./defect-suggestions";
import { POSSIBLE_DEFECT_CONFIDENCE_MIN, type EvidenceLabelEntry } from "./labels";

/**
 * #267 — the suggestion is a PURE projection over #262 labels + the sticky
 * dismissal record + existing snag links. The matrix here is the AC list:
 * threshold boundary, dismissed, human-corrected-away, already-linked,
 * rejected-evidence exclusion — and the no-write guarantee is structural
 * (the projection module has no write path to have).
 */

const defect = (over: Partial<EvidenceLabelEntry> = {}): EvidenceLabelEntry => ({
  label: DEFECT_LABEL,
  source: "ai",
  status: "suggested",
  confidence: 0.8,
  modelVersion: "m1",
  promptVersion: "photo-labels-v1",
  at: "2026-07-02T10:00:00.000Z",
  ...over,
});

type PhotoOver = Partial<
  DefectSuggestionEvidence & { areaId: string; stage: string; taskId: string; note: string }
>;
const photo = (over: PhotoOver = {}): DefectSuggestionEvidence & PhotoOver => ({
  id: "ev_1",
  kind: "photo",
  status: "submitted",
  labels: [defect()],
  ...over,
});

describe("qualifyingDefectLabel", () => {
  it("qualifies an AI suggestion at/above the conservative floor only", () => {
    expect(qualifyingDefectLabel(photo({ labels: [defect({ confidence: POSSIBLE_DEFECT_CONFIDENCE_MIN })] }))).toBeTruthy();
    expect(qualifyingDefectLabel(photo({ labels: [defect({ confidence: 0.74 })] }))).toBeNull();
  });

  it("a human-confirmed or accepted defect qualifies at any confidence", () => {
    expect(
      qualifyingDefectLabel(
        photo({ labels: [defect({ source: "human", status: "confirmed", confidence: null })] })
      )
    ).toBeTruthy();
    expect(qualifyingDefectLabel(photo({ labels: [defect({ status: "accepted", confidence: 0.6 })] }))).toBeTruthy();
  });

  it("dies when a human corrected the label away (rejected)", () => {
    expect(qualifyingDefectLabel(photo({ labels: [defect({ status: "rejected" })] }))).toBeNull();
  });

  it("other labels never qualify", () => {
    expect(
      qualifyingDefectLabel(photo({ labels: [defect({ label: "switchboard", confidence: 0.99 })] }))
    ).toBeNull();
  });
});

describe("defectSuggestionFor", () => {
  it("suggests on a confident unhandled defect photo", () => {
    const s = defectSuggestionFor(photo(), []);
    expect(s.state).toBe("suggested");
  });

  it("existing snag link wins over everything — no fresh suggestion", () => {
    const s = defectSuggestionFor(photo(), [
      { id: "sn_1", evidenceIds: ["ev_1"] },
      { id: "sn_2", evidenceIds: ["ev_other"] },
    ]);
    expect(s).toEqual({ state: "linked", snagIds: ["sn_1"] });
  });

  it("dismissal is sticky and survives reclassification", () => {
    const dismissal = {
      at: "2026-07-02T11:00:00.000Z",
      byId: "u1",
      byName: "Boss",
      label: DEFECT_LABEL,
      confidence: 0.8,
      modelVersion: "m1",
    };
    const s = defectSuggestionFor(photo({ defectSuggestionDismissed: dismissal }), []);
    expect(s).toEqual({ state: "dismissed", dismissal });
  });

  it("rejected evidence suggests nothing", () => {
    expect(defectSuggestionFor(photo({ status: "rejected" }), []).state).toBe("none");
  });

  it("notes and unlabelled photos suggest nothing", () => {
    expect(defectSuggestionFor(photo({ kind: "note" }), []).state).toBe("none");
    expect(defectSuggestionFor(photo({ labels: [] }), []).state).toBe("none");
    expect(defectSuggestionFor(photo({ labels: undefined }), []).state).toBe("none");
  });
});

describe("snagPrefillFor", () => {
  it("prefills through the existing snag-create shape with the photo linked", () => {
    const item = photo({ areaId: "a1", stage: "roughIn", taskId: "t1", note: "conduit crushed" });
    const label = defect({ confidence: 0.82 });
    const prefill = snagPrefillFor(item, label);
    expect(prefill).toMatchObject({
      areaId: "a1",
      stage: "roughIn",
      taskId: "t1",
      evidenceIds: ["ev_1"],
    });
    expect(prefill.title.length).toBeGreaterThan(0);
    // Provenance is in the description: AI origin + confidence, honest.
    expect(prefill.description).toContain("AI classifier");
    expect(prefill.description).toContain("82%");
    expect(prefill.description).toContain("conduit crushed");
  });

  it("names a human origin when the qualifying label is human-owned", () => {
    const prefill = snagPrefillFor(photo(), defect({ source: "human", status: "confirmed", confidence: null }));
    expect(prefill.description).toContain("human labelled");
    expect(prefill.description).not.toContain("confidence");
  });
});
