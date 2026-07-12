import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * api/_lib/xero/payroll-validation.js (#894) — the pure rule engine. Every
 * rule fires with a machine code AND a human message; errors block,
 * warnings don't; nothing is silently dropped.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validatePayroll } = requireFromHere("../../../api/_lib/xero/payroll-validation.js");

const NOW = Date.UTC(2026, 6, 13);
const FRESH = new Date(NOW - 60_000).toISOString();

function row(over: Record<string, unknown> = {}) {
  return {
    workerId: "w1",
    workerName: "Karen Buhl",
    date: "2026-07-07",
    jobId: "job-1",
    hours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "approved",
    exportId: "",
    ...over,
  };
}

function base(over: Record<string, unknown> = {}) {
  return {
    rows: [row()],
    periodStart: "2026-07-06",
    periodEnd: "2026-07-12",
    workerReadiness: [{ workerId: "w1", employeeId: "emp-1", mapped: true }],
    worktypeReadiness: [
      { workType: "ordinary", label: "Ordinary hours", rateId: "er-1", rateName: "Ordinary Hours", mapped: true },
      { workType: "overtime", label: "Overtime", rateId: "er-2", rateName: "Overtime", mapped: true },
    ],
    employeesById: new Map([
      ["emp-1", { name: "Karen Buhl", active: true, payload: { status: "ACTIVE", payrollCalendarID: "cal-1" } }],
    ]),
    ratesById: new Map([
      ["er-1", { name: "Ordinary Hours", active: true }],
      ["er-2", { name: "Overtime", active: true }],
    ]),
    referenceSyncs: { employees: { status: "ok", at: FRESH }, pay_items: { status: "ok", at: FRESH } },
    connectionOrg: { batchOrg: null, currentOrg: "org-1" },
    now: NOW,
    ...over,
  };
}

function codes(v: { errors: Array<{ code: string }>; warnings: Array<{ code: string }> }) {
  return { errors: v.errors.map((e) => e.code).sort(), warnings: v.warnings.map((w) => w.code).sort() };
}

describe("validatePayroll", () => {
  it("a clean period is ready with an honest summary", () => {
    const v = validatePayroll(base());
    expect(v.ready).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.summary).toEqual({
      approvedRowCount: 1, workerCount: 1, totalHours: 8, ordinaryHours: 8, overtimeHours: 0,
    });
  });

  it("undecided hours block with the workers NAMED", () => {
    const v = validatePayroll(base({ rows: [row(), row({ workerId: "w2", workerName: "Alex", status: "submitted" })] }));
    expect(v.ready).toBe(false);
    const e = v.errors.find((x: { code: string }) => x.code === "unapproved_entries");
    expect(e.workers).toEqual(["Alex"]);
    expect(e.message).toContain("Alex");
  });

  it("rejected entries don't block (they're decided), empty period does", () => {
    const rejectedOnly = validatePayroll(base({ rows: [row({ status: "rejected" })] }));
    expect(rejectedOnly.errors.map((e: { code: string }) => e.code)).toContain("no_rows");
    expect(rejectedOnly.errors.map((e: { code: string }) => e.code)).not.toContain("unapproved_entries");
  });

  it("unmapped worker / work type block with names", () => {
    const v = validatePayroll(base({
      rows: [row({ ordinaryHours: 6, overtimeHours: 2, hours: 8 })],
      workerReadiness: [{ workerId: "w1", employeeId: null, mapped: false }],
      worktypeReadiness: [
        { workType: "ordinary", label: "Ordinary hours", rateId: "er-1", rateName: "Ordinary Hours", mapped: true },
        { workType: "overtime", label: "Overtime", rateId: null, rateName: null, mapped: false },
      ],
    }));
    expect(codes(v).errors).toEqual(["unmapped_work_types", "unmapped_workers"]);
    expect(v.errors.find((e: { code: string }) => e.code === "unmapped_workers").workers).toEqual(["Karen Buhl"]);
    expect(v.errors.find((e: { code: string }) => e.code === "unmapped_work_types").workTypes).toEqual(["overtime"]);
  });

  it("broken links: employee vanished, no calendar; terminated is a WARNING (final pay)", () => {
    const gone = validatePayroll(base({ employeesById: new Map() }));
    expect(codes(gone).errors).toContain("employee_missing");

    const noCal = validatePayroll(base({
      employeesById: new Map([["emp-1", { name: "K", active: true, payload: { payrollCalendarID: null } }]]),
    }));
    expect(codes(noCal).errors).toContain("employee_no_calendar");

    const term = validatePayroll(base({
      employeesById: new Map([["emp-1", { name: "K", active: false, payload: { status: "TERMINATED", payrollCalendarID: "cal-1" } }]]),
    }));
    expect(term.ready).toBe(true); // warning, not blocker
    expect(codes(term).warnings).toContain("employee_terminated");
  });

  it("broken earnings-rate mappings block (missing or inactive rate)", () => {
    const v = validatePayroll(base({ ratesById: new Map([["er-1", { name: "Ordinary Hours", active: false }]]) }));
    expect(codes(v).errors).toContain("earnings_rate_broken");
  });

  it("already-exported rows block a normal batch, pass a correction batch", () => {
    const rows = [row({ exportId: "exp_1" })];
    const normal = validatePayroll(base({ rows }));
    expect(codes(normal).errors).toContain("already_exported");
    expect(normal.errors.find((e: { code: string }) => e.code === "already_exported").exportIds).toEqual(["exp_1"]);
    const correction = validatePayroll(base({ rows, allowExported: true }));
    expect(codes(correction).errors).not.toContain("already_exported");
  });

  it("duplicate source rows and broken hour splits block", () => {
    const dupe = validatePayroll(base({ rows: [row(), row()] }));
    expect(codes(dupe).errors).toContain("duplicate_source");

    const bad = validatePayroll(base({ rows: [row({ hours: 8, ordinaryHours: 8, overtimeHours: 2 })] }));
    expect(codes(bad).errors).toContain("invalid_hours");

    const negative = validatePayroll(base({ rows: [row({ hours: -1, ordinaryHours: -1, overtimeHours: 0 })] }));
    expect(codes(negative).errors).toContain("invalid_hours");
  });

  it("stale or never-synced reference data blocks", () => {
    const never = validatePayroll(base({ referenceSyncs: {} }));
    expect(codes(never).errors).toContain("stale_reference");
    const old = validatePayroll(base({
      referenceSyncs: {
        employees: { status: "ok", at: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString() },
        pay_items: { status: "ok", at: FRESH },
      },
    }));
    expect(codes(old).errors).toContain("stale_reference");
  });

  it("dates outside the period and org mismatch block", () => {
    const out = validatePayroll(base({ rows: [row({ date: "2026-07-20" })] }));
    expect(codes(out).errors).toContain("date_out_of_period");
    const org = validatePayroll(base({ connectionOrg: { batchOrg: "org-OTHER", currentOrg: "org-1" } }));
    expect(codes(org).errors).toContain("org_mismatch");
  });

  it("every finding carries a human-readable message", () => {
    const v = validatePayroll(base({
      rows: [row({ exportId: "exp_1" }), row({ workerId: "w2", workerName: "Alex", status: "draft" })],
      workerReadiness: [],
      worktypeReadiness: [],
      employeesById: new Map(),
      ratesById: new Map(),
      referenceSyncs: {},
    }));
    expect(v.ready).toBe(false);
    for (const f of [...v.errors, ...v.warnings]) {
      expect(typeof f.code).toBe("string");
      expect(f.message.length).toBeGreaterThan(20);
    }
  });
});
