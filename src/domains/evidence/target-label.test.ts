import { describe, expect, it } from "vitest";
import { resolveEvidenceTargetLabel } from "./target-label";
import type { Job } from "@/domains/jobs/types";

const job = {
  id: "j1",
  areaGroups: [
    {
      id: "g1",
      name: "Ground",
      areas: [
        { id: "a1", name: "Kitchen" }, // no override → job-level checklist
        { id: "a2", name: "Garage", roughInTasks: [{ id: "t_area", name: "Garage rough" }] }, // override
      ],
    },
  ],
  roughInTasks: [{ id: "t1", name: "Pull power" }],
  fitOffTasks: [{ id: "tf", name: "Fit GPOs" }],
} as unknown as Job;

describe("resolveEvidenceTargetLabel (#515)", () => {
  it("resolves area + task ids to the names the boss authored", () => {
    expect(resolveEvidenceTargetLabel(job, { stage: "roughIn", areaId: "a1", taskId: "t1" })).toBe(
      "Rough-in · Area Kitchen · Task Pull power",
    );
  });

  it("uses the area-level task override (effectiveTasks)", () => {
    expect(resolveEvidenceTargetLabel(job, { stage: "roughIn", areaId: "a2", taskId: "t_area" })).toBe(
      "Rough-in · Area Garage · Task Garage rough",
    );
  });

  it("fit-off resolves from the fit-off checklist", () => {
    expect(resolveEvidenceTargetLabel(job, { stage: "fitOff", taskId: "tf" })).toBe("Fit-off · Task Fit GPOs");
  });

  it("falls back to the raw area id when the area is unknown (no crash, no blank)", () => {
    expect(resolveEvidenceTargetLabel(job, { stage: "roughIn", areaId: "ghost", taskId: "t1" })).toContain(
      "Area ghost",
    );
  });

  it("falls back to the raw task id when the task is unknown", () => {
    expect(resolveEvidenceTargetLabel(job, { stage: "roughIn", areaId: "a1", taskId: "nope" })).toContain(
      "Task nope",
    );
  });

  it("returns an empty string for an unattached capture (parent renders 'Unattached')", () => {
    expect(resolveEvidenceTargetLabel(job, {})).toBe("");
  });
});
