import { describe, expect, it } from "vitest";
import { rollUpJobTaskProgress, rollUpTaskProgress } from "./task-progress-rollup";
import { buildCanonicalTaskIndex } from "./task-index";
import {
  areaTaskCounts,
  jobTaskProgress,
  progressPct,
  stageTaskCounts,
  type DwellingsState,
} from "./progress";
import { parseJobTaskState } from "./taskState";
import type { Job, JobArea } from "./types";

/**
 * #507 — the canonical task-instance progress rollup. The whole point is STRICT
 * PARITY with the existing canonical progress definition (#198, progress.ts):
 * the job / stage / area numbers derived through the instance projection must
 * equal `jobTaskProgress` / `stageTaskCounts` / `areaTaskCounts` for the same
 * job + state. `bySystem` (#481) is the only new dimension — an additive
 * breakdown of the same pooled tasks, never a competing job percentage.
 */

function job(over: Partial<Job> = {}): Job {
  return { id: "j1", name: "J1", status: "active", ...over } as unknown as Job;
}

describe("rollUpTaskProgress — parity with the canonical progress definition (#198)", () => {
  // Same fixture as task-index.test.ts test F: inheritance, an override, an
  // archived area, an archived group, and mixed states.
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
    // archived-area state must be excluded by both engines
    old: { roughIn: { tasks: { r1: "complete", r2: "complete" } } },
  };

  const taskState = parseJobTaskState({ dwellings });
  const idx = buildCanonicalTaskIndex({ job: j, taskState });
  const rollup = rollUpTaskProgress(idx);

  it("job-level counts + pct equal jobTaskProgress (one canonical number)", () => {
    const progress = jobTaskProgress(j, dwellings);
    // sanity: the fixture really exercises inheritance + exclusions
    expect(progress.total).toBe(5);
    expect(progress.complete).toBe(3);
    expect(rollup.job).toEqual({
      total: progress.total,
      complete: progress.complete,
      pct: progress.pct,
    });
  });

  it("byStage matches jobTaskProgress.byStage (both stages, honest pct)", () => {
    const progress = jobTaskProgress(j, dwellings);
    for (const stage of ["roughIn", "fitOff"] as const) {
      expect(rollup.byStage[stage]).toEqual({
        total: progress.byStage[stage].total,
        complete: progress.byStage[stage].complete,
        pct: progressPct(progress.byStage[stage]),
      });
    }
  });

  it("byArea matches areaTaskCounts for every non-archived area, and excludes archived ones", () => {
    const liveAreas: JobArea[] = (j.areaGroups ?? [])
      .filter((g) => !g.archived)
      .flatMap((g) => (g.areas ?? []).filter((a) => !a.archived));

    // every live area is present and parity-correct
    for (const area of liveAreas) {
      const counts = areaTaskCounts(j, area, dwellings);
      expect(rollup.byArea[area.id]).toEqual({
        total: counts.total,
        complete: counts.complete,
        pct: progressPct(counts),
      });
    }
    // and ONLY the live areas appear (no archived east/west… 'old'/'x' leak)
    expect(Object.keys(rollup.byArea).sort()).toEqual(["east", "west"]);
    expect(rollup.byArea.east).toEqual({ total: 3, complete: 2, pct: 67 });
    expect(rollup.byArea.west).toEqual({ total: 2, complete: 1, pct: 50 });
  });

  it("per-area-per-stage spot check still reconciles to stageTaskCounts", () => {
    // The rollup pools area across stages; confirm the underlying instances it
    // pooled match the canonical per-area-per-stage counts they came from.
    const east = (j.areaGroups ?? [])[0]?.areas?.find((a) => a.id === "east") as JobArea;
    const eastRough = stageTaskCounts(j, east, "roughIn", dwellings);
    const eastFit = stageTaskCounts(j, east, "fitOff", dwellings);
    expect(eastRough).toEqual({ total: 2, complete: 1 }); // r1 complete, r2 in_progress
    expect(eastFit).toEqual({ total: 1, complete: 1 }); // f1 complete
    const eastRollup = rollup.byArea.east;
    expect(eastRollup).toBeDefined();
    expect(eastRollup?.total).toBe(eastRough.total + eastFit.total);
    expect(eastRollup?.complete).toBe(eastRough.complete + eastFit.complete);
  });

  it("bySystem is an additive breakdown that pools back to the job total", () => {
    // This fixture's task names are all non-electrical → every instance is 'general'.
    expect(rollup.bySystem).toEqual({ general: { total: 5, complete: 3, pct: 60 } });
    const summed = Object.values(rollup.bySystem).reduce(
      (acc, c) => ({ total: acc.total + c.total, complete: acc.complete + c.complete }),
      { total: 0, complete: 0 },
    );
    expect(summed).toEqual({ total: rollup.job.total, complete: rollup.job.complete });
  });
});

describe("rollUpTaskProgress — bySystem splits real electrical systems (#481)", () => {
  const elec = job({
    roughInTasks: [
      { id: "p1", name: "Power GPO rough-in" }, // power
      { id: "l1", name: "Lighting batten rough-in" }, // lighting
    ],
    fitOffTasks: [{ id: "d1", name: "Data outlet fit-off" }], // data
    areaGroups: [
      { id: "g", name: "G", areas: [{ id: "a1", name: "A1" }, { id: "a2", name: "A2" }] },
    ],
  });
  // Complete only the power task in a1.
  const dwellings: DwellingsState = { a1: { roughIn: { tasks: { p1: "complete" } } } };

  it("classifies and pools each system; the breakdown sums to the job total", () => {
    const rollup = rollUpJobTaskProgress({ job: elec, taskState: parseJobTaskState({ dwellings }) });

    expect(rollup.job).toEqual({ total: 6, complete: 1, pct: 17 });
    expect(rollup.bySystem.power).toEqual({ total: 2, complete: 1, pct: 50 });
    expect(rollup.bySystem.lighting).toEqual({ total: 2, complete: 0, pct: 0 });
    expect(rollup.bySystem.data).toEqual({ total: 2, complete: 0, pct: 0 });

    const summed = Object.values(rollup.bySystem).reduce((n, c) => n + c.total, 0);
    expect(summed).toBe(rollup.job.total);
    // parity sanity: same number as the canonical engine
    expect(rollup.job.total).toBe(jobTaskProgress(elec, dwellings).total);
    expect(rollup.job.complete).toBe(jobTaskProgress(elec, dwellings).complete);
  });
});

describe("rollUpTaskProgress — honest-empty for a job with no tasks", () => {
  it("returns zero counts and a null pct, never a fake 0% or 100%", () => {
    const empty = job({ areaGroups: [] });
    const rollup = rollUpJobTaskProgress({ job: empty });
    expect(rollup.job).toEqual({ total: 0, complete: 0, pct: null });
    expect(rollup.byStage.roughIn).toEqual({ total: 0, complete: 0, pct: null });
    expect(rollup.byStage.fitOff).toEqual({ total: 0, complete: 0, pct: null });
    expect(rollup.byArea).toEqual({});
    expect(rollup.bySystem).toEqual({});
  });
});
