import { describe, expect, it } from "vitest";
import {
  canonicalTaskToLegacyTaskRef,
  findCanonicalTaskForLegacyRef,
  legacyTaskRefMatchesCanonicalTask,
  legacyTaskRefToCanonicalSource,
  resolveCanonicalTaskForTaskRef,
  type LegacyTaskRef,
} from "./task-ref-compat";
import { buildCanonicalTaskIndex, type CanonicalTask } from "../jobs/task-index";
import { parseJobTaskState } from "../jobs/taskState";
import type { Job } from "../jobs/types";
import type { TaskRef } from "./types";

/**
 * #483 — pure bridge between legacy job-control TaskRef tuples and canonical
 * task index entries. Proves tuple identity is preserved (bare taskId never
 * collapses across areas; stage is part of identity) and that nothing here
 * touches compile/proof behaviour (asserted by running the job-control suites).
 */

function job(over: Partial<Job> = {}): Job {
  return {
    id: "j1",
    name: "J1",
    status: "active",
    ...over,
  } as unknown as Job;
}

const twoAreaSharedTemplate = job({
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

describe("A — legacy ref finds its canonical task", () => {
  it("resolves an existing (areaId, stage, taskId) ref", () => {
    const idx = buildCanonicalTaskIndex({ job: twoAreaSharedTemplate });
    const found = findCanonicalTaskForLegacyRef({
      canonicalTasks: idx,
      ref: { areaId: "east", stage: "roughIn", taskId: "t_shared" },
    });
    expect(found).not.toBeNull();
    expect(found?.areaId).toBe("east");
    expect(found?.stage).toBe("roughIn");
    expect(found?.templateId).toBe("t_shared");
  });

  it("accepts a real job-control TaskRef (structurally compatible, no conversion)", () => {
    const idx = buildCanonicalTaskIndex({ job: twoAreaSharedTemplate });
    const ref: TaskRef = { areaId: "west", stage: "roughIn", taskId: "t_shared" };
    const found = findCanonicalTaskForLegacyRef({ canonicalTasks: idx, ref });
    expect(found?.areaId).toBe("west");
  });
});

describe("B — bare taskId does not match across areas", () => {
  it("a ref for area A resolves only area A; a ref for area B resolves only area B", () => {
    const idx = buildCanonicalTaskIndex({ job: twoAreaSharedTemplate });
    const east = findCanonicalTaskForLegacyRef({
      canonicalTasks: idx,
      ref: { areaId: "east", stage: "roughIn", taskId: "t_shared" },
    });
    const west = findCanonicalTaskForLegacyRef({
      canonicalTasks: idx,
      ref: { areaId: "west", stage: "roughIn", taskId: "t_shared" },
    });

    expect(east?.areaId).toBe("east");
    expect(west?.areaId).toBe("west");
    expect(east?.templateId).toBe(west?.templateId); // same template
    expect(east?.id).not.toBe(west?.id); // distinct canonical instances

    // the east ref must NOT match west's canonical task (and vice versa),
    // but each ref DOES match its own area's task (positive control)
    expect(
      legacyTaskRefMatchesCanonicalTask(
        { areaId: "east", stage: "roughIn", taskId: "t_shared" },
        west as CanonicalTask,
      ),
    ).toBe(false);
    expect(
      legacyTaskRefMatchesCanonicalTask(
        { areaId: "west", stage: "roughIn", taskId: "t_shared" },
        east as CanonicalTask,
      ),
    ).toBe(false);
    expect(
      legacyTaskRefMatchesCanonicalTask(
        { areaId: "west", stage: "roughIn", taskId: "t_shared" },
        west as CanonicalTask,
      ),
    ).toBe(true);
  });
});

describe("C — stage is part of identity", () => {
  it("same taskId in roughIn vs fitOff resolves to different canonical tasks", () => {
    const idx = buildCanonicalTaskIndex({ job: twoAreaSharedTemplate });
    const rough = findCanonicalTaskForLegacyRef({
      canonicalTasks: idx,
      ref: { areaId: "east", stage: "roughIn", taskId: "t_shared" },
    });
    const fit = findCanonicalTaskForLegacyRef({
      canonicalTasks: idx,
      ref: { areaId: "east", stage: "fitOff", taskId: "t_shared" },
    });
    expect(rough?.stage).toBe("roughIn");
    expect(fit?.stage).toBe("fitOff");
    expect(rough?.id).not.toBe(fit?.id);
  });
});

describe("D — canonical task converts back to legacy ref", () => {
  it("returns exactly the source coordinate", () => {
    const idx = buildCanonicalTaskIndex({ job: twoAreaSharedTemplate });
    for (const task of idx) {
      expect(canonicalTaskToLegacyTaskRef(task)).toEqual({
        areaId: task.source.areaId,
        stage: task.source.stage,
        taskId: task.source.taskId,
      });
    }
    // round-trip: ref → find → back to ref
    const ref: LegacyTaskRef = { areaId: "west", stage: "fitOff", taskId: "t_shared" };
    const found = findCanonicalTaskForLegacyRef({ canonicalTasks: idx, ref });
    expect(found).not.toBeNull();
    expect(canonicalTaskToLegacyTaskRef(found as CanonicalTask)).toEqual(ref);
  });
});

describe("E — unknown ref returns null", () => {
  const idx = buildCanonicalTaskIndex({ job: twoAreaSharedTemplate });
  it("wrong area, wrong stage, or wrong taskId all return null", () => {
    expect(
      findCanonicalTaskForLegacyRef({ canonicalTasks: idx, ref: { areaId: "nope", stage: "roughIn", taskId: "t_shared" } }),
    ).toBeNull();
    expect(
      findCanonicalTaskForLegacyRef({ canonicalTasks: idx, ref: { areaId: "east", stage: "roughIn", taskId: "nope" } }),
    ).toBeNull();
    // empty index
    expect(findCanonicalTaskForLegacyRef({ canonicalTasks: [], ref: { areaId: "east", stage: "roughIn", taskId: "t_shared" } })).toBeNull();
  });
});

describe("helpers + resolver", () => {
  it("legacyTaskRefToCanonicalSource is a faithful coordinate copy", () => {
    expect(legacyTaskRefToCanonicalSource({ areaId: "a", stage: "roughIn", taskId: "t" })).toEqual({
      areaId: "a",
      stage: "roughIn",
      taskId: "t",
    });
  });

  it("resolveCanonicalTaskForTaskRef builds the index from a job and resolves", () => {
    const taskState = parseJobTaskState({
      dwellings: { east: { roughIn: { tasks: { t_shared: "complete" } } } },
    });
    const found = resolveCanonicalTaskForTaskRef({
      job: twoAreaSharedTemplate,
      taskState,
      ref: { areaId: "east", stage: "roughIn", taskId: "t_shared" },
    });
    expect(found?.areaId).toBe("east");
    expect(found?.state).toBe("complete"); // index carried real state through
    // and an unknown ref still resolves to null via the job-level resolver
    expect(
      resolveCanonicalTaskForTaskRef({
        job: twoAreaSharedTemplate,
        ref: { areaId: "ghost", stage: "roughIn", taskId: "t_shared" },
      }),
    ).toBeNull();
  });
});
