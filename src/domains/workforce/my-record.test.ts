import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #340 — "your work record" maths (the self-only trailing window behind the
 * Phil More-tab card). Pure CJS so the serverless endpoint (api/my-stats.js)
 * requires the same module the UI's numbers come from.
 *
 * Pins: trailing-week bucketing onto the real calendar; per-job hours from
 * allocations, deduped + most-worked-first; entries outside the window
 * ignored; and the new-starter case → an honest zero (real weeks at 0h, no
 * jobs, total 0), never a fabricated number (P7).
 */
const requireFromHere = createRequire(import.meta.url);
const m = requireFromHere("../../../api/_lib/my-record.js") as {
  DEFAULT_WEEKS: number;
  mondayOf: (date: string) => string;
  sundayOf: (weekStart: string) => string;
  trailingWeeks: (today: string, count: number) => string[];
  buildMyRecord: (
    entries: Array<Record<string, unknown>>,
    opts: { todayIso: string; weeks?: number; jobNameById?: Record<string, string> }
  ) => {
    weeks: Array<{ weekStart: string; weekEnd: string; totalHours: number }>;
    jobs: Array<{ jobId: string; jobName: string; hours: number }>;
    totalHours: number;
    weekCount: number;
    windowStart: string;
    windowEnd: string;
  };
};

describe("week helpers", () => {
  it("mondayOf returns the Monday of the ISO week (Sun belongs to that week)", () => {
    expect(m.mondayOf("2026-06-24")).toBe("2026-06-22"); // Wed → Mon
    expect(m.mondayOf("2026-06-22")).toBe("2026-06-22"); // Mon → itself
    expect(m.mondayOf("2026-06-28")).toBe("2026-06-22"); // Sun → that week's Mon
    expect(m.mondayOf("not-a-date")).toBe("");
  });
  it("sundayOf closes the week 6 days after its Monday", () => {
    expect(m.sundayOf("2026-06-22")).toBe("2026-06-28");
  });
  it("trailingWeeks lists N Mondays oldest → newest ending this week", () => {
    expect(m.trailingWeeks("2026-06-24", 3)).toEqual([
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
    ]);
  });
});

describe("buildMyRecord — trailing-weeks bucketing", () => {
  const entries = [
    // this week (Mon 2026-06-22 … Sun 2026-06-28)
    { date: "2026-06-22", totalHours: 7.6, allocations: [{ jobId: "j1", hours: 7.6 }] },
    { date: "2026-06-24", totalHours: 8, allocations: [{ jobId: "j2", hours: 8 }] },
    // previous week
    { date: "2026-06-16", totalHours: 7.6, allocations: [{ jobId: "j1", hours: 7.6 }] },
  ];

  it("buckets hours into the real calendar week they fall in, oldest → newest", () => {
    const r = m.buildMyRecord(entries, { todayIso: "2026-06-24", weeks: 3 });
    expect(r.weeks.map((w) => w.weekStart)).toEqual([
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
    ]);
    expect(r.weeks[0]!.totalHours).toBe(0); // empty week shown honestly at 0
    expect(r.weeks[1]!.totalHours).toBe(7.6); // prev week
    expect(r.weeks[2]!.totalHours).toBe(15.6); // 7.6 + 8 this week
    expect(r.weeks[2]!.weekEnd).toBe("2026-06-28");
    expect(r.totalHours).toBe(23.2);
    expect(r.weekCount).toBe(3);
    expect(r.windowStart).toBe("2026-06-08");
    expect(r.windowEnd).toBe("2026-06-28");
  });

  it("ignores entries that fall outside the trailing window", () => {
    const r = m.buildMyRecord(
      [
        { date: "2026-06-22", totalHours: 7.6, allocations: [{ jobId: "j1", hours: 7.6 }] },
        // three weeks before the window's first Monday — excluded
        { date: "2026-05-18", totalHours: 7.6, allocations: [{ jobId: "j9", hours: 7.6 }] },
      ],
      { todayIso: "2026-06-24", weeks: 3 }
    );
    expect(r.totalHours).toBe(7.6);
    expect(r.jobs.map((j) => j.jobId)).toEqual(["j1"]);
  });

  it("defaults to a 6-week window when weeks is omitted", () => {
    const r = m.buildMyRecord(entries, { todayIso: "2026-06-24" });
    expect(r.weeks).toHaveLength(m.DEFAULT_WEEKS);
    expect(r.weeks).toHaveLength(6);
  });
});

describe("buildMyRecord — jobs you've worked", () => {
  it("dedupes a job across days/weeks, sums allocation hours, most-worked first", () => {
    const r = m.buildMyRecord(
      [
        { date: "2026-06-22", totalHours: 7.6, allocations: [{ jobId: "j1", hours: 7.6 }] },
        { date: "2026-06-23", totalHours: 8, allocations: [{ jobId: "j1", hours: 4 }, { jobId: "j2", hours: 4 }] },
        { date: "2026-06-24", totalHours: 8, allocations: [{ jobId: "j2", hours: 8 }] },
      ],
      { todayIso: "2026-06-24", weeks: 2, jobNameById: { j1: "Riverside", j2: "Depot" } }
    );
    expect(r.jobs).toEqual([
      { jobId: "j2", jobName: "Depot", hours: 12 }, // 4 + 8
      { jobId: "j1", jobName: "Riverside", hours: 11.6 }, // 7.6 + 4
    ]);
  });

  it("falls back to the jobId as the name when none is resolved", () => {
    const r = m.buildMyRecord(
      [{ date: "2026-06-22", totalHours: 7.6, allocations: [{ jobId: "j7", hours: 7.6 }] }],
      { todayIso: "2026-06-24", weeks: 2 }
    );
    expect(r.jobs[0]!.jobName).toBe("j7");
  });

  it("drops zero-hour allocations from the jobs list (no empty rows)", () => {
    const r = m.buildMyRecord(
      [{ date: "2026-06-22", totalHours: 7.6, allocations: [{ jobId: "j1", hours: 7.6 }, { jobId: "j2", hours: 0 }] }],
      { todayIso: "2026-06-24", weeks: 2 }
    );
    expect(r.jobs.map((j) => j.jobId)).toEqual(["j1"]);
  });
});

describe("buildMyRecord — new starter (honest zero, P7)", () => {
  it("no entries → real calendar of weeks at 0h, no jobs, total 0 (never fabricated)", () => {
    const r = m.buildMyRecord([], { todayIso: "2026-06-24", weeks: 6 });
    expect(r.weeks).toHaveLength(6);
    expect(r.weeks.every((w) => w.totalHours === 0)).toBe(true);
    expect(r.jobs).toEqual([]);
    expect(r.totalHours).toBe(0);
    expect(r.windowStart).toBe("2026-05-18");
    expect(r.windowEnd).toBe("2026-06-28");
  });
});
