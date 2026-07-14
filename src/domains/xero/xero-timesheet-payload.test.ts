import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * api/_lib/xero/timesheet-payload.js (#249) — the PURE builder that turns a
 * locked batch's items into Xero Payroll AU draft-timesheet payloads. These
 * tests PIN the verified 1.0 contract (Timesheets[] with EmployeeID / StartDate
 * / EndDate / Status:'DRAFT' / TimesheetLines[{EarningsRateID, NumberOfUnits[]}])
 * so it can't drift, and cover pay-calendar alignment, multi-job merge and hash
 * stability.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildTimesheets, contentHashOf, alignmentFor, daysInclusive } =
  requireFromHere("../../../api/_lib/xero/timesheet-payload.js");

const WEEKLY = { name: "Weekly Calendar", payload: { calendarType: "WEEKLY", startDate: "2026-07-06" } };
const FORTNIGHTLY = { name: "Fortnightly Calendar", payload: { calendarType: "FORTNIGHTLY", startDate: "2026-07-06" } };
const MONTHLY = { name: "Monthly Calendar", payload: { calendarType: "MONTHLY", startDate: "2026-07-01" } };

function calendars() {
  return new Map<string, unknown>([
    ["cal-weekly", WEEKLY],
    ["cal-fortnightly", FORTNIGHTLY],
    ["cal-monthly", MONTHLY],
  ]);
}
function employees() {
  return new Map<string, unknown>([
    ["e-alex", { name: "Alex Buhltest", active: true, payload: { payrollCalendarID: "cal-weekly" } }],
    ["e-jamie", { name: "Jamie Buhltest", active: true, payload: { payrollCalendarID: "cal-weekly" } }],
    ["e-frank", { name: "Frank Fortnight", active: true, payload: { payrollCalendarID: "cal-fortnightly" } }],
    ["e-mo", { name: "Mo Month", active: true, payload: { payrollCalendarID: "cal-monthly" } }],
    ["e-nocal", { name: "No Cal", active: true, payload: { payrollCalendarID: null } }],
  ]);
}
function item(over: Record<string, unknown> = {}) {
  return {
    workerId: "w-alex", workerName: "Alex Buhltest",
    employeeId: "e-alex", employeeName: "Alex Buhltest",
    earningsRateId: "r-ord", earningsRateName: "Ordinary Hours",
    entryDate: "2026-07-06", hours: 8,
    ...over,
  };
}
const PERIOD = { periodStart: "2026-07-06", periodEnd: "2026-07-12" };

function build(items: unknown[], over: Record<string, unknown> = {}) {
  return buildTimesheets({ items, ...PERIOD, employeesById: employees(), calendarsById: calendars(), ...over });
}
// buildTimesheets is required untyped (createRequire) — keep the helper loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function worker(out: any, id: string): any {
  return out.workers.find((w: { workerId: string }) => w.workerId === id);
}
function line(ts: { TimesheetLines: Array<{ EarningsRateID: string; NumberOfUnits: number[] }> }, rateId: string) {
  return ts.TimesheetLines.find((l) => l.EarningsRateID === rateId);
}

describe("daysInclusive", () => {
  it("is inclusive Mon..Sun (7 days)", () => {
    expect(daysInclusive("2026-07-06", "2026-07-12")).toHaveLength(7);
    expect(daysInclusive("2026-07-06", "2026-07-12")[0]).toBe("2026-07-06");
    expect(daysInclusive("2026-07-06", "2026-07-12")[6]).toBe("2026-07-12");
  });
  it("is empty on inverted or malformed ranges", () => {
    expect(daysInclusive("2026-07-12", "2026-07-06")).toEqual([]);
    expect(daysInclusive("nope", "2026-07-12")).toEqual([]);
  });
});

describe("alignmentFor", () => {
  it("aligns a Mon–Sun week to a WEEKLY calendar", () => {
    const a = alignmentFor(WEEKLY, "2026-07-06", "2026-07-12");
    expect(a.aligned).toBe(true);
    expect(a.calendarPeriod).toEqual({ start: "2026-07-06", end: "2026-07-12" });
  });
  it("blocks a single week against a FORTNIGHTLY calendar, showing the real period", () => {
    const a = alignmentFor(FORTNIGHTLY, "2026-07-06", "2026-07-12");
    expect(a.aligned).toBe(false);
    expect(a.code).toBe("period_mismatch");
    expect(a.calendarPeriod).toEqual({ start: "2026-07-06", end: "2026-07-19" });
  });
  it("blocks variable-length calendars as unsupported (never fudged)", () => {
    expect(alignmentFor(MONTHLY, "2026-07-06", "2026-07-12").code).toBe("calendar_unsupported");
  });
  it("blocks a missing calendar", () => {
    expect(alignmentFor(null, "2026-07-06", "2026-07-12").code).toBe("calendar_missing");
  });
});

describe("buildTimesheets — happy path pins the 1.0 contract", () => {
  const out = build([
    item({ entryDate: "2026-07-06", hours: 8 }),
    // multi-job Tuesday: two allocations on the same rate merge to one daily unit
    item({ entryDate: "2026-07-07", hours: 4, jobId: "A" }),
    item({ entryDate: "2026-07-07", hours: 4, jobId: "B" }),
    // an overtime rate on Wednesday
    item({ earningsRateId: "r-ot", earningsRateName: "Overtime 1.5x", entryDate: "2026-07-08", hours: 2 }),
  ]);
  const alex = worker(out, "w-alex")!;

  it("produces one aligned timesheet with the exact wrapper fields", () => {
    expect(alex.aligned).toBe(true);
    expect(alex.blocker).toBeNull();
    expect(alex.timesheet.EmployeeID).toBe("e-alex");
    expect(alex.timesheet.StartDate).toBe("2026-07-06");
    expect(alex.timesheet.EndDate).toBe("2026-07-12");
    expect(alex.timesheet.Status).toBe("DRAFT");
  });
  it("merges multi-job days into per-rate daily NumberOfUnits arrays (7 long)", () => {
    const ord = line(alex.timesheet, "r-ord")!;
    const ot = line(alex.timesheet, "r-ot")!;
    expect(ord.NumberOfUnits).toEqual([8, 8, 0, 0, 0, 0, 0]);
    expect(ot.NumberOfUnits).toEqual([0, 0, 2, 0, 0, 0, 0]);
    expect(alex.totalUnits).toBe(18);
  });
});

describe("contentHashOf — idempotency signal", () => {
  it("is stable across line and key order, and changes when units change", () => {
    const a = build([item({ entryDate: "2026-07-06", hours: 8 }), item({ earningsRateId: "r-ot", entryDate: "2026-07-08", hours: 2 })]);
    const b = build([item({ earningsRateId: "r-ot", entryDate: "2026-07-08", hours: 2 }), item({ entryDate: "2026-07-06", hours: 8 })]);
    const alexA = worker(a, "w-alex")!;
    const alexB = worker(b, "w-alex")!;
    expect(alexA.contentHash).toBe(alexB.contentHash);

    const changed = build([item({ entryDate: "2026-07-06", hours: 9 })]);
    expect(worker(changed, "w-alex")!.contentHash).not.toBe(alexA.contentHash);
  });
  it("hashes the built timesheet directly the same way", () => {
    const out = build([item({ entryDate: "2026-07-06", hours: 8 })]);
    const ts = worker(out, "w-alex")!.timesheet;
    expect(contentHashOf(ts)).toBe(worker(out, "w-alex")!.contentHash);
  });
});

describe("buildTimesheets — named blockers, never silent drops", () => {
  it("blocks an unmapped worker (null employeeId)", () => {
    const out = build([item({ workerId: "w-x", workerName: "Xavier", employeeId: null, employeeName: null })]);
    const x = worker(out, "w-x")!;
    expect(x.aligned).toBe(false);
    expect(x.blocker.code).toBe("unmapped_worker");
    expect(x.timesheet).toBeNull();
  });
  it("blocks a worker with an unmapped earnings rate", () => {
    const out = build([item({ earningsRateId: null })]);
    expect(worker(out, "w-alex")!.blocker.code).toBe("unmapped_earnings_rate");
  });
  it("blocks a period that does not match the employee's fortnightly calendar", () => {
    const out = build([item({ workerId: "w-frank", workerName: "Frank Fortnight", employeeId: "e-frank", employeeName: "Frank Fortnight" })]);
    expect(worker(out, "w-frank")!.blocker.code).toBe("period_mismatch");
  });
  it("blocks a variable-length calendar", () => {
    const out = build([item({ workerId: "w-mo", workerName: "Mo Month", employeeId: "e-mo", employeeName: "Mo Month" })]);
    expect(worker(out, "w-mo")!.blocker.code).toBe("calendar_unsupported");
  });
});
