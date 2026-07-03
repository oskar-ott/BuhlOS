import { describe, it, expect } from "vitest";
import {
  classifyTimeOverrun,
  timeOverrunView,
  OVERRUN_THRESHOLDS,
  type TimeOverrunInput,
} from "./time-overrun";

/**
 * Fixtures for the #343 time-overrun rules core. Each case is the injected
 * `{ estimatedHours, hoursConsumed, progressPct }` triple the real read surface
 * feeds the pure classifier — mirroring the fixture style of
 * src/domains/qa/time-entry-attribution.ts.
 */

describe("classifyTimeOverrun — honest no-data states", () => {
  it("no-estimate: null estimate never guesses a number (P7)", () => {
    const flag = classifyTimeOverrun({
      estimatedHours: null,
      hoursConsumed: 120,
      progressPct: 20,
    });
    expect(flag.state).toBe("no-estimate");
    expect(flag.flagged).toBe(false);
    expect(flag.severity).toBe("ok");
    expect(flag.burnPct).toBeNull();
    expect(flag.estimatedHours).toBeNull();
    // The consumed hours are still echoed honestly — only the estimate is absent.
    expect(flag.hoursConsumed).toBe(120);
    // The completion side is still echoed even when we can't watch time.
    expect(flag.completePct).toBe(20);
    expect(flag.reason).toMatch(/no time estimate set/i);
  });

  it("no-estimate: undefined / zero / negative estimate all collapse to no-estimate", () => {
    for (const estimatedHours of [undefined, 0, -50] as const) {
      const flag = classifyTimeOverrun({ estimatedHours, hoursConsumed: 40, progressPct: 10 });
      expect(flag.state, `estimate=${estimatedHours}`).toBe("no-estimate");
      expect(flag.estimatedHours).toBeNull();
    }
  });

  it("no-progress: estimate + burn present but no task lists → can't compare", () => {
    const flag = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 90,
      progressPct: null,
    });
    expect(flag.state).toBe("no-progress");
    expect(flag.flagged).toBe(false);
    expect(flag.burnPct).toBe(90); // burn side IS computable
    expect(flag.completePct).toBeNull();
    expect(flag.gapPct).toBeNull();
    expect(flag.reason).toMatch(/no tasks set up/i);
  });

  it("zero-burn: estimate exists but nothing consumed yet → nothing to flag", () => {
    const flag = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 0,
      progressPct: 0,
    });
    expect(flag.state).toBe("zero-burn");
    expect(flag.flagged).toBe(false);
    expect(flag.burnPct).toBe(0);
    expect(flag.hoursConsumed).toBe(0);
    expect(flag.estimatedHours).toBe(100);
    expect(flag.reason).toMatch(/nothing to flag/i);
  });

  it("zero-burn precedence: absent estimate still wins over zero burn", () => {
    const flag = classifyTimeOverrun({ estimatedHours: null, hoursConsumed: 0, progressPct: 0 });
    expect(flag.state).toBe("no-estimate");
  });
});

describe("classifyTimeOverrun — the burn-vs-completion comparison", () => {
  it("over-burning: 80% burnt / 30% done → flags warning with exact math", () => {
    // 80 of 100 estimated hours, 30% complete.
    const flag = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 80,
      progressPct: 30,
    });
    expect(flag.state).toBe("watched");
    expect(flag.flagged).toBe(true);
    expect(flag.burnPct).toBe(80);
    expect(flag.completePct).toBe(30);
    expect(flag.gapPct).toBe(50); // 80 − 30
    // gap 50 ≥ criticalGapPct(40) → critical, actually.
    expect(flag.severity).toBe("critical");
    expect(flag.reason).toContain("80 of 100 estimated hours used (80%), 30% complete");
  });

  it("over-burning warning tier: 72% burnt / 45% done → warning (gap < critical)", () => {
    // gap = 72 − 45 = 27, below criticalGapPct(40) → warning not critical.
    const flag = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 72,
      progressPct: 45,
    });
    expect(flag.flagged).toBe(true);
    expect(flag.severity).toBe("warning");
    expect(flag.gapPct).toBe(27);
  });

  it("on-track: 40% burnt / 60% done → no flag (progress ahead of spend)", () => {
    const flag = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 40,
      progressPct: 60,
    });
    expect(flag.state).toBe("watched");
    expect(flag.flagged).toBe(false);
    expect(flag.severity).toBe("ok");
    expect(flag.burnPct).toBe(40);
    expect(flag.gapPct).toBe(-20); // spend behind progress
    expect(flag.reason).toMatch(/on track/i);
  });

  it("on-track: high burn but high completion (85% / 90%) → not flagged", () => {
    // Burn is over the floor, but completion is above the ceiling → no flag.
    const flag = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 85,
      progressPct: 90,
    });
    expect(flag.flagged).toBe(false);
    expect(flag.burnPct).toBe(85);
    expect(flag.completePct).toBe(90);
  });

  it("burn can exceed 100% (already over the estimate)", () => {
    const flag = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 130,
      progressPct: 40,
    });
    expect(flag.burnPct).toBe(130);
    expect(flag.flagged).toBe(true);
    expect(flag.severity).toBe("critical"); // gap 90
  });
});

describe("classifyTimeOverrun — threshold boundaries (exact math)", () => {
  it("fires exactly at the burn floor and completion ceiling", () => {
    const atFloor = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: OVERRUN_THRESHOLDS.burnPctFloor, // 70 → 70%
      progressPct: OVERRUN_THRESHOLDS.completePctCeiling, // 50
    });
    expect(atFloor.flagged).toBe(true); // ≥ floor AND ≤ ceiling both inclusive
  });

  it("does NOT fire just below the burn floor", () => {
    const belowBurn = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: OVERRUN_THRESHOLDS.burnPctFloor - 1, // 69%
      progressPct: 10,
    });
    expect(belowBurn.flagged).toBe(false);
  });

  it("does NOT fire just above the completion ceiling", () => {
    const aboveComplete = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 95,
      progressPct: OVERRUN_THRESHOLDS.completePctCeiling + 1, // 51%
    });
    expect(aboveComplete.flagged).toBe(false);
  });

  it("critical only when the gap reaches criticalGapPct", () => {
    // Construct a case exactly at the critical gap: 90% burn, 50% done → gap 40.
    const atCritical = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 90,
      progressPct: 50,
    });
    expect(atCritical.gapPct).toBe(OVERRUN_THRESHOLDS.criticalGapPct);
    expect(atCritical.severity).toBe("critical");

    // One point narrower gap → warning.
    const justUnder = classifyTimeOverrun({
      estimatedHours: 100,
      hoursConsumed: 89,
      progressPct: 50,
    });
    expect(justUnder.gapPct).toBe(39);
    expect(justUnder.severity).toBe("warning");
  });
});

describe("classifyTimeOverrun — real-scale + area-mix-shaped math", () => {
  it("non-round estimate/consumed rounds burnPct to 1dp", () => {
    // 137.5 of 200 estimated hours = 68.75% → rounded 68.8%, just under floor.
    const flag = classifyTimeOverrun({
      estimatedHours: 200,
      hoursConsumed: 137.5,
      progressPct: 25,
    });
    expect(flag.burnPct).toBe(68.8);
    expect(flag.flagged).toBe(false);
  });

  it("area-mix: pooled job progress feeds the same job-level comparison", () => {
    // The issue AC: hours are JOB-LEVEL; area progress is pooled by
    // progress.ts into ONE completion %. A job whose big area is behind pulls
    // the pooled % down even though a small area is 'done' — the classifier
    // just consumes the single injected pooled %.
    // 30 fit-off of 40 tasks 'done' in one area but the 200-task rough-in area
    // barely started → pooled completion is low; hours burnt high.
    const pooledCompletePct = 12; // e.g. 30 complete of 240 pooled tasks
    const flag = classifyTimeOverrun({
      estimatedHours: 500,
      hoursConsumed: 400, // 80%
      progressPct: pooledCompletePct,
    });
    expect(flag.burnPct).toBe(80);
    expect(flag.completePct).toBe(12);
    expect(flag.flagged).toBe(true);
    expect(flag.severity).toBe("critical"); // gap 68
  });

  it("is pure — identical inputs yield identical flags", () => {
    const input: TimeOverrunInput = { estimatedHours: 100, hoursConsumed: 75, progressPct: 40 };
    expect(classifyTimeOverrun(input)).toEqual(classifyTimeOverrun(input));
  });
});

describe("timeOverrunView — honest surfacing model", () => {
  it("no-estimate always shows (the absence is surfaced, never skipped)", () => {
    const view = timeOverrunView(
      classifyTimeOverrun({ estimatedHours: null, hoursConsumed: 50, progressPct: 20 }),
    );
    expect(view.show).toBe(true);
    expect(view.tone).toBe("muted");
    expect(view.headline).toBe("No time estimate set");
  });

  it("no-progress shows as a muted 'can't compare' note", () => {
    const view = timeOverrunView(
      classifyTimeOverrun({ estimatedHours: 100, hoursConsumed: 90, progressPct: null }),
    );
    expect(view.show).toBe(true);
    expect(view.tone).toBe("muted");
    expect(view.headline).toBe("No progress to compare");
  });

  it("flagged overrun shows with its severity tone + math detail", () => {
    const view = timeOverrunView(
      classifyTimeOverrun({ estimatedHours: 100, hoursConsumed: 80, progressPct: 30 }),
    );
    expect(view.show).toBe(true);
    expect(view.tone).toBe("critical");
    expect(view.headline).toBe("Hours outpacing progress");
    expect(view.detail).toContain("80 of 100 estimated hours used (80%), 30% complete");
  });

  it("zero-burn and on-track are quiet (show=false)", () => {
    const zeroBurn = timeOverrunView(
      classifyTimeOverrun({ estimatedHours: 100, hoursConsumed: 0, progressPct: 0 }),
    );
    expect(zeroBurn.show).toBe(false);
    const onTrack = timeOverrunView(
      classifyTimeOverrun({ estimatedHours: 100, hoursConsumed: 40, progressPct: 60 }),
    );
    expect(onTrack.show).toBe(false);
  });
});
