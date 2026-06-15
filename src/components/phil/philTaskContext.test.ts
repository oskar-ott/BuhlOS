import { describe, expect, it } from "vitest";
import { buildAreaTaskContext } from "./philTaskContext";
import type { EvidenceLink, WorkPackage } from "@/domains/job-control/types";

/**
 * The boundary adapter feeds the Phil task list from the job-control model. It
 * must (a) be honest-empty today — the Phil job fetch carries no compiled work
 * packages, so the map is empty and every task renders as it does now; and
 * (b) when work-package data IS present, key only the matching tasks and carry
 * the model's evidence `met` truth (a real EvidenceLink), never a count.
 */

const WP: WorkPackage = {
  id: "wp_1",
  jobId: "job-1",
  title: "East Gym — ZIP tap & dedicated 20A circuit",
  scopeClauseIds: [],
  boqLineRefs: [],
  taskRefs: [{ areaId: "a1", stage: "roughIn", taskId: "t1" }],
  order: 0,
  scopeNote: "Run a dedicated 20A circuit to the ZIP tap.",
  governingDocRefs: [{ documentId: "doc1", label: "E-101" }],
  materials: [{ label: "20A DGPO", qty: 1, unit: "ea" }],
  requiredEvidence: [{ id: "re1", label: "Photo of the board", kind: "photo" }],
  warnings: [{ id: "w1", kind: "variation_trigger", text: "PL3 pendants — confirm first" }],
};

describe("buildAreaTaskContext", () => {
  it("returns an EMPTY map when no work packages are supplied (today's reality)", () => {
    const map = buildAreaTaskContext({
      areaId: "a1",
      stage: "roughIn",
      taskIds: ["t1", "t2"],
    });
    expect(map.size).toBe(0);
  });

  it("keys only tasks a package delivers; others render plainly", () => {
    const map = buildAreaTaskContext({
      areaId: "a1",
      stage: "roughIn",
      taskIds: ["t1", "t2"],
      workPackages: [WP],
    });
    expect(map.has("t1")).toBe(true);
    expect(map.has("t2")).toBe(false);

    const ctx = map.get("t1")!;
    expect(ctx.isEmpty).toBe(false);
    expect(ctx.scopeNote).toBe("Run a dedicated 20A circuit to the ZIP tap.");
    expect(ctx.requiredEvidence).toHaveLength(1);
  });

  it("does not match a package when the area/stage coordinate differs", () => {
    const fitOff = buildAreaTaskContext({
      areaId: "a1",
      stage: "fitOff", // WP delivers t1 at roughIn only
      taskIds: ["t1"],
      workPackages: [WP],
    });
    expect(fitOff.has("t1")).toBe(false);
  });

  it("marks required evidence met ONLY from a real EvidenceLink, never a count", () => {
    // No links → unmet.
    const unmet = buildAreaTaskContext({
      areaId: "a1",
      stage: "roughIn",
      taskIds: ["t1"],
      workPackages: [WP],
    }).get("t1")!;
    expect(unmet.requiredEvidence[0]!.met).toBe(false);

    // A link naming the requirement + package + real proof → met.
    const link: EvidenceLink = {
      id: "el_1",
      jobId: "job-1",
      evidenceId: "ev1",
      workPackageId: "wp_1",
      requiredEvidenceId: "re1",
      role: "progress",
    };
    const met = buildAreaTaskContext({
      areaId: "a1",
      stage: "roughIn",
      taskIds: ["t1"],
      workPackages: [WP],
      evidenceLinks: [link],
    }).get("t1")!;
    expect(met.requiredEvidence[0]!.met).toBe(true);
  });
});
