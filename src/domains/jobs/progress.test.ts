import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  areaTaskCounts,
  jobTaskProgress,
  progressCaption,
  progressPct,
  stageTaskCounts,
  type DwellingsState,
} from "./progress";
import type { Job, JobArea } from "./types";

/**
 * #198 — THE canonical progress definition, table-tested, plus the parity
 * check against the CJS mirror (api/_lib/job-tasks.js) that powers the
 * withStats enrichment — the two implementations may never disagree.
 */

const requireFromHere = createRequire(import.meta.url);
const cjs = requireFromHere("../../../api/_lib/job-tasks.js") as {
  jobTaskCounts: (job: unknown, dwellings: unknown) => { total: number; complete: number };
  areaProgressPct: (job: unknown, area: unknown, dwellings: unknown) => number | null;
};

function job(over: Partial<Job> = {}): Job {
  return {
    id: "j1",
    name: "J1",
    status: "active",
    roughInTasks: [
      { id: "rt1", name: "Rough 1" },
      { id: "rt2", name: "Rough 2" },
    ],
    fitOffTasks: [{ id: "ft1", name: "Fit 1" }],
    areaGroups: [
      {
        id: "g1",
        name: "Ground",
        areas: [
          { id: "a1", name: "Kitchen" },
          { id: "a2", name: "Laundry", archived: true },
        ],
      },
      { id: "g2", name: "Demolished", archived: true, areas: [{ id: "a3", name: "Old" }] },
    ],
    ...over,
  } as unknown as Job;
}

const DW: DwellingsState = {
  a1: {
    roughIn: { tasks: { rt1: "complete", rt2: "in_progress" } },
    fitOff: { tasks: { ft1: "complete" } },
  },
  a2: { roughIn: { tasks: { rt1: "complete", rt2: "complete" } } },
  a3: { roughIn: { tasks: { rt1: "complete", rt2: "complete" } } },
};

describe("the canonical definition", () => {
  it("counts complete-only (in_progress is NOT complete), per stage", () => {
    const a1 = { id: "a1", name: "Kitchen" } as Pick<JobArea, "id" | "name" | "roughInTasks" | "fitOffTasks">;
    expect(stageTaskCounts(job(), a1, "roughIn", DW)).toEqual({ total: 2, complete: 1 });
    expect(stageTaskCounts(job(), a1, "fitOff", DW)).toEqual({ total: 1, complete: 1 });
    expect(areaTaskCounts(job(), a1, DW)).toEqual({ total: 3, complete: 2 });
  });

  it("excludes archived areas and groups from job progress entirely", () => {
    const p = jobTaskProgress(job(), DW);
    // only a1 counts: 3 tasks, 2 complete — the fully-complete archived
    // areas can never inflate the number
    expect(p).toMatchObject({ total: 3, complete: 2, pct: 67 });
    expect(p.byStage.roughIn).toEqual({ total: 2, complete: 1 });
    expect(p.byStage.fitOff).toEqual({ total: 1, complete: 1 });
  });

  it("excludes archived tasks via the same resolver Phil uses", () => {
    const j = job({
      roughInTasks: [
        { id: "rt1", name: "Live" },
        { id: "rtx", name: "Old", archived: true },
      ] as Job["roughInTasks"],
      fitOffTasks: [],
    });
    const a1 = { id: "a1", name: "Kitchen" } as Pick<JobArea, "id" | "name" | "roughInTasks" | "fitOffTasks">;
    expect(stageTaskCounts(j, a1, "roughIn", DW)).toEqual({ total: 1, complete: 1 });
  });

  it("a non-empty per-area override replaces the default; an empty one inherits", () => {
    const a = {
      id: "a1",
      name: "K",
      roughInTasks: [{ id: "ov1", name: "Override" }],
    } as Pick<JobArea, "id" | "name" | "roughInTasks" | "fitOffTasks">;
    expect(stageTaskCounts(job(), a, "roughIn", {})).toEqual({ total: 1, complete: 0 });
    const empty = { id: "a1", name: "K", roughInTasks: [] } as unknown as Pick<
      JobArea,
      "id" | "name" | "roughInTasks" | "fitOffTasks"
    >;
    expect(stageTaskCounts(job(), empty, "roughIn", {})).toEqual({ total: 2, complete: 0 });
  });

  it("zero tasks → pct null and an honest caption, never 0% or 100%", () => {
    const p = jobTaskProgress(job({ roughInTasks: [], fitOffTasks: [], areaGroups: [] }), {});
    expect(p).toMatchObject({ total: 0, complete: 0, pct: null });
    expect(progressPct(p)).toBeNull();
    expect(progressCaption(p)).toBe("No tasks yet");
    expect(progressCaption({ total: 3, complete: 2 })).toBe("2/3 done");
  });

  it("missing dwellings state means nothing is complete", () => {
    expect(jobTaskProgress(job(), undefined)).toMatchObject({ total: 3, complete: 0, pct: 0 });
  });
});

describe("CJS parity (api/_lib/job-tasks.js powers withStats)", () => {
  it("jobTaskCounts agrees with the canonical on every fixture", () => {
    const fixtures: Array<[Job, DwellingsState | undefined]> = [
      [job(), DW],
      [job(), undefined],
      [job({ roughInTasks: [], fitOffTasks: [], areaGroups: [] }), {}],
      [
        job({
          roughInTasks: [
            { id: "rt1", name: "Live" },
            { id: "rtx", name: "Old", archived: true },
          ] as Job["roughInTasks"],
        }),
        DW,
      ],
    ];
    for (const [j, dw] of fixtures) {
      const ts = jobTaskProgress(j, dw);
      const js = cjs.jobTaskCounts(j, dw ?? {});
      expect(js).toEqual({ total: ts.total, complete: ts.complete });
    }
  });

  it("areaProgressPct agrees with the canonical pooled pct", () => {
    const a1 = { id: "a1", name: "Kitchen" } as Pick<JobArea, "id" | "name" | "roughInTasks" | "fitOffTasks">;
    const ts = progressPct(areaTaskCounts(job(), a1, DW));
    expect(cjs.areaProgressPct(job(), a1, DW)).toBe(ts);
    expect(cjs.areaProgressPct(job({ roughInTasks: [], fitOffTasks: [] }), a1, {})).toBeNull();
  });
});
