import { describe, it, expect } from "vitest";
import { WorkPackageSchema, EvidenceLinkSchema } from "./schema";
import type { TaskRef } from "./types";
import {
  workPackageForTask,
  buildPhilTaskContext,
  classifyTaskWarnings,
  unmetRequiredEvidenceCount,
  summarisePhilTaskProof,
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

describe("summarisePhilTaskProof — task-level review-eligibility roll-up", () => {
  const linkFor = (rid: string, i = 0) =>
    EvidenceLinkSchema.parse({
      id: `el_${rid}_${i}`,
      jobId: "j",
      evidenceId: `ev_${rid}_${i}`,
      workPackageId: "wp_east_gym",
      requiredEvidenceId: rid,
      role: "progress",
    });

  it("null when the task has no required proof (unknown ≠ done) — un-compiled renders nothing", () => {
    const ctx = buildPhilTaskContext({ workPackages: [barePackage()], task: TASK });
    expect(summarisePhilTaskProof(ctx)).toBeNull();
  });

  it("reports the required count and that nothing is captured yet (not eligible)", () => {
    const ctx = buildPhilTaskContext({ workPackages: [compiledPackage()], task: TASK });
    expect(summarisePhilTaskProof(ctx)).toEqual({
      requiredCount: 2,
      metCount: 0,
      missingCount: 2,
      eligibleForReview: false,
    });
  });

  it("partial capture is still not eligible for review", () => {
    const ctx = buildPhilTaskContext({
      workPackages: [compiledPackage()],
      task: TASK,
      evidenceLinks: [linkFor("re_test")],
    });
    expect(summarisePhilTaskProof(ctx)).toEqual({
      requiredCount: 2,
      metCount: 1,
      missingCount: 1,
      eligibleForReview: false,
    });
  });

  it("all required proof met → eligible for review", () => {
    const ctx = buildPhilTaskContext({
      workPackages: [compiledPackage()],
      task: TASK,
      evidenceLinks: [linkFor("re_test"), linkFor("re_photo")],
    });
    expect(summarisePhilTaskProof(ctx)).toEqual({
      requiredCount: 2,
      metCount: 2,
      missingCount: 0,
      eligibleForReview: true,
    });
  });
});

describe("summarisePhilTaskProof — proof attaches to the canonical task instance, not a bare taskId", () => {
  // Same template id + same requiredEvidence id in two DIFFERENT areas → two
  // distinct packages. A proof linked to one must not satisfy the other.
  const reqs = [{ id: "re_photo", label: "Photo before wall close", kind: "photo" }];
  const wpEast = WorkPackageSchema.parse({
    id: "wp_east",
    jobId: "j",
    title: "East",
    taskRefs: [{ areaId: "area_east", stage: "roughIn", taskId: "t_shared" }],
    requiredEvidence: reqs,
  });
  const wpWest = WorkPackageSchema.parse({
    id: "wp_west",
    jobId: "j",
    title: "West",
    taskRefs: [{ areaId: "area_west", stage: "roughIn", taskId: "t_shared" }],
    requiredEvidence: reqs,
  });
  const eastLink = EvidenceLinkSchema.parse({
    id: "el_east",
    jobId: "j",
    evidenceId: "ev_east",
    workPackageId: "wp_east",
    requiredEvidenceId: "re_photo",
    role: "progress",
  });

  it("same taskId in a DIFFERENT area is not cross-satisfied", () => {
    const wps = [wpEast, wpWest];
    const east = summarisePhilTaskProof(
      buildPhilTaskContext({
        workPackages: wps,
        task: { areaId: "area_east", stage: "roughIn", taskId: "t_shared" },
        evidenceLinks: [eastLink],
      }),
    );
    const west = summarisePhilTaskProof(
      buildPhilTaskContext({
        workPackages: wps,
        task: { areaId: "area_west", stage: "roughIn", taskId: "t_shared" },
        evidenceLinks: [eastLink],
      }),
    );
    expect(east?.eligibleForReview).toBe(true);
    expect(west).toEqual({ requiredCount: 1, metCount: 0, missingCount: 1, eligibleForReview: false });
  });

  it("same taskId in a DIFFERENT stage is not cross-satisfied", () => {
    // Two packages keyed to the same area+template but different STAGE coordinate.
    // The lookup is by the full (areaId, stage, taskId) tuple, so a proof linked
    // to the rough-in package never satisfies the fit-off instance.
    const wpRi = WorkPackageSchema.parse({
      id: "wp_ri",
      jobId: "j",
      title: "RI",
      taskRefs: [{ areaId: "area_x", stage: "roughIn", taskId: "t" }],
      requiredEvidence: reqs,
    });
    const wpFo = WorkPackageSchema.parse({
      id: "wp_fo",
      jobId: "j",
      title: "FO",
      taskRefs: [{ areaId: "area_x", stage: "fitOff", taskId: "t" }],
      requiredEvidence: reqs,
    });
    const riLink = EvidenceLinkSchema.parse({
      id: "el_ri",
      jobId: "j",
      evidenceId: "ev_ri",
      workPackageId: "wp_ri",
      requiredEvidenceId: "re_photo",
      role: "progress",
    });
    const wps = [wpRi, wpFo];
    const ri = summarisePhilTaskProof(
      buildPhilTaskContext({ workPackages: wps, task: { areaId: "area_x", stage: "roughIn", taskId: "t" }, evidenceLinks: [riLink] }),
    );
    const fo = summarisePhilTaskProof(
      buildPhilTaskContext({ workPackages: wps, task: { areaId: "area_x", stage: "fitOff", taskId: "t" }, evidenceLinks: [riLink] }),
    );
    expect(ri?.eligibleForReview).toBe(true);
    expect(fo).toEqual({ requiredCount: 1, metCount: 0, missingCount: 1, eligibleForReview: false });
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
