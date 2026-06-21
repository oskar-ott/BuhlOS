import { describe, expect, it } from "vitest";

import {
  buildPayPeriodRollup,
  type PayPeriodSourceRow,
} from "./pay-period-rollup";

const RANGE = { fromDate: "2026-06-08", toDate: "2026-06-21" }; // two Mon–Sun weeks

function row(over: Partial<PayPeriodSourceRow>): PayPeriodSourceRow {
  return {
    workerId: "u1",
    workerName: "Alice Smith",
    weekStart: "2026-06-08",
    date: "2026-06-08",
    hours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "approved",
    exportId: "",
    xeroEmployeeId: "",
    ...over,
  };
}

describe("buildPayPeriodRollup", () => {
  it("returns an empty, zeroed rollup for no rows", () => {
    const r = buildPayPeriodRollup([], RANGE);
    expect(r.workers).toEqual([]);
    expect(r.summary).toEqual({
      workerCount: 0,
      approvedHours: 0,
      ordinaryHours: 0,
      overtimeHours: 0,
      unexportedApprovedHours: 0,
      unmappedWorkerCount: 0,
    });
    expect(r.fromDate).toBe("2026-06-08");
    expect(r.toDate).toBe("2026-06-21");
  });

  it("ignores non-approved rows entirely", () => {
    const r = buildPayPeriodRollup(
      [
        row({ date: "2026-06-08", status: "submitted", hours: 8, ordinaryHours: 8 }),
        row({ date: "2026-06-09", status: "rejected", hours: 8, ordinaryHours: 8 }),
        row({ date: "2026-06-10", status: "draft", hours: 8, ordinaryHours: 8 }),
      ],
      RANGE,
    );
    expect(r.workers).toEqual([]);
    expect(r.summary.approvedHours).toBe(0);
  });

  it("sums a worker's approved hours and carries the ordinary/overtime split through unchanged", () => {
    const r = buildPayPeriodRollup(
      [
        row({ date: "2026-06-08", hours: 10, ordinaryHours: 8, overtimeHours: 2 }),
        row({ date: "2026-06-09", hours: 7.6, ordinaryHours: 7.6, overtimeHours: 0 }),
      ],
      RANGE,
    );
    expect(r.workers).toHaveLength(1);
    const w = r.workers[0]!;
    expect(w.approvedHours).toBe(17.6);
    expect(w.ordinaryHours).toBe(15.6);
    expect(w.overtimeHours).toBe(2);
    expect(w.approvedDayCount).toBe(2);
    expect(r.summary.overtimeHours).toBe(2);
  });

  it("counts a split day (two allocation rows, same date) once but sums its hours", () => {
    const r = buildPayPeriodRollup(
      [
        row({ date: "2026-06-10", hours: 4, ordinaryHours: 4, overtimeHours: 0, exportId: "" }),
        row({ date: "2026-06-10", hours: 3.6, ordinaryHours: 3.6, overtimeHours: 0, exportId: "" }),
      ],
      RANGE,
    );
    const w = r.workers[0]!;
    expect(w.approvedHours).toBe(7.6);
    expect(w.approvedDayCount).toBe(1);
  });

  it("flags approved hours not yet stamped into a committed run", () => {
    const r = buildPayPeriodRollup(
      [
        row({ date: "2026-06-08", hours: 8, ordinaryHours: 8, exportId: "run_123" }),
        row({ date: "2026-06-09", hours: 7.6, ordinaryHours: 7.6, exportId: "" }),
      ],
      RANGE,
    );
    const w = r.workers[0]!;
    expect(w.approvedHours).toBe(15.6);
    expect(w.unexportedApprovedHours).toBe(7.6); // only the un-stamped day
  });

  it("marks a worker mapped when any row carries a Xero employee id, and counts unmapped workers", () => {
    const r = buildPayPeriodRollup(
      [
        row({ workerId: "u1", workerName: "Alice Smith", xeroEmployeeId: "xe-1" }),
        row({ workerId: "u2", workerName: "Bob Jones", xeroEmployeeId: "" }),
      ],
      RANGE,
    );
    const alice = r.workers.find((w) => w.workerId === "u1")!;
    const bob = r.workers.find((w) => w.workerId === "u2")!;
    expect(alice.xeroMapped).toBe(true);
    expect(bob.xeroMapped).toBe(false);
    expect(r.summary.unmappedWorkerCount).toBe(1);
  });

  it("buckets a worker's hours into Monday-sorted week slices", () => {
    const r = buildPayPeriodRollup(
      [
        row({ weekStart: "2026-06-15", date: "2026-06-16", hours: 8, ordinaryHours: 8 }),
        row({ weekStart: "2026-06-08", date: "2026-06-09", hours: 7.6, ordinaryHours: 7.6 }),
        row({ weekStart: "2026-06-08", date: "2026-06-10", hours: 2, ordinaryHours: 2 }),
      ],
      RANGE,
    );
    const w = r.workers[0]!;
    expect(w.weeks.map((s) => s.weekStart)).toEqual(["2026-06-08", "2026-06-15"]);
    expect(w.weeks[0]!.approvedHours).toBe(9.6);
    expect(w.weeks[1]!.approvedHours).toBe(8);
  });

  it("name-sorts workers and aggregates the period summary", () => {
    const r = buildPayPeriodRollup(
      [
        row({ workerId: "u2", workerName: "Zoe Adams", hours: 5, ordinaryHours: 5, xeroEmployeeId: "xe-2" }),
        row({ workerId: "u1", workerName: "Alice Smith", hours: 8, ordinaryHours: 6, overtimeHours: 2, xeroEmployeeId: "xe-1" }),
      ],
      RANGE,
    );
    expect(r.workers.map((w) => w.workerName)).toEqual(["Alice Smith", "Zoe Adams"]);
    expect(r.summary).toEqual({
      workerCount: 2,
      approvedHours: 13,
      ordinaryHours: 11,
      overtimeHours: 2,
      unexportedApprovedHours: 13,
      unmappedWorkerCount: 0,
    });
  });

  it("rounds accumulated floating-point drift to 2dp", () => {
    const r = buildPayPeriodRollup(
      [
        row({ date: "2026-06-08", hours: 0.1, ordinaryHours: 0.1 }),
        row({ date: "2026-06-09", hours: 0.2, ordinaryHours: 0.2 }),
      ],
      RANGE,
    );
    expect(r.workers[0]!.approvedHours).toBe(0.3);
  });
});
