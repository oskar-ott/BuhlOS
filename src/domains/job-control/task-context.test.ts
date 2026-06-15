import { describe, it, expect } from "vitest";
import { WorkPackageSchema, EvidenceLinkSchema } from "./schema";
import type { TaskRef } from "./types";
import {
  workPackageForTask,
  buildPhilTaskContext,
  classifyTaskWarnings,
  unmetRequiredEvidenceCount,
} from "./task-context";

const TASK: TaskRef = { areaId: "area_east_gym", stage: "fitOff", taskId: "task_zip" };

/** A fully-compiled East Gym package delivering TASK, with provenance. */
function compiledPackage() {
  return WorkPackageSchema.parse({
    id: "wp_east_gym",
    jobId: "job_100arthur",
    title: "East Gym",
    scopeClauseIds: ["sw_zip"],
    taskRefs: [TASK],
    scopeNote: "Run the dedicated 20A ZIP circuit from the new sub-board.",
    governingDocRefs: [{ documentId: "doc_F10", label: "F10 power layout" }],
    materials: [{ label: "20A RCBO", qty: 1, unit: "ea" }],
    requiredEvidence: [
      { id: "re_test", label: "Circuit test result", kind: "test_result" },
      { id: "re_photo", label: "Photo of labelled board", kind: "photo" },
    ],
    warnings: [
      { id: "warn_av", kind: "by_others", text: "A/V hardware by others — cabling only", scopeClauseId: "sw_av" },
      { id: "warn_var", kind: "variation_trigger", text: "Extra circuit? Flag a variation first." },
    ],
    order: 0,
  });
}

/** A package that owns the task but carries no compiled provenance. */
function barePackage() {
  return WorkPackageSchema.parse({
    id: "wp_bare",
    jobId: "j",
    title: "Bare",
    taskRefs: [TASK],
  });
}

describe("workPackageForTask", () => {
  it("finds the package that owns a task coordinate", () => {
    expect(workPackageForTask([compiledPackage()], TASK)?.id).toBe("wp_east_gym");
  });
  it("returns null when no package owns the task", () => {
    expect(workPackageForTask([compiledPackage()], { ...TASK, taskId: "other" })).toBeNull();
  });
});

describe("buildPhilTaskContext — zero regression (P10)", () => {
  it("a task with no package → honest empty context", () => {
    const ctx = buildPhilTaskContext({ workPackages: [compiledPackage()], task: { ...TASK, taskId: "x" } });
    expect(ctx.isEmpty).toBe(true);
    expect(ctx.workPackageId).toBeNull();
    expect(ctx.requiredEvidence).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });
  it("an un-compiled package (no provenance) → empty context but package known", () => {
    const ctx = buildPhilTaskContext({ workPackages: [barePackage()], task: TASK });
    expect(ctx.workPackageId).toBe("wp_bare");
    expect(ctx.isEmpty).toBe(true);
  });
});

describe("buildPhilTaskContext — populated", () => {
  const ctx = buildPhilTaskContext({ workPackages: [compiledPackage()], task: TASK });
  it("carries scope note, docs, materials, evidence and warnings", () => {
    expect(ctx.isEmpty).toBe(false);
    expect(ctx.scopeNote).toMatch(/dedicated 20A ZIP/);
    expect(ctx.governingDocs.map((d) => d.documentId)).toEqual(["doc_F10"]);
    expect(ctx.materials[0]?.label).toBe("20A RCBO");
    expect(ctx.requiredEvidence.map((e) => e.id)).toEqual(["re_test", "re_photo"]);
    expect(ctx.warnings).toHaveLength(2);
  });
});

describe("evidence honesty (P7) — met only from a real link", () => {
  const wp = compiledPackage();
  it("with no links, every requirement is unmet (never faked-met)", () => {
    const ctx = buildPhilTaskContext({ workPackages: [wp], task: TASK });
    expect(ctx.requiredEvidence.every((e) => e.met === false)).toBe(true);
  });
  it("a link naming the requirement + carrying proof marks it met", () => {
    const link = EvidenceLinkSchema.parse({
      id: "el_1",
      jobId: "j",
      evidenceId: "ev_test",
      workPackageId: "wp_east_gym",
      requiredEvidenceId: "re_test",
      role: "progress",
    });
    const ctx = buildPhilTaskContext({ workPackages: [wp], task: TASK, evidenceLinks: [link] });
    expect(ctx.requiredEvidence.find((e) => e.id === "re_test")?.met).toBe(true);
    expect(ctx.requiredEvidence.find((e) => e.id === "re_photo")?.met).toBe(false);
  });
  it("a link with no proof side does NOT mark it met", () => {
    const link = EvidenceLinkSchema.parse({
      id: "el_2",
      jobId: "j",
      workPackageId: "wp_east_gym",
      requiredEvidenceId: "re_test",
      role: "progress",
    });
    const ctx = buildPhilTaskContext({ workPackages: [wp], task: TASK, evidenceLinks: [link] });
    expect(ctx.requiredEvidence.find((e) => e.id === "re_test")?.met).toBe(false);
  });
  it("a package-level link with no requirement id ticks nothing specific", () => {
    const link = EvidenceLinkSchema.parse({
      id: "el_3",
      jobId: "j",
      evidenceId: "ev_x",
      workPackageId: "wp_east_gym",
      role: "progress",
    });
    const ctx = buildPhilTaskContext({ workPackages: [wp], task: TASK, evidenceLinks: [link] });
    expect(ctx.requiredEvidence.every((e) => e.met === false)).toBe(true);
  });
  it("a link for a different package does not tick this one", () => {
    const link = EvidenceLinkSchema.parse({
      id: "el_4",
      jobId: "j",
      evidenceId: "ev_x",
      workPackageId: "wp_other",
      requiredEvidenceId: "re_test",
      role: "progress",
    });
    const ctx = buildPhilTaskContext({ workPackages: [wp], task: TASK, evidenceLinks: [link] });
    expect(ctx.requiredEvidence.find((e) => e.id === "re_test")?.met).toBe(false);
  });
});

describe("classifyTaskWarnings", () => {
  it("segregates the three trap classes", () => {
    const ctx = buildPhilTaskContext({ workPackages: [compiledPackage()], task: TASK });
    const c = classifyTaskWarnings(ctx.warnings);
    expect(c.variationTriggers).toHaveLength(1);
    expect(c.byOthers).toHaveLength(1);
    expect(c.reuseExisting).toHaveLength(0);
  });
});

describe("unmetRequiredEvidenceCount (unknown ≠ zero)", () => {
  it("null when the package carries no required evidence", () => {
    const ctx = buildPhilTaskContext({ workPackages: [barePackage()], task: TASK });
    expect(unmetRequiredEvidenceCount(ctx)).toBeNull();
  });
  it("counts unmet items", () => {
    const ctx = buildPhilTaskContext({ workPackages: [compiledPackage()], task: TASK });
    expect(unmetRequiredEvidenceCount(ctx)).toBe(2);
  });
  it("0 when all met", () => {
    const links = ["re_test", "re_photo"].map((rid, i) =>
      EvidenceLinkSchema.parse({
        id: `el_${i}`,
        jobId: "j",
        evidenceId: `ev_${i}`,
        workPackageId: "wp_east_gym",
        requiredEvidenceId: rid,
        role: "progress",
      }),
    );
    const ctx = buildPhilTaskContext({ workPackages: [compiledPackage()], task: TASK, evidenceLinks: links });
    expect(unmetRequiredEvidenceCount(ctx)).toBe(0);
  });
});
