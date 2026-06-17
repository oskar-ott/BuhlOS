import { describe, expect, it } from "vitest";
import { workerTasksFromCanonicalIndex } from "./phil-task-projection";
import { buildCanonicalTaskIndex } from "./task-index";
import { buildWorkerTasks, parseJobTaskState } from "./taskState";
import { visibleAreaGroups } from "./format";
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
