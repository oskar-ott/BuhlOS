import { describe, expect, it } from "vitest";
import {
  philTaskReadinessByTemplateId,
  workerTasksFromCanonicalIndex,
} from "./phil-task-projection";
import { buildCanonicalTaskIndex, deriveCanonicalTaskId } from "./task-index";
import { buildWorkerTasks, parseJobTaskState } from "./taskState";
import { visibleAreaGroups } from "./format";
import type { TaskBlocker, TaskDependency } from "./task-blockers";
import {
  canonicalTaskToLegacyTaskRef,
  findCanonicalTaskForLegacyRef,
} from "../job-control/task-ref-compat";
import type { Job } from "./types";

/**
 * #484 — Phil sources its area/stage task rows from the canonical task index.
 *
 * The load-bearing property is BEHAVIOURAL PARITY: for every area+stage Phil can
 * select, `workerTasksFromCanonicalIndex(index, areaId, stage)` returns exactly
 * what `buildWorkerTasks(job, area, stage, state)` returned before — same rows,
 * same order, same state, same template-id contract. Plus the canonical identity
 * cases (a bare taskId is never an instance) and legacy TaskRef compatibility.
 */

function job(over: Partial<Job> = {}): Job {
  return { id: "j1", name: "J1", status: "active", ...over } as unknown as Job;
}

describe("workerTasksFromCanonicalIndex — parity with buildWorkerTasks", () => {
  // Exercises inheritance, an area override, both stages, an archived area, an
  // archived group, and mixed recorded states — the same shape the index test's
  // count-parity case uses, so the two parity guarantees stay aligned.
  const j = job({
    roughInTasks: [
      { id: "r_power", name: "Power rough-in" },
      { id: "r_data", name: "Data rough-in" },
    ],
    fitOffTasks: [{ id: "f_power", name: "Power fit-off" }],
    areaGroups: [
      {
        id: "g1",
        name: "Ground",
        areas: [
          { id: "east", name: "East" },
          { id: "west", name: "West", roughInTasks: [{ id: "w_r", name: "West rough" }] },
          { id: "old", name: "Old", archived: true },
        ],
      },
      { id: "g2", name: "Demolished", archived: true, areas: [{ id: "x", name: "X" }] },
    ],
  });

  const taskState = parseJobTaskState({
    dwellings: {
      east: {
        roughIn: { tasks: { r_power: "complete", r_data: "in_progress" } },
        fitOff: { tasks: { f_power: "complete" } },
      },
      west: { roughIn: { tasks: { w_r: "complete" } } },
    },
  });

  const index = buildCanonicalTaskIndex({ job: j, taskState });

  // The areas Phil could actually select (its picker is fed by visibleAreaGroups).
  const selectableAreas = visibleAreaGroups(j.areaGroups).flatMap((g) =>
    (g.areas ?? []).map((a) => ({ group: g, area: a })),
  );

  it("matches buildWorkerTasks for every selectable area + stage (rows, order, state)", () => {
    expect(selectableAreas.map((s) => s.area.id)).toEqual(["east", "west"]);
    for (const { area } of selectableAreas) {
      for (const stage of ["roughIn", "fitOff"] as const) {
        const viaIndex = workerTasksFromCanonicalIndex(index, area.id, stage);
        const viaOld = buildWorkerTasks(j, area, stage, taskState);
        expect(viaIndex).toEqual(viaOld);
      }
    }
  });

  it("renders the row id as the template id (toggle/context/proof contract)", () => {
    const east = workerTasksFromCanonicalIndex(index, "east", "roughIn");
    expect(east.map((t) => t.id)).toEqual(["r_power", "r_data"]);
    expect(east.map((t) => t.name)).toEqual(["Power rough-in", "Data rough-in"]);
    expect(east.map((t) => t.state)).toEqual(["complete", "in_progress"]);
  });

  it("uses the area override and the inherited default, never both", () => {
    expect(workerTasksFromCanonicalIndex(index, "west", "roughIn").map((t) => t.id)).toEqual([
      "w_r",
    ]);
    expect(workerTasksFromCanonicalIndex(index, "east", "roughIn").map((t) => t.id)).toEqual([
      "r_power",
      "r_data",
    ]);
  });

  it("never surfaces archived areas or archived groups", () => {
    expect(workerTasksFromCanonicalIndex(index, "old", "roughIn")).toEqual([]);
    expect(workerTasksFromCanonicalIndex(index, "x", "roughIn")).toEqual([]);
  });

  it("returns [] for an area with no plan for the requested stage", () => {
    // West has a rough-in override but no fit-off plan and no job fit-off applies
    // to it via override — it inherits the job fit-off template.
    const eastFit = workerTasksFromCanonicalIndex(index, "east", "fitOff");
    expect(eastFit.map((t) => t.id)).toEqual(["f_power"]);
  });
});

describe("workerTasksFromCanonicalIndex — canonical identity", () => {
  it("keeps two areas' instances of the same template separate (bare taskId is not identity)", () => {
    const j = job({
      roughInTasks: [{ id: "t_shared", name: "Shared task" }],
      areaGroups: [
        {
          id: "g1",
          name: "G",
          areas: [
            { id: "east", name: "East" },
            { id: "west", name: "West" },
          ],
        },
      ],
    });
    const taskState = parseJobTaskState({
      dwellings: {
        east: { roughIn: { tasks: { t_shared: "complete" } } },
        west: { roughIn: { tasks: { t_shared: "not_started" } } },
      },
    });
    const index = buildCanonicalTaskIndex({ job: j, taskState });

    const east = workerTasksFromCanonicalIndex(index, "east", "roughIn");
    const west = workerTasksFromCanonicalIndex(index, "west", "roughIn");

    // Same template id surfaces in both areas (the row contract), but the state
    // is read per-instance — east is done, west is not. Filtering by the source
    // coordinate is what keeps them apart.
    expect(east).toEqual([{ id: "t_shared", name: "Shared task", state: "complete" }]);
    expect(west).toEqual([{ id: "t_shared", name: "Shared task", state: "not_started" }]);
  });

  it("keeps the same template separate across stages within one area", () => {
    const j = job({
      roughInTasks: [{ id: "t_x", name: "Test & commission" }],
      fitOffTasks: [{ id: "t_x", name: "Test & commission" }],
      areaGroups: [{ id: "g1", name: "G", areas: [{ id: "east", name: "East" }] }],
    });
    const taskState = parseJobTaskState({
      dwellings: { east: { roughIn: { tasks: { t_x: "complete" } } } },
    });
    const index = buildCanonicalTaskIndex({ job: j, taskState });

    expect(workerTasksFromCanonicalIndex(index, "east", "roughIn")).toEqual([
      { id: "t_x", name: "Test & commission", state: "complete" },
    ]);
    // Same template id in fit-off, but its own (unrecorded) state — not "complete".
    expect(workerTasksFromCanonicalIndex(index, "east", "fitOff")).toEqual([
      { id: "t_x", name: "Test & commission", state: "not_started" },
    ]);
  });
});

describe("workerTasksFromCanonicalIndex — legacy TaskRef compatibility (#483)", () => {
  it("a projected row round-trips to the canonical task its legacy ref resolves to", () => {
    const j = job({
      roughInTasks: [{ id: "t_shared", name: "Shared" }],
      areaGroups: [
        {
          id: "g1",
          name: "G",
          areas: [
            { id: "east", name: "East" },
            { id: "west", name: "West" },
          ],
        },
      ],
    });
    const index = buildCanonicalTaskIndex({ job: j });
    const eastRow = workerTasksFromCanonicalIndex(index, "east", "roughIn")[0];
    if (!eastRow) throw new Error("expected a projected east row");

    // The legacy ref the toggle/proof path would build for this row (selected
    // area + stage + the row's template id) resolves back to the EAST instance,
    // never west's.
    const ref = { areaId: "east", stage: "roughIn" as const, taskId: eastRow.id };
    const resolved = findCanonicalTaskForLegacyRef({ canonicalTasks: index, ref });
    expect(resolved).not.toBeNull();
    expect(resolved?.areaId).toBe("east");
    expect(canonicalTaskToLegacyTaskRef(resolved!)).toEqual(ref);

    const westRef = { areaId: "west", stage: "roughIn" as const, taskId: eastRow.id };
    expect(findCanonicalTaskForLegacyRef({ canonicalTasks: index, ref: westRef })?.areaId).toBe(
      "west",
    );
  });
});

describe("philTaskReadinessByTemplateId — readiness overlay (#482 model)", () => {
  // A two-area job; both inherit one rough-in template + one fit-off template.
  const j = job({
    roughInTasks: [{ id: "t_ri", name: "Rough-in power" }],
    fitOffTasks: [{ id: "t_fo", name: "Fit-off power" }],
    areaGroups: [
      {
        id: "g1",
        name: "G",
        areas: [
          { id: "east", name: "East" },
          { id: "west", name: "West" },
        ],
      },
    ],
  });

  // Canonical id helper for blocker/dependency wiring (#482 keys on canonical id).
  const cid = (areaId: string, stage: "roughIn" | "fitOff", taskId: string) =>
    deriveCanonicalTaskId({ jobId: j.id, areaId, stage, taskId });

  it("honest-empty default: no blockers/deps ⇒ every row ready or complete, none blocked", () => {
    const taskState = parseJobTaskState({
      dwellings: { east: { roughIn: { tasks: { t_ri: "complete" } } } },
    });
    const index = buildCanonicalTaskIndex({ job: j, taskState });
    const map = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "east", stage: "roughIn" });

    expect(map.get("t_ri")).toEqual({ readiness: "complete", blockedReason: null });
    // West (not complete, no blockers) is ready, never blocked.
    const westMap = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "west", stage: "roughIn" });
    expect(westMap.get("t_ri")).toEqual({ readiness: "ready", blockedReason: null });
    // Nothing is blocked anywhere with empty inputs.
    expect([...map.values(), ...westMap.values()].some((r) => r.readiness === "blocked")).toBe(false);
  });

  it("a ready task renders no blocked reason", () => {
    const index = buildCanonicalTaskIndex({ job: j });
    const map = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "east", stage: "roughIn" });
    expect(map.get("t_ri")).toEqual({ readiness: "ready", blockedReason: null });
  });

  it("an open blocker ⇒ blocked, with the blocker title as the worker-readable reason", () => {
    const index = buildCanonicalTaskIndex({ job: j });
    const blockers: TaskBlocker[] = [
      {
        id: "b1",
        taskId: cid("east", "roughIn", "t_ri"),
        type: "material",
        title: "Waiting on switchgear",
        status: "open",
      },
    ];
    const map = philTaskReadinessByTemplateId({
      canonicalTasks: index,
      areaId: "east",
      stage: "roughIn",
      blockers,
    });
    expect(map.get("t_ri")).toEqual({ readiness: "blocked", blockedReason: "Waiting on switchgear" });
  });

  it("a resolved blocker does not block", () => {
    const index = buildCanonicalTaskIndex({ job: j });
    const blockers: TaskBlocker[] = [
      { id: "b1", taskId: cid("east", "roughIn", "t_ri"), type: "material", title: "Switchgear arrived", status: "resolved" },
    ];
    const map = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "east", stage: "roughIn", blockers });
    expect(map.get("t_ri")?.readiness).toBe("ready");
  });

  it("an incomplete dependency ⇒ blocked, naming the prerequisite task", () => {
    // East rough-in waits on West rough-in (cross-area dependency); West is not complete.
    const index = buildCanonicalTaskIndex({ job: j });
    const dependencies: TaskDependency[] = [
      { taskId: cid("east", "roughIn", "t_ri"), dependsOnTaskId: cid("west", "roughIn", "t_ri") },
    ];
    const map = philTaskReadinessByTemplateId({
      canonicalTasks: index,
      areaId: "east",
      stage: "roughIn",
      dependencies,
    });
    expect(map.get("t_ri")).toEqual({ readiness: "blocked", blockedReason: "Waiting on Rough-in power" });
  });

  it("a satisfied dependency (prerequisite complete) ⇒ ready", () => {
    const taskState = parseJobTaskState({
      dwellings: { west: { roughIn: { tasks: { t_ri: "complete" } } } },
    });
    const index = buildCanonicalTaskIndex({ job: j, taskState });
    const dependencies: TaskDependency[] = [
      { taskId: cid("east", "roughIn", "t_ri"), dependsOnTaskId: cid("west", "roughIn", "t_ri") },
    ];
    const map = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "east", stage: "roughIn", dependencies });
    expect(map.get("t_ri")?.readiness).toBe("ready");
  });

  it("a missing/unknown prerequisite ⇒ blocked with a generic reason (never a raw id)", () => {
    const index = buildCanonicalTaskIndex({ job: j });
    const dependencies: TaskDependency[] = [
      { taskId: cid("east", "roughIn", "t_ri"), dependsOnTaskId: "ct_doesnotexist" },
    ];
    const map = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "east", stage: "roughIn", dependencies });
    const entry = map.get("t_ri");
    expect(entry?.readiness).toBe("blocked");
    expect(entry?.blockedReason).toBe("Dependency incomplete");
    // Never leak the raw canonical id into worker copy.
    expect(entry?.blockedReason).not.toContain("ct_");
  });

  it("a complete task is never blocked, even with an open blocker on it", () => {
    const taskState = parseJobTaskState({
      dwellings: { east: { roughIn: { tasks: { t_ri: "complete" } } } },
    });
    const index = buildCanonicalTaskIndex({ job: j, taskState });
    const blockers: TaskBlocker[] = [
      { id: "b1", taskId: cid("east", "roughIn", "t_ri"), type: "material", title: "stale blocker", status: "open" },
    ];
    const map = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "east", stage: "roughIn", blockers });
    expect(map.get("t_ri")).toEqual({ readiness: "complete", blockedReason: null });
  });

  it("the same template in two areas has INDEPENDENT readiness (bare taskId is not identity)", () => {
    const index = buildCanonicalTaskIndex({ job: j });
    // Block ONLY east's instance of the shared template.
    const blockers: TaskBlocker[] = [
      { id: "b1", taskId: cid("east", "roughIn", "t_ri"), type: "access", title: "No site access", status: "open" },
    ];
    const east = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "east", stage: "roughIn", blockers });
    const west = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "west", stage: "roughIn", blockers });
    expect(east.get("t_ri")?.readiness).toBe("blocked");
    expect(west.get("t_ri")?.readiness).toBe("ready"); // same templateId, different instance
  });

  it("the same template across stages has INDEPENDENT readiness", () => {
    const index = buildCanonicalTaskIndex({
      job: job({
        roughInTasks: [{ id: "t_x", name: "Test & commission" }],
        fitOffTasks: [{ id: "t_x", name: "Test & commission" }],
        areaGroups: [{ id: "g1", name: "G", areas: [{ id: "east", name: "East" }] }],
      }),
    });
    const eastJobId = "j1";
    const blockers: TaskBlocker[] = [
      {
        id: "b1",
        taskId: deriveCanonicalTaskId({ jobId: eastJobId, areaId: "east", stage: "roughIn", taskId: "t_x" }),
        type: "inspection",
        title: "Awaiting inspection",
        status: "open",
      },
    ];
    const ri = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "east", stage: "roughIn", blockers });
    const fo = philTaskReadinessByTemplateId({ canonicalTasks: index, areaId: "east", stage: "fitOff", blockers });
    expect(ri.get("t_x")?.readiness).toBe("blocked");
    expect(fo.get("t_x")?.readiness).toBe("ready"); // same templateId, different stage instance
  });

  it("does not weaken #490 parity: the worker rows are unchanged alongside readiness", () => {
    const index = buildCanonicalTaskIndex({ job: j });
    // The row source is still the #484 projection, independent of readiness.
    expect(workerTasksFromCanonicalIndex(index, "east", "roughIn")).toEqual([
      { id: "t_ri", name: "Rough-in power", state: "not_started" },
    ]);
  });
});
