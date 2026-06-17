import { describe, expect, it } from "vitest";
import {
  buildCanonicalTaskIndex,
  deriveCanonicalTaskId,
  type CanonicalTask,
} from "./task-index";
import {
  canonicalIdForCoordinate,
  canonicalTaskToCoordinate,
  coordinateForCanonicalId,
  findCanonicalTaskByCoordinate,
  findCanonicalTaskById,
  resolveCanonicalTaskById,
  resolveCanonicalTaskForCoordinate,
  taskCoordinateKey,
  taskCoordinateMatchesCanonicalTask,
  taskCoordinateToSource,
  type TaskCoordinate,
} from "./task-ref";
import { parseJobTaskState } from "./taskState";
import type { Job } from "./types";

/**
 * #501 — the surface-agnostic canonical-id ⇄ coordinate bridge. Proves both
 * directions resolve against the index, the new ct_ → coordinate reverse lookup
 * works, identity stays tuple-derived (no bare-taskId collapse across areas or
 * stages), and resolution never mutates.
 */

function job(over: Partial<Job> = {}): Job {
  return { id: "j1", name: "J1", status: "active", ...over } as unknown as Job;
}

/** Same template id in both areas AND both stages → 4 distinct instances. */
const sharedTemplate = job({
  roughInTasks: [{ id: "t_shared", name: "Rough-in power circuit" }],
  fitOffTasks: [{ id: "t_shared", name: "Rough-in power circuit" }],
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

const index = () => buildCanonicalTaskIndex({ job: sharedTemplate });

describe("forward — coordinate → canonical task", () => {
  it("resolves an existing coordinate; tuple identity is exact", () => {
    const idx = index();
    const found = findCanonicalTaskByCoordinate(idx, { areaId: "east", stage: "roughIn", taskId: "t_shared" });
    expect(found?.areaId).toBe("east");
    expect(found?.stage).toBe("roughIn");
    expect(found?.templateId).toBe("t_shared");
  });

  it("a coordinate for one area never resolves another area's instance", () => {
    const idx = index();
    const east = findCanonicalTaskByCoordinate(idx, { areaId: "east", stage: "roughIn", taskId: "t_shared" });
    const west = findCanonicalTaskByCoordinate(idx, { areaId: "west", stage: "roughIn", taskId: "t_shared" });
    expect(east?.templateId).toBe(west?.templateId);
    expect(east?.id).not.toBe(west?.id);
    expect(taskCoordinateMatchesCanonicalTask({ areaId: "east", stage: "roughIn", taskId: "t_shared" }, west as CanonicalTask)).toBe(false);
  });

  it("unknown coordinate / empty index → null", () => {
    const idx = index();
    expect(findCanonicalTaskByCoordinate(idx, { areaId: "ghost", stage: "roughIn", taskId: "t_shared" })).toBeNull();
    expect(findCanonicalTaskByCoordinate(idx, { areaId: "east", stage: "roughIn", taskId: "nope" })).toBeNull();
    expect(findCanonicalTaskByCoordinate([], { areaId: "east", stage: "roughIn", taskId: "t_shared" })).toBeNull();
  });
});

describe("reverse — canonical id / task → coordinate (the #483 gap)", () => {
  it("findCanonicalTaskById recovers the instance from a bare ct_ id", () => {
    const idx = index();
    const id = deriveCanonicalTaskId({ jobId: "j1", areaId: "west", stage: "fitOff", taskId: "t_shared" });
    const found = findCanonicalTaskById(idx, id);
    expect(found?.areaId).toBe("west");
    expect(found?.stage).toBe("fitOff");
    expect(findCanonicalTaskById(idx, "ct_deadbeef")).toBeNull();
  });

  it("coordinateForCanonicalId returns the source coordinate, null when unknown", () => {
    const idx = index();
    const id = deriveCanonicalTaskId({ jobId: "j1", areaId: "east", stage: "fitOff", taskId: "t_shared" });
    expect(coordinateForCanonicalId(idx, id)).toEqual({ areaId: "east", stage: "fitOff", taskId: "t_shared" });
    expect(coordinateForCanonicalId(idx, "ct_00000000")).toBeNull();
  });

  it("two ct_ ids of the same template resolve to their OWN distinct coordinates", () => {
    const idx = index();
    const eastId = deriveCanonicalTaskId({ jobId: "j1", areaId: "east", stage: "roughIn", taskId: "t_shared" });
    const westId = deriveCanonicalTaskId({ jobId: "j1", areaId: "west", stage: "roughIn", taskId: "t_shared" });
    expect(eastId).not.toBe(westId);
    expect(coordinateForCanonicalId(idx, eastId)).toEqual({ areaId: "east", stage: "roughIn", taskId: "t_shared" });
    expect(coordinateForCanonicalId(idx, westId)).toEqual({ areaId: "west", stage: "roughIn", taskId: "t_shared" });
  });
});

describe("round-trips and id helpers", () => {
  it("coordinate → id → coordinate is stable for every instance", () => {
    const idx = index();
    for (const task of idx) {
      const coord = canonicalTaskToCoordinate(task);
      const id = canonicalIdForCoordinate(task.jobId, coord);
      expect(id).toBe(task.id); // id helper agrees with the index
      expect(coordinateForCanonicalId(idx, id)).toEqual(coord);
    }
  });

  it("canonicalIdForCoordinate equals deriveCanonicalTaskId", () => {
    const coord: TaskCoordinate = { areaId: "east", stage: "fitOff", taskId: "t_shared" };
    expect(canonicalIdForCoordinate("j1", coord)).toBe(
      deriveCanonicalTaskId({ jobId: "j1", areaId: "east", stage: "fitOff", taskId: "t_shared" }),
    );
  });

  it("taskCoordinateToSource / taskCoordinateKey are faithful", () => {
    const coord: TaskCoordinate = { areaId: "a", stage: "roughIn", taskId: "t" };
    expect(taskCoordinateToSource(coord)).toEqual({ areaId: "a", stage: "roughIn", taskId: "t" });
    expect(taskCoordinateKey(coord)).toBe("a::roughIn::t");
  });
});

describe("job-level convenience resolvers", () => {
  it("resolveCanonicalTaskForCoordinate builds the index and carries state", () => {
    const taskState = parseJobTaskState({
      dwellings: { east: { roughIn: { tasks: { t_shared: "complete" } } } },
    });
    const found = resolveCanonicalTaskForCoordinate({
      job: sharedTemplate,
      taskState,
      coord: { areaId: "east", stage: "roughIn", taskId: "t_shared" },
    });
    expect(found?.areaId).toBe("east");
    expect(found?.state).toBe("complete");
    expect(
      resolveCanonicalTaskForCoordinate({ job: sharedTemplate, coord: { areaId: "ghost", stage: "roughIn", taskId: "t_shared" } }),
    ).toBeNull();
  });

  it("resolveCanonicalTaskById builds the index and resolves by ct_ id", () => {
    const id = deriveCanonicalTaskId({ jobId: "j1", areaId: "west", stage: "fitOff", taskId: "t_shared" });
    const found = resolveCanonicalTaskById({ job: sharedTemplate, id });
    expect(found?.areaId).toBe("west");
    expect(found?.stage).toBe("fitOff");
    expect(resolveCanonicalTaskById({ job: sharedTemplate, id: "ct_deadbeef" })).toBeNull();
  });
});

describe("purity — resolution never mutates the index", () => {
  it("leaves the input array and tasks untouched", () => {
    const idx = index();
    const before = JSON.stringify(idx);
    findCanonicalTaskByCoordinate(idx, { areaId: "east", stage: "roughIn", taskId: "t_shared" });
    findCanonicalTaskById(idx, idx[0]!.id);
    coordinateForCanonicalId(idx, idx[0]!.id);
    expect(JSON.stringify(idx)).toBe(before);
  });
});
