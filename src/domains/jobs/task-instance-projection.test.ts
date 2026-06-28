import { describe, expect, it } from "vitest";
import {
  buildCanonicalTaskIndex,
  deriveCanonicalTaskId,
  type CanonicalTask,
} from "./task-index";
import type { TaskBlocker, TaskDependency } from "./task-blockers";
import {
  groupTaskInstancesByArea,
  groupTaskInstancesBySystem,
  projectTaskInstances,
  tasksByArea,
  tasksByStage,
  tasksBySystem,
  toTaskInstanceView,
  type TaskInstanceProofFacet,
  type TaskInstanceView,
} from "./task-instance-projection";
import { parseJobTaskState } from "./taskState";
import {
  buildPhilTaskContext,
  summarisePhilTaskProof,
} from "../job-control/task-context";
import type {
  EvidenceLink,
  GoverningDocRef,
  WorkPackage,
  WorkPackageMaterial,
} from "../job-control/types";
import type { Job } from "./types";

/**
 * #500 — read-only task-instance projection. Proves: one task appears in many
 * views without being re-owned; the `ct_` instance identity is preserved; an
 * inherited template stays isolated across areas AND stages; a bare `taskId` is
 * never enough to select an instance; the source tuple survives every filter;
 * facets are honest-empty / injected; and the projection mutates nothing.
 *
 * Worked scenario (from the constitution's worked example):
 *   "Install dedicated 20A ZIP circuit" · job 100 Arthur St · system power.
 */

const JOB_ID = "j_arthur";

function job(over: Partial<Job> = {}): Job {
  return { id: JOB_ID, name: "100 Arthur St", status: "active", ...over } as unknown as Job;
}

/**
 * East Gym + West Gym, with a job-level ZIP template in BOTH stages (so the same
 * `t_zip` materialises across two areas × two stages = 4 instances) plus a
 * lighting rough-in. 6 instances total.
 */
function arthurJob(): Job {
  return job({
    roughInTasks: [
      { id: "t_zip", name: "Install dedicated 20A ZIP circuit" },
      { id: "t_light", name: "Rough-in lighting circuit" },
    ],
    fitOffTasks: [{ id: "t_zip", name: "Install dedicated 20A ZIP circuit" }],
    areaGroups: [
      {
        id: "g1",
        name: "Ground",
        areas: [
          { id: "east", name: "East Gym" },
          { id: "west", name: "West Gym" },
        ],
      },
    ],
  });
}

const index = () => buildCanonicalTaskIndex({ job: arthurJob() });

const findInstance = <T extends CanonicalTask>(
  tasks: ReadonlyArray<T>,
  areaId: string,
  stage: "roughIn" | "fitOff",
  taskId: string,
): T => {
  const t = tasks.find(
    (c) => c.source.areaId === areaId && c.source.stage === stage && c.source.taskId === taskId,
  );
  if (!t) throw new Error(`no instance for ${areaId}/${stage}/${taskId}`);
  return t;
};

describe("multi-view projection — one instance, many views", () => {
  it("the same task appears in its area view, stage view, and system view", () => {
    const views = projectTaskInstances(index());
    const eastZipFitOff = findInstance(views, "east", "fitOff", "t_zip");

    const inArea = tasksByArea(views, "east").map((t) => t.id);
    const inStage = tasksByStage(views, "fitOff").map((t) => t.id);
    const inSystem = tasksBySystem(views, "power").map((t) => t.id);

    expect(inArea).toContain(eastZipFitOff.id);
    expect(inStage).toContain(eastZipFitOff.id);
    expect(inSystem).toContain(eastZipFitOff.id);
    // it is the SAME instance object surfacing in each view (no re-ownership/dup)
    expect(tasksByArea(views, "east").find((t) => t.id === eastZipFitOff.id)).toBe(eastZipFitOff);
  });

  it("groupers project the index into per-facet buckets without losing instances", () => {
    const views = projectTaskInstances(index());
    const byArea = groupTaskInstancesByArea(views);
    const bySystem = groupTaskInstancesBySystem(views);

    expect([...byArea.keys()].sort()).toEqual(["east", "west"]);
    expect(byArea.get("east")).toHaveLength(3); // roughIn zip, roughIn light, fitOff zip
    // power = zip × (2 stages) per area = 4; lighting = 1 per area = 2
    expect(bySystem.get("power")).toHaveLength(4);
    expect(bySystem.get("lighting")).toHaveLength(2);
    const total = [...byArea.values()].reduce((n, b) => n + b.length, 0);
    expect(total).toBe(views.length);
  });
});

describe("instance identity is preserved (ct_), never the bare taskId", () => {
  it("the view carries the canonical ct_ id, tuple-derived", () => {
    const view = findInstance(projectTaskInstances(index()), "east", "fitOff", "t_zip");
    expect(view.id).toMatch(/^ct_[0-9a-f]{8}$/);
    expect(view.id).toBe(
      deriveCanonicalTaskId({ jobId: JOB_ID, areaId: "east", stage: "fitOff", taskId: "t_zip" }),
    );
    expect(view.templateId).toBe("t_zip"); // template id kept separate from identity
  });

  it("same taskId in different AREAS → distinct instances", () => {
    const views = projectTaskInstances(index());
    const east = findInstance(views, "east", "fitOff", "t_zip");
    const west = findInstance(views, "west", "fitOff", "t_zip");
    expect(east.templateId).toBe(west.templateId);
    expect(east.id).not.toBe(west.id);
  });

  it("same taskId in different STAGES → distinct instances", () => {
    const views = projectTaskInstances(index());
    const roughIn = findInstance(views, "east", "roughIn", "t_zip");
    const fitOff = findInstance(views, "east", "fitOff", "t_zip");
    expect(roughIn.templateId).toBe(fitOff.templateId);
    expect(roughIn.id).not.toBe(fitOff.id);
  });

  it("a bare taskId is NOT enough to select a job-level instance", () => {
    const views = projectTaskInstances(index());
    // "t_zip" alone maps to 4 distinct instances (2 areas × 2 stages)
    const zips = views.filter((v) => v.templateId === "t_zip");
    expect(zips).toHaveLength(4);
    expect(new Set(zips.map((v) => v.id)).size).toBe(4);
    // identity needs the full coordinate — no helper selects by bare taskId
    const ids = new Set(
      zips.map((v) =>
        deriveCanonicalTaskId({
          jobId: v.jobId,
          areaId: v.source.areaId,
          stage: v.source.stage,
          taskId: v.source.taskId,
        }),
      ),
    );
    expect(ids).toEqual(new Set(zips.map((v) => v.id)));
  });
});

describe("filters preserve the source tuple (write-bridge compatibility)", () => {
  it("filtering by area keeps the full source coordinate", () => {
    for (const t of tasksByArea(index(), "east")) {
      expect(t.source).toEqual({ areaId: "east", stage: t.stage, taskId: t.templateId });
    }
  });

  it("filtering by stage keeps the full source coordinate", () => {
    for (const t of tasksByStage(index(), "fitOff")) {
      expect(t.source.stage).toBe("fitOff");
      expect(t.source.areaId).toBeTruthy();
      expect(t.source.taskId).toBeTruthy();
    }
  });

  it("filtering by system keeps the full source coordinate", () => {
    const power = tasksBySystem(index(), "power");
    expect(power.length).toBeGreaterThan(0);
    for (const t of power) {
      expect(t.system).toBe("power");
      expect(t.source).toEqual({ areaId: t.source.areaId, stage: t.source.stage, taskId: t.templateId });
    }
  });

  it("filters are facet-preserving when applied to projected views", () => {
    const views = projectTaskInstances(index());
    const eastViews: TaskInstanceView[] = tasksByArea(views, "east");
    // returns TaskInstanceView[] (facets survive the filter), not bare CanonicalTask[]
    expect(eastViews.every((v) => v.facets !== undefined)).toBe(true);
  });
});

describe("projection has no write side effects", () => {
  it("does not mutate the input index or its tasks", () => {
    const tasks = index();
    const before = JSON.stringify(tasks);
    const blockers: TaskBlocker[] = [
      { id: "b1", taskId: tasks[0]!.id, type: "material", title: "x", status: "open" },
    ];
    projectTaskInstances(tasks, { blockers });
    tasksByArea(tasks, "east");
    tasksBySystem(tasks, "power");
    expect(JSON.stringify(tasks)).toBe(before);
  });

  it("returns fresh view objects, leaving the underlying task identity intact", () => {
    const tasks = index();
    const views = projectTaskInstances(tasks);
    expect(views[0]).not.toBe(tasks[0]);
    expect(views[0]!.id).toBe(tasks[0]!.id);
    expect(views[0]!.source).toEqual(tasks[0]!.source);
  });
});

describe("readiness facet — composed from #482, honest-empty by default", () => {
  it("with no blocker/dependency source, not-complete → ready, complete → complete", () => {
    const taskState = parseJobTaskState({
      dwellings: { east: { fitOff: { tasks: { t_zip: "complete" } } } },
    });
    const tasks = buildCanonicalTaskIndex({ job: arthurJob(), taskState });
    const views = projectTaskInstances(tasks);
    const done = findInstance(views, "east", "fitOff", "t_zip");
    const notDone = findInstance(views, "west", "fitOff", "t_zip");
    expect(done.facets.readiness).toBe("complete");
    expect(notDone.facets.readiness).toBe("ready");
    expect(views.every((v) => v.facets.hasOpenBlockers === false)).toBe(true);
    expect(views.every((v) => v.facets.blockerIds.length === 0)).toBe(true);
  });

  it("an open blocker (canonical-id keyed) flips just that instance to blocked", () => {
    const tasks = index();
    const target = findInstance(tasks, "east", "fitOff", "t_zip");
    const blockers: TaskBlocker[] = [
      { id: "blk_1", taskId: target.id, type: "access", title: "Site locked", status: "open" },
    ];
    const views = projectTaskInstances(tasks, { blockers });
    const blocked = findInstance(views, "east", "fitOff", "t_zip");
    expect(blocked.facets.readiness).toBe("blocked");
    expect(blocked.facets.hasOpenBlockers).toBe(true);
    expect(blocked.facets.blockerIds).toEqual(["blk_1"]);
    // the SAME templateId in another area/stage is unaffected (canonical isolation)
    expect(findInstance(views, "west", "fitOff", "t_zip").facets.readiness).toBe("ready");
    expect(findInstance(views, "east", "roughIn", "t_zip").facets.readiness).toBe("ready");
  });

  it("a cross-area dependency on an incomplete prerequisite blocks", () => {
    const tasks = index();
    const eastFit = findInstance(tasks, "east", "fitOff", "t_zip");
    const westRough = findInstance(tasks, "west", "roughIn", "t_zip");
    const dependencies: TaskDependency[] = [
      { taskId: eastFit.id, dependsOnTaskId: westRough.id },
    ];
    const views = projectTaskInstances(tasks, { dependencies });
    expect(findInstance(views, "east", "fitOff", "t_zip").facets.readiness).toBe("blocked");
  });
});

describe("proof facet — injected, never invented", () => {
  it("proofFor result lands on the facet; absent → null", () => {
    const eastProof: TaskInstanceProofFacet = {
      requiredCount: 2,
      metCount: 1,
      missingCount: 1,
      eligibleForReview: false,
      granularity: "area-package",
    };
    const views = projectTaskInstances(index(), {
      proofFor: (t) => (t.source.areaId === "east" ? eastProof : null),
    });
    expect(findInstance(views, "east", "fitOff", "t_zip").facets.proof).toEqual(eastProof);
    expect(findInstance(views, "west", "fitOff", "t_zip").facets.proof).toBeNull();
  });

});

describe("#506 grain-tagged facets — honest-empty by default, never omitted, never faked", () => {
  it("(a) with NO input every facet is present with its honest grain tag", () => {
    const views = projectTaskInstances(index());
    for (const v of views) {
      const f = v.facets;
      // assignee — structurally un-fakeable honest-empty
      expect(f.assignee).toEqual({ grain: "none", reason: "no per-task assignee source" });
      // labour — always job-grained honest-empty (no per-task split, P7)
      expect(f.labour).toEqual({ grain: "job", reason: "hours are jobId-only" });
      // material / drawing — honest-empty grain "none" with no resolver
      expect(f.material).toEqual({ grain: "none", reason: "no task-grained material source" });
      expect(f.drawing).toEqual({ grain: "none", reason: "no task-grained drawing source" });
      // rfi — honest-empty grain "none" with no open rfi blocker
      expect(f.rfi).toEqual({ grain: "none", reason: "no open task RFI" });
      // none are undefined — present, not omitted
      expect(Object.keys(f)).toEqual(
        expect.arrayContaining(["assignee", "labour", "material", "drawing", "rfi"]),
      );
    }
  });

  it("toTaskInstanceView (no input) yields the same honest-empty facet defaults", () => {
    const v = toTaskInstanceView(findInstance(index(), "east", "fitOff", "t_zip"));
    expect(v.facets.assignee.grain).toBe("none");
    expect(v.facets.labour.grain).toBe("job");
    expect(v.facets.material.grain).toBe("none");
    expect(v.facets.drawing.grain).toBe("none");
    expect(v.facets.rfi.grain).toBe("none");
  });

  it("(d) labour & assignee NEVER carry a per-task value, regardless of input", () => {
    // even with a full ctx (blockers incl. an rfi, proof, materials, drawings),
    // assignee/labour stay their honest grain-tagged default — there is no input
    // path that could populate them.
    const tasks = index();
    const target = findInstance(tasks, "east", "fitOff", "t_zip");
    const views = projectTaskInstances(tasks, {
      blockers: [
        { id: "rfi_1", taskId: target.id, type: "rfi", title: "Which RCD?", status: "open" },
      ],
      proofFor: () => ({
        requiredCount: 1, metCount: 0, missingCount: 1,
        eligibleForReview: false, granularity: "area-package",
      }),
      materialsFor: () => [{ label: "20A breaker" }],
      drawingsFor: () => [{ documentId: "doc_1" }],
    });
    for (const v of views) {
      expect(v.facets.assignee).toEqual({ grain: "none", reason: "no per-task assignee source" });
      expect(v.facets.labour).toEqual({ grain: "job", reason: "hours are jobId-only" });
      // no "items"/"split"/per-task numbers ever appear on these two facets
      expect(v.facets.assignee).not.toHaveProperty("items");
      expect(v.facets.labour).not.toHaveProperty("hours");
    }
  });

  it("(c) an OPEN rfi-typed blocker on the canonical id → rfi grain 'task' with that id", () => {
    const tasks = index();
    const target = findInstance(tasks, "east", "fitOff", "t_zip");
    const blockers: TaskBlocker[] = [
      { id: "rfi_42", taskId: target.id, type: "rfi", title: "Confirm circuit rating", status: "open" },
    ];
    const views = projectTaskInstances(tasks, { blockers });
    const rfi = findInstance(views, "east", "fitOff", "t_zip").facets.rfi;
    expect(rfi).toEqual({ grain: "task", openRfiIds: ["rfi_42"], titles: ["Confirm circuit rating"] });
    // the SAME templateId elsewhere is unaffected — task-grained, canonical isolation
    expect(findInstance(views, "west", "fitOff", "t_zip").facets.rfi.grain).toBe("none");
  });

  it("(c) a RESOLVED rfi blocker or a NON-rfi blocker does NOT populate the rfi facet", () => {
    const tasks = index();
    const target = findInstance(tasks, "east", "fitOff", "t_zip");
    const blockers: TaskBlocker[] = [
      { id: "rfi_done", taskId: target.id, type: "rfi", title: "Answered", status: "resolved" },
      { id: "mat_1", taskId: target.id, type: "material", title: "Awaiting breaker", status: "open" },
    ];
    const views = projectTaskInstances(tasks, { blockers });
    // resolved rfi + open non-rfi → rfi facet stays honest-empty
    expect(findInstance(views, "east", "fitOff", "t_zip").facets.rfi).toEqual({
      grain: "none",
      reason: "no open task RFI",
    });
  });
});

describe("integration — composes with the REAL job-control proof model (area/package-granular)", () => {
  // One package per area, holding the union of that area's task requirements —
  // exactly what the compiler emits today. Proves the honest granularity: every
  // task the package delivers shares the summary; a different area is isolated.
  const wpEast = {
    id: "wp_east",
    taskRefs: [
      { areaId: "east", stage: "roughIn", taskId: "t_zip" },
      { areaId: "east", stage: "roughIn", taskId: "t_light" },
      { areaId: "east", stage: "fitOff", taskId: "t_zip" },
    ],
    requiredEvidence: [
      { id: "re_photo", label: "Board photo", kind: "photo" },
      { id: "re_test", label: "Test result", kind: "test_result" },
    ],
  } as unknown as WorkPackage;
  const wpWest = {
    id: "wp_west",
    taskRefs: [
      { areaId: "west", stage: "roughIn", taskId: "t_zip" },
      { areaId: "west", stage: "roughIn", taskId: "t_light" },
      { areaId: "west", stage: "fitOff", taskId: "t_zip" },
    ],
    requiredEvidence: [{ id: "re_photo", label: "Board photo", kind: "photo" }],
  } as unknown as WorkPackage;
  const workPackages = [wpEast, wpWest];
  // one captured photo on the East package → East is 1/2 met, West is 0/1
  const evidenceLinks = [
    { id: "el_1", workPackageId: "wp_east", requiredEvidenceId: "re_photo", evidenceId: "ev_1" },
  ] as unknown as EvidenceLink[];

  const proofFor = (task: CanonicalTask): TaskInstanceProofFacet | null => {
    // a fresh TaskRef literal from the preserved source coordinate
    const ctx = buildPhilTaskContext({
      workPackages,
      task: { areaId: task.source.areaId, stage: task.source.stage, taskId: task.source.taskId },
      evidenceLinks,
    });
    const s = summarisePhilTaskProof(ctx);
    return s ? { ...s, granularity: "area-package" } : null;
  };

  it("every task in an area shares its package proof; a different area is isolated", () => {
    const views = projectTaskInstances(index(), { proofFor });

    const eastZipRough = findInstance(views, "east", "roughIn", "t_zip").facets.proof;
    const eastZipFit = findInstance(views, "east", "fitOff", "t_zip").facets.proof;
    const eastLight = findInstance(views, "east", "roughIn", "t_light").facets.proof;

    // area/package granularity: all three East tasks share the SAME summary
    expect(eastZipRough).toEqual({
      requiredCount: 2,
      metCount: 1,
      missingCount: 1,
      eligibleForReview: false,
      granularity: "area-package",
    });
    expect(eastZipFit).toEqual(eastZipRough);
    expect(eastLight).toEqual(eastZipRough);

    // cross-area isolation: West has its own (unmet) package, unaffected by East
    expect(findInstance(views, "west", "fitOff", "t_zip").facets.proof).toEqual({
      requiredCount: 1,
      metCount: 0,
      missingCount: 1,
      eligibleForReview: false,
      granularity: "area-package",
    });
  });
});

describe("#506 integration — materials/drawings injected from the REAL #368 scope-context", () => {
  // Same area-package shape the #368 compiler emits: materials + governingDocRefs
  // on the work package that delivers each area's tasks. The caller maps a
  // buildPhilTaskContext(...) result into materialsFor/drawingsFor — mirroring the
  // proof integration via summarisePhilTaskProof → proofFor.
  const eastMaterials: WorkPackageMaterial[] = [
    { label: "20A breaker", qty: 1, unit: "ea" },
    { label: "2.5mm² TPS", qty: 30, unit: "m" },
  ];
  const eastDocs: GoverningDocRef[] = [
    { documentId: "doc_sld", label: "Single-line diagram" },
    { documentId: "doc_spec" },
  ];
  const wpEast = {
    id: "wp_east",
    taskRefs: [
      { areaId: "east", stage: "roughIn", taskId: "t_zip" },
      { areaId: "east", stage: "roughIn", taskId: "t_light" },
      { areaId: "east", stage: "fitOff", taskId: "t_zip" },
    ],
    materials: eastMaterials,
    governingDocRefs: eastDocs,
  } as unknown as WorkPackage;
  // West package carries NO materials/docs → honest-empty grain "area-package" zero items
  const wpWest = {
    id: "wp_west",
    taskRefs: [{ areaId: "west", stage: "fitOff", taskId: "t_zip" }],
  } as unknown as WorkPackage;
  const workPackages = [wpEast, wpWest];

  const ctxFor = (task: CanonicalTask) =>
    buildPhilTaskContext({
      workPackages,
      task: { areaId: task.source.areaId, stage: task.source.stage, taskId: task.source.taskId },
    });
  const materialsFor = (task: CanonicalTask) =>
    workPackageHas(task) ? ctxFor(task).materials : null;
  const drawingsFor = (task: CanonicalTask) =>
    workPackageHas(task) ? ctxFor(task).governingDocs : null;
  // a task with no package → resolver returns null → honest-empty grain "none"
  function workPackageHas(task: CanonicalTask): boolean {
    return ctxFor(task).workPackageId !== null;
  }

  it("(b) injected materials/drawings land byte-for-byte vs the package, grain 'area-package'", () => {
    const views = projectTaskInstances(index(), { materialsFor, drawingsFor });
    const eastFit = findInstance(views, "east", "fitOff", "t_zip").facets;

    expect(eastFit.material).toEqual({ grain: "area-package", items: eastMaterials });
    expect(eastFit.drawing).toEqual({ grain: "area-package", docs: eastDocs });
    // byte-for-byte (the #368-reuse AC): the items ARE the package's array contents
    expect(eastFit.material.grain === "area-package" && eastFit.material.items).toEqual(eastMaterials);
    expect(eastFit.drawing.grain === "area-package" && eastFit.drawing.docs).toEqual(eastDocs);

    // every task the East package delivers shares its materials/docs (area-package granularity)
    const eastRoughLight = findInstance(views, "east", "roughIn", "t_light").facets;
    expect(eastRoughLight.material).toEqual(eastFit.material);
    expect(eastRoughLight.drawing).toEqual(eastFit.drawing);
  });

  it("(b) a package with no materials/docs → honest-empty grain 'area-package' (zero items), #367 dormant is on-spec", () => {
    const views = projectTaskInstances(index(), { materialsFor, drawingsFor });
    const westFit = findInstance(views, "west", "fitOff", "t_zip").facets;
    // West package exists but carries no scope context → empty arrays, NOT grain "none"
    expect(westFit.material).toEqual({ grain: "area-package", items: [] });
    expect(westFit.drawing).toEqual({ grain: "area-package", docs: [] });
  });

  it("a task belonging to NO package → resolver null → honest-empty grain 'none'", () => {
    const views = projectTaskInstances(index(), { materialsFor, drawingsFor });
    // East roughIn t_zip IS in wpEast; t_light fitOff is in NO package (no taskRef) → none
    const orphan = findInstance(views, "east", "fitOff", "t_zip"); // in package → area-package
    expect(orphan.facets.material.grain).toBe("area-package");
    // west roughIn t_zip is NOT a taskRef of wpWest → no package → grain none
    const noPkg = findInstance(views, "west", "roughIn", "t_zip");
    expect(noPkg.facets.material).toEqual({ grain: "none", reason: "no task-grained material source" });
    expect(noPkg.facets.drawing).toEqual({ grain: "none", reason: "no task-grained drawing source" });
  });
});

describe("#506 projection mutates nothing + preserves identity with facets injected", () => {
  it("(e) does not mutate the input index even with all resolvers wired", () => {
    const tasks = index();
    const before = JSON.stringify(tasks);
    const target = tasks[0]!;
    projectTaskInstances(tasks, {
      blockers: [{ id: "rfi_x", taskId: target.id, type: "rfi", title: "Q", status: "open" }],
      materialsFor: () => [{ label: "x" }],
      drawingsFor: () => [{ documentId: "d" }],
      proofFor: () => null,
    });
    expect(JSON.stringify(tasks)).toBe(before);
  });

  it("(e) preserves the ct_ id and the source coordinate on every view", () => {
    const tasks = index();
    const views = projectTaskInstances(tasks, {
      materialsFor: () => [{ label: "x" }],
      drawingsFor: () => [{ documentId: "d" }],
    });
    views.forEach((v, i) => {
      expect(v.id).toBe(tasks[i]!.id);
      expect(v.id).toMatch(/^ct_[0-9a-f]{8}$/);
      expect(v.source).toEqual(tasks[i]!.source);
    });
  });
});
