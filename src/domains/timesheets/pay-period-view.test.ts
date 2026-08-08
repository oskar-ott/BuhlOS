import { describe, expect, it } from "vitest";

import {
  isValidRange,
  payPeriodRangeFor,
  payPeriodWeekStarts,
  shiftAnchor,
  summarisePeriodReadiness,
  toPayPeriodRows,
  workerActionMap,
} from "./pay-period-view";
import type { WeeklyHoursCloseout, WorkerWeekReadiness } from "./weekly-closeout";

/** Minimal closeout for the readiness folds (only the fields the helpers read). */
function closeout(
  weekStart: string,
  workers: Array<{ workerId: string; readiness: WorkerWeekReadiness }>,
): WeeklyHoursCloseout {
  return {
    weekStart,
    weekEnd: weekStart,
    workers: workers.map((w) => ({
      workerId: w.workerId,
      workerName: w.workerId,
      workerRole: null,
      readiness: w.readiness,
      approvedHours: 0,
      approvedCount: 0,
      submittedCount: 0,
      rejectedCount: 0,
      draftCount: 0,
      missingCount: 0, pendingCount: 0,
      blockers: [],
      needsLookReasons: [],
      days: [],
      loggedHours: 0,
      jobBreakdown: [],
      costRateCents: null,
      labourCents: null,
    })),
    approvedByJob: [],
    summary: {
      workersReady: 0,
      workersNeedAction: 0,
      submittedDays: 0,
      rejectedDays: 0,
      draftDays: 0,
      missingDays: 0,
      approvedHours: 0,
      loggedHours: 0,
      labourCents: 0,
      ratedWorkers: 0,
      payrollReady: workers.every((w) => w.readiness === "payroll-ready"),
    },
  };
}

describe("payPeriodRangeFor", () => {
  it("week = the anchor's Mon–Sun week", () => {
    // 2026-06-17 is a Wednesday; its week is Mon 15 → Sun 21.
    expect(payPeriodRangeFor("week", "2026-06-17")).toEqual({
      fromDate: "2026-06-15",
      toDate: "2026-06-21",
    });
  });

  it("fortnight = the anchor's week plus the week before", () => {
    expect(payPeriodRangeFor("fortnight", "2026-06-17")).toEqual({
      fromDate: "2026-06-08",
      toDate: "2026-06-21",
    });
  });
});

describe("shiftAnchor", () => {
  it("steps a week back/forward to the Monday", () => {
    expect(shiftAnchor("week", "2026-06-17", -1)).toBe("2026-06-08");
    expect(shiftAnchor("week", "2026-06-17", 1)).toBe("2026-06-22");
  });
  it("steps a fortnight", () => {
    expect(shiftAnchor("fortnight", "2026-06-17", -1)).toBe("2026-06-01");
  });
});

describe("payPeriodWeekStarts", () => {
  it("lists each Monday in the range", () => {
    expect(payPeriodWeekStarts({ fromDate: "2026-06-08", toDate: "2026-06-21" })).toEqual([
      "2026-06-08",
      "2026-06-15",
    ]);
  });
  it("is a single week for a one-week range", () => {
    expect(payPeriodWeekStarts({ fromDate: "2026-06-15", toDate: "2026-06-21" })).toEqual([
      "2026-06-15",
    ]);
  });
});

describe("isValidRange", () => {
  it("accepts a well-formed ordered range", () => {
    expect(isValidRange("2026-06-01", "2026-06-14")).toBe(true);
  });
  it("rejects reversed or malformed ranges", () => {
    expect(isValidRange("2026-06-14", "2026-06-01")).toBe(false);
    expect(isValidRange("nope", "2026-06-01")).toBe(false);
  });
});

describe("toPayPeriodRows", () => {
  it("extracts the rows we need and coerces numbers", () => {
    const rows = toPayPeriodRows({
      rows: [
        {
          workerId: "u1",
          workerName: "Alice",
          weekStart: "2026-06-15",
          date: "2026-06-16",
          hours: "8",
          ordinaryHours: 8,
          overtimeHours: 0,
          status: "approved",
          exportId: "",
          xeroEmployeeId: "xe-1",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workerId: "u1", hours: 8, xeroEmployeeId: "xe-1" });
  });

  it("returns [] for malformed shapes and skips rows missing keys", () => {
    expect(toPayPeriodRows(null)).toEqual([]);
    expect(toPayPeriodRows({})).toEqual([]);
    expect(toPayPeriodRows({ rows: "nope" })).toEqual([]);
    expect(toPayPeriodRows({ rows: [{ date: "2026-06-16" }] })).toEqual([]); // no workerId
  });
});

describe("summarisePeriodReadiness", () => {
  it("is fully closed when every week is payroll-ready", () => {
    const r = summarisePeriodReadiness([
      closeout("2026-06-08", [{ workerId: "u1", readiness: "payroll-ready" }]),
      closeout("2026-06-15", [{ workerId: "u1", readiness: "payroll-ready" }]),
    ]);
    expect(r).toEqual({ weeksTotal: 2, weeksReady: 2, fullyClosed: true, workersNeedingAction: 0 });
  });

  it("counts a worker needing action once across weeks and marks the period not closed", () => {
    const r = summarisePeriodReadiness([
      closeout("2026-06-08", [{ workerId: "u1", readiness: "needs-review" }]),
      closeout("2026-06-15", [{ workerId: "u1", readiness: "needs-worker" }]),
    ]);
    expect(r.fullyClosed).toBe(false);
    expect(r.workersNeedingAction).toBe(1);
    expect(r.weeksReady).toBe(0);
  });

  it("is not fully closed for an empty period (nothing to confirm)", () => {
    expect(summarisePeriodReadiness([]).fullyClosed).toBe(false);
  });
});

describe("workerActionMap", () => {
  it("flags blocking weeks per worker", () => {
    const map = workerActionMap([
      closeout("2026-06-08", [
        { workerId: "u1", readiness: "needs-review" },
        { workerId: "u2", readiness: "payroll-ready" },
      ]),
      closeout("2026-06-15", [
        { workerId: "u1", readiness: "missing-hours" },
        { workerId: "u2", readiness: "payroll-ready" },
      ]),
    ]);
    expect(map.get("u1")).toEqual({ needsAction: true, blockingWeeks: 2 });
    expect(map.get("u2")).toEqual({ needsAction: false, blockingWeeks: 0 });
  });
});
