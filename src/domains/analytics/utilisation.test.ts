import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #342 — crew utilisation maths. Expected hours = 7.6h × Mon–Fri (NOT the legacy
 * flat 40); a % only where expected > 0; weeks before a worker existed excluded;
 * crew capacity roll-up. CJS (the serverless endpoint requires it).
 */
const requireFromHere = createRequire(import.meta.url);
const u = requireFromHere("../../../api/_lib/utilisation.js") as {
  expectedWeekHours: (d?: number, s?: number) => number;
  utilisationPct: (logged: number, expected: number) => number | null;
  mondayOf: (date: string) => string;
  trailingWeeks: (today: string, count: number) => string[];
  buildWorkerUtilisation: (userId: string, name: string, weeks: Array<Record<string, unknown>>) => {
    weeks: Array<{ weekStart: string; pct: number | null; expectedHours: number | null; excluded: boolean }>;
    avgPct: number | null;
  };
  crewCapacity: (latest: string | null, workers: unknown[]) => { expectedHours: number; spareHours: number; workers: number };
};

describe("expected hours + utilisation %", () => {
  it("uses 7.6h × 5 = 38h, not the legacy flat 40", () => {
    expect(u.expectedWeekHours()).toBe(38);
    expect(u.expectedWeekHours(4)).toBe(30.4); // a 4-day week
  });
  it("computes % and returns null (never a fake 0) when nothing was expected", () => {
    expect(u.utilisationPct(38, 38)).toBe(100);
    expect(u.utilisationPct(19, 38)).toBe(50);
    expect(u.utilisationPct(10, 0)).toBeNull();
  });
});

describe("week helpers", () => {
  it("mondayOf returns the Monday of the ISO week", () => {
    expect(u.mondayOf("2026-06-24")).toBe("2026-06-22"); // Wed → Mon
    expect(u.mondayOf("2026-06-22")).toBe("2026-06-22"); // Mon → itself
    expect(u.mondayOf("2026-06-28")).toBe("2026-06-22"); // Sun → that week's Mon
  });
  it("trailingWeeks lists N Mondays oldest → newest ending this week", () => {
    expect(u.trailingWeeks("2026-06-24", 3)).toEqual(["2026-06-08", "2026-06-15", "2026-06-22"]);
  });
});

describe("buildWorkerUtilisation — multi-week, honest gaps", () => {
  it("excludes weeks the worker wasn't expected (not 0%) and averages only included weeks", () => {
    const w = u.buildWorkerUtilisation("u1", "Sparky", [
      { weekStart: "2026-06-08", approvedHours: 0, submittedHours: 0, expected: false }, // before they existed
      { weekStart: "2026-06-15", approvedHours: 38, submittedHours: 0, expected: true }, // 100%
      { weekStart: "2026-06-22", approvedHours: 19, submittedHours: 0, expected: true }, // 50%
    ]);
    expect(w.weeks[0]!.excluded).toBe(true);
    expect(w.weeks[0]!.pct).toBeNull();
    expect(w.weeks[1]!.pct).toBe(100);
    expect(w.weeks[2]!.pct).toBe(50);
    expect(w.avgPct).toBe(75); // mean(100, 50) — the excluded week ignored
  });

  it("counts submitted + approved toward utilisation", () => {
    const w = u.buildWorkerUtilisation("u1", "Sparky", [
      { weekStart: "2026-06-22", approvedHours: 19, submittedHours: 19, expected: true },
    ]);
    expect(w.weeks[0]!.pct).toBe(100); // (19+19)/38
  });
});

describe("crewCapacity — can we take this job", () => {
  it("rolls up the latest week's expected vs logged + spare capacity", () => {
    const workers = [
      u.buildWorkerUtilisation("u1", "A", [{ weekStart: "2026-06-22", approvedHours: 38, submittedHours: 0, expected: true }]),
      u.buildWorkerUtilisation("u2", "B", [{ weekStart: "2026-06-22", approvedHours: 19, submittedHours: 0, expected: true }]),
      u.buildWorkerUtilisation("u3", "C", [{ weekStart: "2026-06-22", approvedHours: 0, submittedHours: 0, expected: false }]), // excluded
    ];
    const cap = u.crewCapacity("2026-06-22", workers);
    expect(cap.workers).toBe(2); // C excluded
    expect(cap.expectedHours).toBe(76); // 38 × 2
    expect(cap.spareHours).toBe(76 - 38 - 19); // 19h spare
  });
});
