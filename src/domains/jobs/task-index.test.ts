import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  buildCanonicalTaskIndex,
  canonicalTaskMatchesSource,
  canonicalTaskSourceKey,
  deriveCanonicalTaskId,
  type CanonicalTask,
} from "./task-index";
import { jobTaskProgress, type DwellingsState } from "./progress";
import { parseJobTaskState } from "./taskState";
import type { Job } from "./types";

/**
 * #480 — the canonical task index materialises one instance per
 * `(areaId, stage, taskId)` with a stable, deterministic, non-name-based id.
 *
 * The load-bearing property: a job-level template inherited by N areas yields N
 * canonical tasks with the SAME templateId but DISTINCT ids (test E). Plus a
 * hard parity check that the index never drifts from the canonical progress
 * count definition (test F), asserted against BOTH the TS `jobTaskProgress` and
 * the CJS `jobTaskCounts` mirror that powers the withStats enrichment.
 */

const requireFromHere = createRequire(import.meta.url);
const cjs = requireFromHere("../../../api/_lib/job-tasks.js") as {
  jobTaskCounts: (job: unknown, dwellings: unknown) => { total: number; complete: number };
};

function job(over: Partial<Job> = {}): Job {
  return {
    id: "j1",
    name: "J1",
    status: "active",
    ...over,
  } as unknown as Job;
}

const find = (idx: CanonicalTask[], areaId: string) => {
  const t = idx.find((c) => c.areaId === areaId);
  if (!t) throw new Error(`no canonical task for area ${areaId}`);
  return t;
};

describe("deriveCanonicalTaskId", () => {
  it("is deterministic and stable for the same tuple", () => {
    const a = deriveCanonicalTaskId({ jobId: "j", areaId: "a", stage: "roughIn", taskId: "t" });
    const b = deriveCanonicalTaskId({ jobId: "j", areaId: "a", stage: "roughIn", taskId: "t" });
    expect(a).toBe(b);
    expect(a).toMatch(/^ct_[0-9a-f]{8}$/);
  });

  it("changes when any coordinate changes (not name-based)", () => {
    const base = deriveCanonicalTaskId({ jobId: "j", areaId: "a", stage: "roughIn", taskId: "t" });
    expect(deriveCanonicalTaskId({ jobId: "j2", areaId: "a", stage: "roughIn", taskId: "t" })).not.toBe(base);
    expect(deriveCanonicalTaskId({ jobId: "j", areaId: "a2", stage: "roughIn", taskId: "t" })).not.toBe(base);
    expect(deriveCanonicalTaskId({ jobId: "j", areaId: "a", stage: "fitOff", taskId: "t" })).not.toBe(base);
    expect(deriveCanonicalTaskId({ jobId: "j", areaId: "a", stage: "roughIn", taskId: "t2" })).not.toBe(base);
  });
});

describe("A — job-level default tasks materialise into each area", () => {
  const j = job({
    roughInTasks: [{ id: "t_power", name: "Power rough-in" }],
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

  it("creates one canonical task per area, same template, distinct ids", () => {
    const idx = buildCanonicalTaskIndex({ job: j });
    expect(idx).toHaveLength(2);
    expect(idx.every((t) => t.templateId === "t_power")).toBe(true);
    expect(idx.every((t) => t.stage === "roughIn")).toBe(true);
    expect(idx.every((t) => t.system === "general")).toBe(true);
    expect(idx.every((t) => t.title === "Power rough-in")).toBe(true);

    expect([...idx.map((t) => t.areaId)].sort()).toEqual(["east", "west"]);
    expect(new Set(idx.map((t) => t.id)).size).toBe(2);
    expect(find(idx, "east").areaRefs).toEqual(["east"]);
  });
});

describe("B — area override wins (matches effectiveTasks exactly)", () => {
  const j = job({
    roughInTasks: [{ id: "t_default", name: "Default rough-in" }],
    areaGroups: [
      {
        id: "g1",
        name: "Ground",
        areas: [
          { id: "east", name: "East", roughInTasks: [{ id: "t_area", name: "Area-specific rough-in" }] },
          { id: "west", name: "West" },
        ],
      },
    ],
  });

  it("uses the override for the overriding area and the default elsewhere, never both", () => {
    const idx = buildCanonicalTaskIndex({ job: j });
    const east = idx.filter((t) => t.areaId === "east");
    const west = idx.filter((t) => t.areaId === "west");

    expect(east).toHaveLength(1);
    expect(find(idx, "east").templateId).toBe("t_area");

    expect(west).toHaveLength(1);
    expect(find(idx, "west").templateId).toBe("t_default");
  });
});

describe("C — rough-in and fit-off stay distinct even for the same template", () => {
  it("same template id+name across stages produces distinct canonical ids", () => {
    const j = job({
      roughInTasks: [{ id: "t_x", name: "Test & commission" }],
      fitOffTasks: [{ id: "t_x", name: "Test & commission" }],
      areaGroups: [{ id: "g1", name: "G", areas: [{ id: "east", name: "East" }] }],
    });
    const idx = buildCanonicalTaskIndex({ job: j });
    expect(idx).toHaveLength(2);

    const roughIn = idx.find((t) => t.stage === "roughIn");
    const fitOff = idx.find((t) => t.stage === "fitOff");
    expect(roughIn).toBeDefined();
    expect(fitOff).toBeDefined();
    expect(roughIn?.templateId).toBe("t_x");
    expect(fitOff?.templateId).toBe("t_x");
    expect(roughIn?.id).not.toBe(fitOff?.id);
  });
});

describe("D — state is read from current task state", () => {
  const j = job({
    roughInTasks: [{ id: "t1", name: "T1" }],
    areaGroups: [{ id: "g1", name: "G", areas: [{ id: "east", name: "East" }] }],
  });

  it("reads the recorded state", () => {
    const taskState = parseJobTaskState({
      dwellings: { east: { roughIn: { tasks: { t1: "complete" } } } },
    });
    const idx = buildCanonicalTaskIndex({ job: j, taskState });
    expect(idx.at(0)?.state).toBe("complete");
  });

  it("defaults to not_started when unrecorded (and when no state is passed)", () => {
    expect(buildCanonicalTaskIndex({ job: j }).at(0)?.state).toBe("not_started");
    expect(buildCanonicalTaskIndex({ job: j, taskState: null }).at(0)?.state).toBe("not_started");
    const empty = parseJobTaskState({ dwellings: {} });
    expect(buildCanonicalTaskIndex({ job: j, taskState: empty }).at(0)?.state).toBe("not_started");
  });
});

describe("E — bare taskId is NOT canonical identity (the critical case)", () => {
  it("an inherited template in two areas yields same templateId, distinct ids", () => {
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
    const idx = buildCanonicalTaskIndex({ job: j });
    const east = find(idx, "east");
    const west = find(idx, "west");

    expect(east.templateId).toBe(west.templateId);
    expect(east.templateId).toBe("t_shared");
    expect(east.id).not.toBe(west.id);

    // round-trips back to its source coordinate
    expect(canonicalTaskMatchesSource(east, { areaId: "east", stage: "roughIn", taskId: "t_shared" })).toBe(true);
    expect(canonicalTaskMatchesSource(east, { areaId: "west", stage: "roughIn", taskId: "t_shared" })).toBe(false);
    expect(east.source).toEqual({ areaId: "east", stage: "roughIn", taskId: "t_shared" });
    expect(canonicalTaskSourceKey(east.source)).toBe("east::roughIn::t_shared");
  });
});

describe("F — count parity with the existing progress definition", () => {
  // Exercises inheritance, an override, an archived area, an archived group,
  // and mixed states (complete / in_progress / unrecorded).
  const j = job({
    roughInTasks: [
      { id: "r1", name: "R1" },
      { id: "r2", name: "R2" },
    ],
    fitOffTasks: [{ id: "f1", name: "F1" }],
    areaGroups: [
      {
        id: "g1",
        name: "G1",
        areas: [
          { id: "east", name: "East" },
          { id: "west", name: "West", roughInTasks: [{ id: "w_r", name: "W rough" }] },
          { id: "old", name: "Old", archived: true },
        ],
      },
      { id: "g2", name: "Demolished", archived: true, areas: [{ id: "x", name: "X" }] },
    ],
  });

  const dwellings: DwellingsState = {
    east: {
      roughIn: { tasks: { r1: "complete", r2: "in_progress" } },
      fitOff: { tasks: { f1: "complete" } },
    },
    west: { roughIn: { tasks: { w_r: "complete" } } },
    // archived areas carry state in real data; it must be excluded by both sides
    old: { roughIn: { tasks: { r1: "complete", r2: "complete" } } },
  };

  it("index length == jobTaskProgress.total and complete count matches (TS + CJS)", () => {
    const progress = jobTaskProgress(j, dwellings);
    const taskState = parseJobTaskState({ dwellings });
    const idx = buildCanonicalTaskIndex({ job: j, taskState });

    // sanity: the fixture really exercises the exclusions
    expect(progress.total).toBe(5);
    expect(progress.complete).toBe(3);

    expect(idx).toHaveLength(progress.total);
    expect(idx.filter((t) => t.state === "complete")).toHaveLength(progress.complete);

    // and against the CJS mirror that powers /api/jobs withStats
    const cjsCounts = cjs.jobTaskCounts(j, dwellings);
    expect(idx).toHaveLength(cjsCounts.total);
    expect(idx.filter((t) => t.state === "complete")).toHaveLength(cjsCounts.complete);

    // no archived-area task leaked in
    expect(idx.some((t) => t.areaId === "old" || t.areaId === "x")).toBe(false);
  });
});
