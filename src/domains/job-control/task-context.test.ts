import { describe, it, expect } from "vitest";
import { WorkPackageSchema, EvidenceLinkSchema } from "./schema";
import type { TaskRef } from "./types";
import {
  workPackageForTask,
  buildPhilTaskContext,
  classifyTaskWarnings,
  unmetRequiredEvidenceCount,
  summarisePhilTaskProof,
  philTaskProofView,
  canSubmitProofForReview,
} from "./task-context";
import type { ProofReview } from "./types";

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

describe("summarisePhilTaskProof — granularity: cross-area isolated, area-granular within an area", () => {
  // Required proof lives on the AREA work package, so the isolation that holds is
  // cross-AREA (a different area is a different package). WITHIN an area both
  // stages share one package, so they share the summary — see the area-granular
  // test below. Same template id + same requiredEvidence id in two DIFFERENT
  // areas → two distinct packages; a proof linked to one must not satisfy the other.
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

  it("a different AREA is a different package — same taskId there is not cross-satisfied", () => {
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

  it("is AREA-granular within an area: both stages share the one area package, so the same proof flips both (honest reflection of the compiler's one-package-per-area shape)", () => {
    // The real compiler emits ONE package per area whose taskRefs include both
    // stages (compile.ts groups by areaId, deriveWorkPackageId(jobId, areaId)).
    // So a rough-in task and a fit-off task in the same area resolve to the SAME
    // package + SAME requiredEvidence — there is no per-stage / per-task proof.
    // Capturing the area's proof therefore satisfies BOTH stage instances. This
    // documents the current granularity truthfully (per-instance proof is future
    // work); do NOT read it as cross-stage isolation.
    const wp = WorkPackageSchema.parse({
      id: "wp_area",
      jobId: "j",
      title: "Area",
      taskRefs: [
        { areaId: "area_x", stage: "roughIn", taskId: "t" },
        { areaId: "area_x", stage: "fitOff", taskId: "t" },
      ],
      requiredEvidence: reqs,
    });
    const link = EvidenceLinkSchema.parse({
      id: "el_area",
      jobId: "j",
      evidenceId: "ev_area",
      workPackageId: "wp_area",
      requiredEvidenceId: "re_photo",
      role: "progress",
    });
    const ri = summarisePhilTaskProof(
      buildPhilTaskContext({ workPackages: [wp], task: { areaId: "area_x", stage: "roughIn", taskId: "t" }, evidenceLinks: [link] }),
    );
    const fo = summarisePhilTaskProof(
      buildPhilTaskContext({ workPackages: [wp], task: { areaId: "area_x", stage: "fitOff", taskId: "t" }, evidenceLinks: [link] }),
    );
    expect(ri).toEqual({ requiredCount: 1, metCount: 1, missingCount: 0, eligibleForReview: true });
    expect(fo).toEqual(ri); // same area package → identical summary (area-granular, not per-stage)
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

describe("philTaskProofView + canSubmitProofForReview (review lifecycle)", () => {
  const wp = compiledPackage(); // wp_east_gym, requires re_test + re_photo
  const bothMet = ["re_test", "re_photo"].map((rid, i) =>
    EvidenceLinkSchema.parse({
      id: `el_${i}`,
      jobId: "j",
      evidenceId: `ev_${i}`,
      workPackageId: "wp_east_gym",
      requiredEvidenceId: rid,
      role: "progress",
    }),
  );
  const readyCtx = () => buildPhilTaskContext({ workPackages: [wp], task: TASK, evidenceLinks: bothMet });
  const partialCtx = () => buildPhilTaskContext({ workPackages: [wp], task: TASK });
  const review = (over: Partial<ProofReview>): ProofReview => ({
    id: "pr_1",
    jobId: "j",
    workPackageId: "wp_east_gym",
    status: "submitted",
    ...over,
  });

  it("not_required when the task has no required proof", () => {
    expect(philTaskProofView(buildPhilTaskContext({ workPackages: [barePackage()], task: TASK })).status).toBe(
      "not_required",
    );
  });

  it("not_ready while required proof is outstanding, ready once all met", () => {
    expect(philTaskProofView(partialCtx()).status).toBe("not_ready");
    expect(philTaskProofView(readyCtx()).status).toBe("ready");
  });

  it("reflects the office review record (submitted / approved / rejected + reason)", () => {
    expect(philTaskProofView(readyCtx(), [review({ status: "submitted" })]).status).toBe("submitted");
    expect(philTaskProofView(readyCtx(), [review({ status: "approved" })]).status).toBe("approved");
    const rej = philTaskProofView(readyCtx(), [review({ status: "rejected", reason: "Missing label" })]);
    expect(rej.status).toBe("rejected");
    expect(rej.reason).toBe("Missing label");
  });

  it("a review for a DIFFERENT work package does not affect this task (isolation)", () => {
    const v = philTaskProofView(readyCtx(), [review({ workPackageId: "wp_other", status: "approved" })]);
    expect(v.status).toBe("ready");
  });

  it("canSubmit: not_required, incomplete, then ok when all proof is met", () => {
    expect(canSubmitProofForReview(buildPhilTaskContext({ workPackages: [barePackage()], task: TASK })).ok).toBe(false);
    const inc = canSubmitProofForReview(partialCtx());
    expect(inc.ok).toBe(false);
    if (!inc.ok) expect(inc.reason).toBe("incomplete");
    expect(canSubmitProofForReview(readyCtx()).ok).toBe(true);
  });

  it("canSubmit: blocked while submitted/approved, allowed again after rejected", () => {
    expect(canSubmitProofForReview(readyCtx(), [review({ status: "submitted" })]).ok).toBe(false);
    expect(canSubmitProofForReview(readyCtx(), [review({ status: "approved" })]).ok).toBe(false);
    expect(canSubmitProofForReview(readyCtx(), [review({ status: "rejected", reason: "x" })]).ok).toBe(true);
  });
});
