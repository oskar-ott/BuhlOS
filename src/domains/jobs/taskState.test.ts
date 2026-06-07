import { describe, expect, it } from "vitest";
import {
  applyTaskState,
  buildWorkerTasks,
  isComplete,
  nextToggleState,
  parseJobTaskState,
  parseTaskToggleResult,
  readTaskState,
  stageProgress,
  taskStateLabel,
  taskStateTone,
  type JobTaskState,
} from "./taskState";
import type { Job, JobArea } from "./types";

/**
 * Pure unit tests for the worker-visible task-state layer. No server, no
 * network — every assertion is about deriving display rows + a write target
 * from the real plan + the real data blob, and never inventing state.
 */

function job(over: Partial<Job> = {}): Job {
  return { id: "job-1", name: "Job", status: "active", ...over } as unknown as Job;
}
function area(over: Partial<JobArea> = {}): JobArea {
  return { id: "area-1", name: "Area", ...over } as unknown as JobArea;
}

describe("parseJobTaskState", () => {
  it("extracts only the rough-in / fit-off task maps from the data blob", () => {
    const parsed = parseJobTaskState({
      dwellings: {
        "area-1": {
          roughIn: { tasks: { t1: "complete", t2: "in_progress" } },
          fitOff: { tasks: { f1: "not_started" } },
        },
      },
      snags: [{ id: "s1" }],
      notes: ["ignore me"],
    });
    expect(parsed).toEqual({
      "area-1": {
        roughIn: { t1: "complete", t2: "in_progress" },
        fitOff: { f1: "not_started" },
      },
    });
  });

  it("drops unrecognised state values rather than trusting the blob", () => {
    const parsed = parseJobTaskState({
      dwellings: {
        "area-1": { roughIn: { tasks: { t1: "complete", t2: "DONE!!", t3: 1 } } },
      },
    });
    expect(parsed).toEqual({
      "area-1": { roughIn: { t1: "complete" }, fitOff: {} },
    });
  });

  it("ignores non-task dwelling fields (materials, audit stamps)", () => {
    const parsed = parseJobTaskState({
      dwellings: {
        "area-1": {
          roughIn: { tasks: { t1: "complete" } },
          materials: { CABLE: 5 },
          lastTouchedBy: "sparky",
          lastTouchedAt: "2026-06-06T00:00:00.000Z",
        },
      },
    });
    expect(parsed).toEqual({
      "area-1": { roughIn: { t1: "complete" }, fitOff: {} },
    });
  });

  it("returns an empty map for missing / malformed input", () => {
    expect(parseJobTaskState(null)).toEqual({});
    expect(parseJobTaskState(undefined)).toEqual({});
    expect(parseJobTaskState({})).toEqual({});
    expect(parseJobTaskState({ dwellings: "nope" })).toEqual({});
    expect(parseJobTaskState("garbage")).toEqual({});
  });
});

describe("parseTaskToggleResult", () => {
  it("accepts a confirmed real task state from the server response", () => {
    expect(parseTaskToggleResult({ state: "complete", changed: true })).toBe("complete");
    expect(parseTaskToggleResult({ state: "not_started" })).toBe("not_started");
  });

  it("rejects malformed success responses so the UI does not invent state", () => {
    expect(parseTaskToggleResult(null)).toBeNull();
    expect(parseTaskToggleResult({})).toBeNull();
    expect(parseTaskToggleResult({ state: "DONE!!" })).toBeNull();
  });
});

describe("readTaskState", () => {
  const state: JobTaskState = {
    "area-1": { roughIn: { t1: "complete" }, fitOff: {} },
  };
  it("returns the recorded state", () => {
    expect(readTaskState(state, "area-1", "roughIn", "t1")).toBe("complete");
  });
  it("defaults to not_started when unrecorded (never guesses)", () => {
    expect(readTaskState(state, "area-1", "roughIn", "tX")).toBe("not_started");
    expect(readTaskState(state, "area-1", "fitOff", "t1")).toBe("not_started");
    expect(readTaskState(state, "area-X", "roughIn", "t1")).toBe("not_started");
  });
});

describe("applyTaskState", () => {
  it("returns a new map with the single change and leaves the input untouched", () => {
    const before: JobTaskState = {
      "area-1": { roughIn: { t1: "not_started" }, fitOff: { f1: "complete" } },
    };
    const after = applyTaskState(before, "area-1", "roughIn", "t1", "complete");
    // the toggled task moved; the sibling fit-off entry is preserved
    expect(after).toEqual({
      "area-1": { roughIn: { t1: "complete" }, fitOff: { f1: "complete" } },
    });
    // input not mutated, and a fresh object returned
    expect(before).toEqual({
      "area-1": { roughIn: { t1: "not_started" }, fitOff: { f1: "complete" } },
    });
    expect(after).not.toBe(before);
  });

  it("seeds a previously-unseen area", () => {
    const after = applyTaskState({}, "area-9", "fitOff", "f1", "complete");
    expect(after).toEqual({
      "area-9": { roughIn: {}, fitOff: { f1: "complete" } },
    });
  });
});

describe("buildWorkerTasks", () => {
  it("derives field-visible rows from the job-level plan, merged with real state", () => {
    const j = job({
      roughInTasks: [
        { id: "t1", name: "Pull power" },
        { id: "t2", name: "Rough lighting" },
      ],
    });
    const a = area();
    const state: JobTaskState = {
      "area-1": { roughIn: { t1: "complete" }, fitOff: {} },
    };
    const rows = buildWorkerTasks(j, a, "roughIn", state);
    expect(rows).toEqual([
      { id: "t1", name: "Pull power", state: "complete" },
      { id: "t2", name: "Rough lighting", state: "not_started" },
    ]);
  });

  it("hides archived tasks — a retired task is never a worker row", () => {
    const j = job({
      roughInTasks: [
        { id: "t1", name: "Pull power" },
        { id: "t2", name: "Old task", archived: true },
      ],
    });
    const rows = buildWorkerTasks(j, area(), "roughIn", {});
    expect(rows.map((r) => r.id)).toEqual(["t1"]);
  });

  it("uses the area override when present (ignores the job-level template)", () => {
    const j = job({ roughInTasks: [{ id: "t1", name: "Job task" }] });
    const a = area({ roughInTasks: [{ id: "a1", name: "Area task" }] });
    const rows = buildWorkerTasks(j, a, "roughIn", {});
    expect(rows.map((r) => r.name)).toEqual(["Area task"]);
  });

  it("returns no rows when the stage has no plan", () => {
    expect(buildWorkerTasks(job(), area(), "fitOff", {})).toEqual([]);
  });
});

describe("stageProgress", () => {
  it("counts only real completions", () => {
    expect(
      stageProgress([
        { id: "a", name: "a", state: "complete" },
        { id: "b", name: "b", state: "in_progress" },
        { id: "c", name: "c", state: "not_started" },
      ]),
    ).toEqual({ total: 3, complete: 1 });
  });
  it("handles the empty list", () => {
    expect(stageProgress([])).toEqual({ total: 0, complete: 0 });
  });
});

describe("nextToggleState (binary v1)", () => {
  it("marks not-done tasks complete", () => {
    expect(nextToggleState("not_started")).toBe("complete");
    expect(nextToggleState("in_progress")).toBe("complete");
  });
  it("undoes a done task back to not_started", () => {
    expect(nextToggleState("complete")).toBe("not_started");
  });
});

describe("display helpers", () => {
  it("isComplete is true only for complete", () => {
    expect(isComplete("complete")).toBe(true);
    expect(isComplete("in_progress")).toBe(false);
    expect(isComplete("not_started")).toBe(false);
  });
  it("labels each state", () => {
    expect(taskStateLabel("not_started")).toBe("To do");
    expect(taskStateLabel("in_progress")).toBe("In progress");
    expect(taskStateLabel("complete")).toBe("Done");
  });
  it("maps state → status-pill tone", () => {
    expect(taskStateTone("complete")).toBe("success");
    expect(taskStateTone("in_progress")).toBe("info");
    expect(taskStateTone("not_started")).toBe("neutral");
  });
});
