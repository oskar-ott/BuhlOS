import { describe, it, expect } from "vitest";
import type { Job } from "../jobs/types";
import { ScopeReconciliationSchema } from "./reconciliation";
import {
  compileWorkPackages,
  diffCompile,
  deriveWorkPackageId,
  resolveTaskRef,
  type JobStructure,
} from "./compile";
import { taskRefKey, boqLineRefKey } from "./spine";

// ── Fixtures — a real-shaped job structure + a reconciled scope ───────────────

function structure(): JobStructure {
  const job: Pick<Job, "id" | "areaGroups" | "roughInTasks" | "fitOffTasks"> = {
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
            fitOffTasks: [{ id: "task_zip", name: "ZIP dedicated circuit" }],
          },
          {
            id: "area_reception",
            name: "Reception",
            roughInTasks: [],
            fitOffTasks: [{ id: "task_cabling", name: "A/V cabling" }],
          },
        ],
      },
    ],
  };
  return job;
}

const REF_ZIP = { areaId: "area_east_gym", stage: "fitOff" as const, taskId: "task_zip" };
const REF_CABLING = { areaId: "area_reception", stage: "fitOff" as const, taskId: "task_cabling" };

function reconciliation() {
  return ScopeReconciliationSchema.parse({
    jobId: "job_100arthur",
    quoteId: "q_100arthur",
    clauseClassifications: [
      {
        clauseId: "sw_zip",
        classification: "priced",
        boqLineRefs: [{ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_zip" }],
        deliveredBy: [REF_ZIP],
        requiredEvidence: [{ id: "re_zip_test", label: "Circuit test result", kind: "test_result" }],
        documentIds: ["doc_F10"],
      },
      {
        clauseId: "sw_cabling",
        classification: "priced",
        boqLineRefs: [{ quoteId: "q_100arthur", sectionId: "sec_av", lineId: "ql_cabling" }],
        deliveredBy: [REF_CABLING],
      },
      {
        clauseId: "sw_av",
        classification: "by_others",
        warningText: "A/V hardware by others — cabling only",
        deliveredBy: [REF_CABLING],
      },
      { clauseId: "sw_disposal", classification: "excluded", note: "make safe (no field task)" },
      {
        clauseId: "sw_ghost",
        classification: "priced",
        deliveredBy: [{ areaId: "area_east_gym", stage: "fitOff", taskId: "task_missing" }],
      },
      { clauseId: "sw_unclear", classification: "unclear" },
      { clauseId: "sw_nofield", classification: "priced", deliveredBy: [] },
    ],
  });
}

describe("deriveWorkPackageId", () => {
  it("is deterministic and area-derived (no randomness)", () => {
    expect(deriveWorkPackageId("job_100arthur", "area_east_gym")).toBe(
      deriveWorkPackageId("job_100arthur", "area_east_gym"),
    );
    expect(deriveWorkPackageId("job_100arthur", "area_east_gym")).toMatch(/^wp_[0-9a-f]{8}$/);
    expect(deriveWorkPackageId("job_100arthur", "area_east_gym")).not.toBe(
      deriveWorkPackageId("job_100arthur", "area_reception"),
    );
  });
});

describe("resolveTaskRef", () => {
  it("resolves a live task by coordinate", () => {
    expect(resolveTaskRef(structure(), REF_ZIP)?.name).toBe("ZIP dedicated circuit");
  });
  it("returns null for a coordinate not in the structure", () => {
    expect(resolveTaskRef(structure(), { ...REF_ZIP, taskId: "nope" })).toBeNull();
    expect(resolveTaskRef(structure(), { ...REF_ZIP, areaId: "nope" })).toBeNull();
  });
});

describe("compileWorkPackages — 100 Arthur", () => {
  const result = compileWorkPackages(reconciliation(), structure());
  const eastGym = result.workPackages.find((p) => p.title === "East Gym");
  const reception = result.workPackages.find((p) => p.title === "Reception");

  it("makes one package per area that received field work", () => {
    expect(result.workPackages.map((p) => p.title)).toEqual(["East Gym", "Reception"]);
  });

  it("East Gym carries clause, BOQ line, task, required evidence and governing doc", () => {
    expect(eastGym?.scopeClauseIds).toEqual(["sw_zip"]);
    expect(eastGym?.taskRefs.map(taskRefKey)).toEqual([taskRefKey(REF_ZIP)]);
    expect(eastGym?.boqLineRefs.map(boqLineRefKey)).toEqual([
      boqLineRefKey({ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_zip" }),
    ]);
    expect(eastGym?.requiredEvidence?.map((e) => e.id)).toEqual(["re_zip_test"]);
    expect(eastGym?.governingDocRefs?.map((d) => d.documentId)).toEqual(["doc_F10"]);
  });

  it("a package id is area-stable", () => {
    expect(eastGym?.id).toBe(deriveWorkPackageId("job_100arthur", "area_east_gym"));
  });

  it("the by-others warning rides the Reception package, not a task", () => {
    expect(reception?.scopeClauseIds).toEqual(["sw_cabling"]);
    expect(reception?.warnings?.[0]).toMatchObject({
      kind: "by_others",
      text: "A/V hardware by others — cabling only",
      scopeClauseId: "sw_av",
    });
  });

  it("a package never carries task state (coordinates only)", () => {
    for (const p of result.workPackages) {
      expect(p).not.toHaveProperty("status");
      for (const ref of p.taskRefs) {
        expect(Object.keys(ref).sort()).toEqual(["areaId", "stage", "taskId"]);
      }
    }
  });

  it("names every gap and never mints a task", () => {
    const kinds = result.gaps.map((g) => g.kind).sort();
    expect(kinds).toEqual(
      ["no_delivering_task", "task_not_found", "unclassified_clause"].sort(),
    );
    // excluded clause with no tasks → no gap, no package
    expect(result.gaps.some((g) => g.clauseId === "sw_disposal")).toBe(false);
    // the missing task is reported, not created
    expect(result.gaps.find((g) => g.kind === "task_not_found")?.clauseId).toBe("sw_ghost");
  });
});

describe("excluded clause carrying tasks is a conflict gap", () => {
  it("flags no_field_class_has_tasks", () => {
    const rec = ScopeReconciliationSchema.parse({
      jobId: "j",
      clauseClassifications: [
        { clauseId: "sw_x", classification: "excluded", deliveredBy: [REF_ZIP] },
      ],
    });
    const result = compileWorkPackages(rec, structure());
    expect(result.workPackages).toEqual([]);
    expect(result.gaps[0]?.kind).toBe("no_field_class_has_tasks");
  });
});

describe("diffCompile — delta-only, id-stable (#190 guard)", () => {
  it("identical re-compile produces no delta", () => {
    const a = compileWorkPackages(reconciliation(), structure());
    const b = compileWorkPackages(reconciliation(), structure());
    const diff = diffCompile(a, b);
    expect(diff.addedPackages).toEqual([]);
    expect(diff.updatedPackages).toEqual([]);
    expect(diff.removedPackages).toEqual([]);
  });

  it("first compile is all-added", () => {
    const next = compileWorkPackages(reconciliation(), structure());
    const diff = diffCompile(null, next);
    expect(diff.addedPackages).toHaveLength(2);
  });

  it("editing one clause updates only its area's package", () => {
    const before = compileWorkPackages(reconciliation(), structure());
    const rec = reconciliation();
    // add a required-evidence item to the ZIP (East Gym) clause only
    const edited = ScopeReconciliationSchema.parse({
      ...rec,
      clauseClassifications: rec.clauseClassifications.map((c) =>
        c.clauseId === "sw_zip"
          ? {
              ...c,
              requiredEvidence: [
                ...c.requiredEvidence,
                { id: "re_zip_photo", label: "Photo of label", kind: "photo" },
              ],
            }
          : c,
      ),
    });
    const after = compileWorkPackages(edited, structure());
    const diff = diffCompile(before, after);
    expect(diff.addedPackages).toEqual([]);
    expect(diff.removedPackages).toEqual([]);
    expect(diff.updatedPackages).toHaveLength(1);
    expect(diff.updatedPackages[0]?.after.title).toBe("East Gym");
  });
});
