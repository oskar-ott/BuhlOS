import { describe, expect, it } from "vitest";
import type { ScopeOfWorkItem } from "@/domains/jobs/types";
import type { JobStructure } from "@/domains/job-control/compile";
import { compileWorkPackages } from "@/domains/job-control/compile";
import { buildPhilTaskContext } from "@/domains/job-control/task-context";
import {
  deriveRequiredEvidenceId,
  prepareReconciliationConfirm,
  PersistedScopeReconciliationSchema,
  type ClassificationsInput,
} from "./reconciliation-producer";
import { prepareCompileConfirm } from "./compile-producer";

/**
 * The required-proof authoring slice — end-to-end PROOF that an admin-authored
 * reconciliation (a field-delivered clause carrying a task coordinate + required
 * proof) flows through the shipped producer chain to the very thing the field
 * sees:
 *
 *   author classifications (deliveredBy + requiredEvidence)
 *     → L0 buildReconciliationPreview / prepareReconciliationConfirm
 *     → L1 prepareCompileConfirm  →  jobs/<jobId>/job-control.json
 *     → L2/L3 buildPhilTaskContext  →  the task shows UNMET required proof
 *
 * Before this slice the L0 input dropped deliveredBy / requiredEvidence, so the
 * compiler could only ever emit a `no_delivering_task` gap and never any
 * `requiredEvidence` — the Phil Capture-proof loop (#470) had nothing to bind
 * to. These tests pin that the loop is now reachable, and that the honesty
 * guarantees still hold (no fabricated proof, missing coordinate still a gap).
 */

const AT = "2026-06-15T12:00:00.000Z";
const REF_ZIP = { areaId: "area_east_gym", stage: "fitOff" as const, taskId: "task_zip" };

function clauses(): ScopeOfWorkItem[] {
  return [
    { id: "sw_zip", title: "Dedicated 20A ZIP circuit, East Gym", detail: "priced work", order: 0 },
  ];
}

function structure(): JobStructure {
  return {
    id: "job_100arthur",
    roughInTasks: [],
    fitOffTasks: [],
    areaGroups: [
      {
        id: "ag_ground",
        name: "Ground floor",
        areas: [
          {
            id: "area_east_gym",
            name: "East Gym",
            roughInTasks: [],
            fitOffTasks: [{ id: "task_zip", name: "ZIP circuit" }],
          },
        ],
      },
    ],
  };
}

/** Author the reconciliation via the real L0 producer entry, then wrap it in the
 *  persisted envelope L1 reads — i.e. drive the shipped authoring path, never a
 *  hand-built reconciliation. */
function authorAndConfirm(classifications: ClassificationsInput) {
  const prep = prepareReconciliationConfirm({
    jobId: "job_100arthur",
    clauses: clauses(),
    quote: null,
    prior: null,
    classifications,
    confirmedBy: "u_admin",
    at: AT,
  });
  if (!prep.ok) throw new Error("authoring confirm failed");
  return PersistedScopeReconciliationSchema.parse(prep.persisted);
}

const AUTHORED: ClassificationsInput = {
  sw_zip: {
    classification: "priced",
    deliveredBy: [REF_ZIP],
    requiredEvidence: [{ label: "Circuit test before energising", kind: "test_result", note: "RCD trip time" }],
  },
};

describe("authored reconciliation → compile emits required proof, no gap", () => {
  it("compiles requiredEvidence onto the delivering package and emits NO no_delivering_task gap", () => {
    const rec = authorAndConfirm(AUTHORED);
    const { workPackages, gaps } = compileWorkPackages(rec.reconciliation, structure());

    expect(gaps.some((g) => g.kind === "no_delivering_task")).toBe(false);
    expect(workPackages).toHaveLength(1);
    const pkg = workPackages[0]!;
    expect(pkg.taskRefs).toContainEqual(REF_ZIP);
    expect(pkg.requiredEvidence).toHaveLength(1);
    expect(pkg.requiredEvidence![0]).toMatchObject({
      id: deriveRequiredEvidenceId("Circuit test before energising"),
      label: "Circuit test before energising",
      kind: "test_result",
      note: "RCD trip time",
    });
  });

  it("a field clause with NO deliveredBy still emits no_delivering_task (and no package)", () => {
    const rec = authorAndConfirm({
      sw_zip: {
        classification: "priced",
        requiredEvidence: [{ label: "Circuit test", kind: "test_result" }],
      },
    });
    const { workPackages, gaps } = compileWorkPackages(rec.reconciliation, structure());
    expect(gaps.some((g) => g.kind === "no_delivering_task" && g.clauseId === "sw_zip")).toBe(true);
    expect(workPackages).toHaveLength(0);
  });

  it("never fabricates proof: deliveredBy but NO requiredEvidence → a package with no proof", () => {
    const rec = authorAndConfirm({
      sw_zip: { classification: "priced", deliveredBy: [REF_ZIP] },
    });
    const { workPackages, gaps } = compileWorkPackages(rec.reconciliation, structure());
    expect(gaps.some((g) => g.kind === "no_delivering_task")).toBe(false);
    expect(workPackages).toHaveLength(1);
    // requiredEvidence is omitted (the compiler only sets it when there's proof) —
    // never an invented item (P7).
    expect(workPackages[0]!.requiredEvidence).toBeUndefined();
  });

  it("a coordinate pointing at a task not in the structure is a named gap, not a silent task", () => {
    const rec = authorAndConfirm({
      sw_zip: {
        classification: "priced",
        deliveredBy: [{ areaId: "area_east_gym", stage: "fitOff", taskId: "task_ghost" }],
        requiredEvidence: [{ label: "Circuit test", kind: "test_result" }],
      },
    });
    const { workPackages, gaps } = compileWorkPackages(rec.reconciliation, structure());
    expect(gaps.some((g) => g.kind === "task_not_found" && g.clauseId === "sw_zip")).toBe(true);
    expect(workPackages).toHaveLength(0);
  });
});

describe("authored reconciliation → L1 confirm → Phil shows UNMET required proof", () => {
  it("the compiled job-control.json carries the proof, and the task reads it unmet (no evidence links)", () => {
    const rec = authorAndConfirm(AUTHORED);

    // L1: compile + persist (no previous artifact → fresh)
    const prep = prepareCompileConfirm({
      jobId: "job_100arthur",
      persistedReconciliation: rec,
      structure: structure(),
      previous: null,
      confirmedBy: "u_admin",
      at: AT,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    const artifact = prep.persisted;
    expect(artifact.workPackages).toHaveLength(1);
    expect(artifact.evidenceLinks).toEqual([]); // nothing captured yet
    const wp = artifact.workPackages[0]!;
    expect(wp.requiredEvidence).toHaveLength(1);

    // L2/L3: the field read boundary for the delivering task.
    const ctx = buildPhilTaskContext({
      workPackages: artifact.workPackages,
      task: REF_ZIP,
      evidenceLinks: artifact.evidenceLinks,
    });
    expect(ctx.isEmpty).toBe(false);
    expect(ctx.workPackageId).toBe(wp.id);
    expect(ctx.requiredEvidence).toHaveLength(1);
    // The proof exists for this task and is UNMET — exactly the state that lights
    // up the #470 "Capture proof" affordance in Phil.
    expect(ctx.requiredEvidence[0]).toMatchObject({
      label: "Circuit test before energising",
      kind: "test_result",
      met: false,
    });
  });
});
