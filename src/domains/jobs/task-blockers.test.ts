import { describe, expect, it } from "vitest";
import {
  deriveTaskReadiness,
  findBlockingDependencies,
  taskHasOpenBlockers,
  type TaskBlocker,
  type TaskDependency,
} from "./task-blockers";
import { buildCanonicalTaskIndex, type CanonicalTask } from "./task-index";
import type { Job } from "./types";

/**
 * #482 — read-only task blocker/dependency/readiness model over canonical task
 * ids. Proves the conservative readiness rules and that dependencies cross
 * areas because canonical ids are job-level.
 */

function job(over: Partial<Job> = {}): Job {
  return { id: "j1", name: "J1", status: "active", ...over } as unknown as Job;
}

// A job with three areas, each inheriting a single rough-in task. Canonical ids
// differ per area, so a dependency from one area to another is well-defined.
const threeAreas = job({
  roughInTasks: [{ id: "t", name: "Rough-in power circuit" }],
  areaGroups: [
    {
      id: "g1",
      name: "G",
      areas: [
        { id: "east", name: "East" },
        { id: "west", name: "West" },
        { id: "north", name: "North" },
      ],
    },
  ],
});

const canonicalOf = (tasks: CanonicalTask[], areaId: string): CanonicalTask => {
  const t = tasks.find((x) => x.areaId === areaId);
  if (!t) throw new Error(`no task for ${areaId}`);
  return t;
};

describe("deriveTaskReadiness", () => {
  it("a complete task is 'complete', never 'ready'", () => {
    const tasks = buildCanonicalTaskIndex({
      job: threeAreas,
      taskState: { east: { roughIn: { t: "complete" }, fitOff: {} } },
    });
    const east = canonicalOf(tasks, "east");
    expect(east.state).toBe("complete");
    expect(deriveTaskReadiness({ task: east })).toBe("complete");
  });

  it("an open blocker makes a task 'blocked'", () => {
    const tasks = buildCanonicalTaskIndex({ job: threeAreas });
    const east = canonicalOf(tasks, "east");
    const blockers: TaskBlocker[] = [
      { id: "b1", taskId: east.id, type: "material", title: "Awaiting switchgear", status: "open" },
    ];
    expect(deriveTaskReadiness({ task: east, blockers })).toBe("blocked");
  });

  it("a resolved blocker does not block", () => {
    const tasks = buildCanonicalTaskIndex({ job: threeAreas });
    const east = canonicalOf(tasks, "east");
    const blockers: TaskBlocker[] = [
      { id: "b1", taskId: east.id, type: "material", title: "Switchgear arrived", status: "resolved" },
    ];
    expect(taskHasOpenBlockers({ taskId: east.id, blockers })).toBe(false);
    expect(deriveTaskReadiness({ task: east, blockers })).toBe("ready");
  });

  it("an incomplete dependency blocks; a complete dependency allows 'ready'", () => {
    // west depends on east. east incomplete → west blocked. east complete → west ready.
    const incomplete = buildCanonicalTaskIndex({ job: threeAreas });
    const eastIncomplete = canonicalOf(incomplete, "east");
    const westIncomplete = canonicalOf(incomplete, "west");
    const deps: TaskDependency[] = [{ taskId: westIncomplete.id, dependsOnTaskId: eastIncomplete.id }];
    expect(deriveTaskReadiness({ task: westIncomplete, dependencies: deps, tasks: incomplete })).toBe("blocked");

    const done = buildCanonicalTaskIndex({
      job: threeAreas,
      taskState: { east: { roughIn: { t: "complete" }, fitOff: {} } },
    });
    const westReady = canonicalOf(done, "west");
    const depsDone: TaskDependency[] = [
      { taskId: westReady.id, dependsOnTaskId: canonicalOf(done, "east").id },
    ];
    expect(deriveTaskReadiness({ task: westReady, dependencies: depsDone, tasks: done })).toBe("ready");
  });

  it("a missing dependency blocks conservatively", () => {
    const tasks = buildCanonicalTaskIndex({ job: threeAreas });
    const west = canonicalOf(tasks, "west");
    const deps: TaskDependency[] = [{ taskId: west.id, dependsOnTaskId: "ct_does_not_exist" }];
    // prerequisite unknown → blocking (even when tasks omitted entirely)
    expect(deriveTaskReadiness({ task: west, dependencies: deps, tasks })).toBe("blocked");
    expect(deriveTaskReadiness({ task: west, dependencies: deps })).toBe("blocked");
  });

  it("no blockers and no dependencies → 'ready'", () => {
    const tasks = buildCanonicalTaskIndex({ job: threeAreas });
    expect(deriveTaskReadiness({ task: canonicalOf(tasks, "east") })).toBe("ready");
  });
});

describe("findBlockingDependencies", () => {
  it("returns only the edges whose prerequisite is not complete", () => {
    const tasks = buildCanonicalTaskIndex({
      job: threeAreas,
      taskState: { east: { roughIn: { t: "complete" }, fitOff: {} } }, // east done, west/north not
    });
    const east = canonicalOf(tasks, "east");
    const west = canonicalOf(tasks, "west");
    const north = canonicalOf(tasks, "north");
    const deps: TaskDependency[] = [
      { taskId: north.id, dependsOnTaskId: east.id }, // east complete → not blocking
      { taskId: north.id, dependsOnTaskId: west.id }, // west incomplete → blocking
    ];
    const blocking = findBlockingDependencies({ tasks, dependencies: deps });
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.dependsOnTaskId).toBe(west.id);
  });
});

describe("one blocker affects multiple tasks (via dependency fan-out, cross-area)", () => {
  it("a single open blocker on an upstream task blocks every downstream task in other areas", () => {
    const tasks = buildCanonicalTaskIndex({ job: threeAreas });
    const upstream = canonicalOf(tasks, "east"); // the shared prerequisite
    const downA = canonicalOf(tasks, "west"); // different area
    const downB = canonicalOf(tasks, "north"); // different area

    // canonical ids are job-level + unique per area, so cross-area edges are valid
    expect(new Set([upstream.id, downA.id, downB.id]).size).toBe(3);
    expect(upstream.areaId).not.toBe(downA.areaId);
    expect(downA.areaId).not.toBe(downB.areaId);

    // ONE blocker, on the upstream task only
    const blockers: TaskBlocker[] = [
      {
        id: "b1",
        taskId: upstream.id,
        type: "access",
        title: "No site access to east riser",
        status: "open",
        areaRefs: [upstream.areaId],
      },
    ];
    const deps: TaskDependency[] = [
      { taskId: downA.id, dependsOnTaskId: upstream.id },
      { taskId: downB.id, dependsOnTaskId: upstream.id },
    ];

    // upstream itself is blocked by its own open blocker
    expect(deriveTaskReadiness({ task: upstream, blockers, dependencies: deps, tasks })).toBe("blocked");
    // and BOTH downstream tasks are blocked because the prerequisite isn't complete
    expect(deriveTaskReadiness({ task: downA, blockers, dependencies: deps, tasks })).toBe("blocked");
    expect(deriveTaskReadiness({ task: downB, blockers, dependencies: deps, tasks })).toBe("blocked");
  });
});

describe("cross-area dependencies rely on job-level canonical ids", () => {
  it("the same template inherited by two areas gives two distinct prerequisite ids", () => {
    const tasks = buildCanonicalTaskIndex({ job: threeAreas });
    const east = canonicalOf(tasks, "east");
    const west = canonicalOf(tasks, "west");
    // same template, different canonical id → a dependency targets the RIGHT area
    expect(east.templateId).toBe(west.templateId);
    expect(east.id).not.toBe(west.id);

    // north depends specifically on EAST (complete), not WEST (incomplete)
    const done = buildCanonicalTaskIndex({
      job: threeAreas,
      taskState: { east: { roughIn: { t: "complete" }, fitOff: {} } },
    });
    const northDone = canonicalOf(done, "north");
    const eastDone = canonicalOf(done, "east");
    const deps: TaskDependency[] = [{ taskId: northDone.id, dependsOnTaskId: eastDone.id }];
    expect(deriveTaskReadiness({ task: northDone, dependencies: deps, tasks: done })).toBe("ready");
  });
});
