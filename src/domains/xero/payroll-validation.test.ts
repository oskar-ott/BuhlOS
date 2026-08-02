import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * api/_lib/xero/payroll-validation.js (#894) — the pure rule engine. Every
 * rule fires with a machine code AND a human message; errors block,
 * warnings don't; nothing is silently dropped.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validatePayroll, partitionPayrollRows } = requireFromHere("../../../api/_lib/xero/payroll-validation.js");

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

  // 2026-07-26 owner ratification (lean-reset replica): unmapped workers now
  // WITHHOLD with a warning instead of blocking — the blocking error remains
  // ONLY when no payable worker is mapped. This period has a single worker,
  // so it IS the degenerate all-unmapped case and still blocks.
  it("unmapped worker / work type block with names (degenerate: no one mapped)", () => {
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

  // ── Withhold-and-warn (2026-07-26 owner-ratified, lean-reset replica) ──────
  describe("unmapped workers are withheld, not blocking", () => {
    const twoWorkers = () => [
      row(), // w1 Karen Buhl — mapped
      row({ workerId: "w2", workerName: "Alex West", hours: 6, ordinaryHours: 6, overtimeHours: 0 }),
    ];
    const mixedReadiness = [
      { workerId: "w1", employeeId: "emp-1", mapped: true },
      { workerId: "w2", employeeId: null, mapped: false },
    ];

    it("1 unmapped + 1 mapped → WARNING with the withheld list, NO error, ready", () => {
      const v = validatePayroll(base({ rows: twoWorkers(), workerReadiness: mixedReadiness }));
      expect(v.ready).toBe(true);
      expect(codes(v).errors).toEqual([]);
      expect(codes(v).warnings).toContain("unmapped_workers_withheld");
      const w = v.warnings.find((x: { code: string }) => x.code === "unmapped_workers_withheld");
      expect(w.withheldWorkers).toEqual([{ workerId: "w2", workerName: "Alex West", hours: 6 }]);
      expect(w.message).toContain("Alex West");
      expect(w.message).toContain("no Xero employee ID yet");
      expect(w.message).toContain("follow-up batch");
      expect(v.withheldWorkers).toEqual([{ workerId: "w2", workerName: "Alex West", hours: 6 }]);
    });

    it("the summary counts only what the batch pays (withheld hours stay out)", () => {
      const v = validatePayroll(base({ rows: twoWorkers(), workerReadiness: mixedReadiness }));
      expect(v.summary).toEqual({
        approvedRowCount: 1, workerCount: 1, totalHours: 8, ordinaryHours: 8, overtimeHours: 0,
      });
    });

    it("ALL payable workers unmapped → still the blocking error, nothing withheld", () => {
      const v = validatePayroll(base({
        rows: twoWorkers(),
        workerReadiness: [
          { workerId: "w1", employeeId: null, mapped: false },
          { workerId: "w2", employeeId: null, mapped: false },
        ],
      }));
      expect(v.ready).toBe(false);
      expect(codes(v).errors).toContain("unmapped_workers");
      expect(codes(v).warnings).not.toContain("unmapped_workers_withheld");
      expect(v.withheldWorkers).toEqual([]);
    });

    it("a withheld worker's work type never blocks a batch that doesn't use it", () => {
      const v = validatePayroll(base({
        rows: [row(), row({ workerId: "w2", workerName: "Alex West", hours: 6, ordinaryHours: 4, overtimeHours: 2 })],
        workerReadiness: mixedReadiness,
        worktypeReadiness: [
          { workType: "ordinary", label: "Ordinary hours", rateId: "er-1", rateName: "Ordinary Hours", mapped: true },
          { workType: "overtime", label: "Overtime", rateId: null, rateName: null, mapped: false },
        ],
      }));
      // only the withheld worker had overtime — the push contains none, so no block
      expect(codes(v).errors).not.toContain("unmapped_work_types");
      expect(v.ready).toBe(true);
    });

    it("partitionPayrollRows: withheld rows are excluded from the included set", () => {
      const p = partitionPayrollRows({ rows: twoWorkers(), workerReadiness: mixedReadiness });
      expect(p.includedRows.map((r: { workerId: string }) => r.workerId)).toEqual(["w1"]);
      expect(p.withheldRows.map((r: { workerId: string }) => r.workerId)).toEqual(["w2"]);
      expect(p.withheldWorkers).toEqual([{ workerId: "w2", workerName: "Alex West", hours: 6 }]);
    });

    it("follow-up batch: previously exported rows are EXCLUDED with a warning; the newly-mapped worker's rows validate cleanly", () => {
      // batch A exported w1 (rows stamped); w2 was withheld and is now mapped
      const rows = [
        row({ exportId: "batch-A" }),
        row({ workerId: "w2", workerName: "Alex West", hours: 6, ordinaryHours: 6, overtimeHours: 0 }),
      ];
      const bothMapped = [
        { workerId: "w1", employeeId: "emp-1", mapped: true },
        { workerId: "w2", employeeId: "emp-1", mapped: true },
      ];
      const v = validatePayroll(base({ rows, workerReadiness: bothMapped }));
      expect(v.ready).toBe(true);
      expect(codes(v).errors).toEqual([]);
      expect(codes(v).warnings).toContain("already_exported_excluded");
      expect(v.summary.totalHours).toBe(6); // only Alex's previously-withheld hours
      const p = partitionPayrollRows({ rows, workerReadiness: bothMapped });
      expect(p.includedRows.map((r: { workerId: string }) => r.workerId)).toEqual(["w2"]);
      expect(p.exportedRows.map((r: { workerId: string }) => r.workerId)).toEqual(["w1"]);
    });

    it("double-pay guard: a fully-exported period still BLOCKS a normal batch", () => {
      const v = validatePayroll(base({
        rows: [row({ exportId: "batch-A" })],
      }));
      expect(codes(v).errors).toContain("already_exported");
      const p = partitionPayrollRows({ rows: [row({ exportId: "batch-A" })], workerReadiness: base().workerReadiness });
      expect(p.includedRows).toEqual([]); // an exported row can NEVER be included in a normal batch
    });

    it("an unmapped worker whose rows are all exported is not payable — no finding for them", () => {
      // matches the /hours/period semantics: an already-exported unmapped
      // worker must not disable a legitimate new-hours run
      const v = validatePayroll(base({
        rows: [row(), row({ workerId: "w2", workerName: "Alex West", exportId: "batch-A", hours: 6, ordinaryHours: 6, overtimeHours: 0 })],
        workerReadiness: mixedReadiness,
      }));
      expect(codes(v).errors).toEqual([]);
      expect(codes(v).warnings).toContain("already_exported_excluded");
      expect(codes(v).warnings).not.toContain("unmapped_workers_withheld");
    });
  });

  describe("subcontractor hours never reach the push (owner decision 2026-08-02)", () => {
    const subbieRow = (over: Record<string, unknown> = {}) =>
      row({ workerId: "w9", workerName: "Sam Subbie", workerRole: "subcontractor", ...over });

    it("subbie rows are partitioned out — no unmapped warning, not in the included set", () => {
      // Sam is deliberately NOT in workerReadiness (never mapped) — that must
      // not read as an unmapped worker to link.
      const input = base({ rows: [row(), subbieRow()] });
      const v = validatePayroll(input);
      expect(v.ready).toBe(true);
      expect(codes(v).errors).toEqual([]);
      expect(codes(v).warnings).toEqual(["subcontractor_hours_excluded"]);
      const w = v.warnings.find((x: { code: string }) => x.code === "subcontractor_hours_excluded");
      expect(w.workers).toEqual(["Sam Subbie"]);
      expect(w.message).toMatch(/never pushed to Xero/);

      const p = partitionPayrollRows({ rows: input.rows, workerReadiness: input.workerReadiness });
      expect(p.includedRows.map((r: { workerId: string }) => r.workerId)).toEqual(["w1"]);
      expect(p.outsideWorkers).toEqual([{ workerId: "w9", workerName: "Sam Subbie" }]);
      expect(p.withheldWorkers).toEqual([]);
    });

    it("the summary counts only payroll hours — subbie hours stay out", () => {
      const v = validatePayroll(base({ rows: [row(), subbieRow({ hours: 6, ordinaryHours: 6 })] }));
      expect(v.summary.totalHours).toBe(8);
      expect(v.summary.workerCount).toBe(1);
    });

    it("an only-subbies period blocks with an honest 'nothing to push' message", () => {
      const v = validatePayroll(base({ rows: [subbieRow()] }));
      expect(v.ready).toBe(false);
      expect(codes(v).errors).toEqual(["no_rows"]);
      expect(v.errors[0].message).toMatch(/job costing/);
      // And no nag to link the subbie in Xero.
      expect(codes(v).warnings).not.toContain("unmapped_workers_withheld");
    });

    it("subbie hours still have to be DECIDED — undecided subbie rows block like anyone's", () => {
      const v = validatePayroll(base({ rows: [row(), subbieRow({ status: "submitted" })] }));
      expect(codes(v).errors).toContain("unapproved_entries");
    });
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
