import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Hours parity dry-run scaffold — payroll-critical. Pure planner counts and
 * parity numbers, every quarantine bucket the contract requires, the
 * timesheet_approvals-stays-empty rule, write-mode blocking through the
 * Supabase env guard, and source-level proof that the importer modules
 * cannot write (no write helper imported anywhere).
 */

const requireFromHere = createRequire(import.meta.url);

const planPath = requireFromHere.resolve("../../../scripts/importers/lib/hours-plan.js");
const runModePath = requireFromHere.resolve("../../../scripts/importers/lib/run-mode.js");
const cliPath = requireFromHere.resolve("../../../scripts/importers/hours-dry-run.js");
const guardPath = requireFromHere.resolve("../../../api/_lib/supabase-env.js");

type Bucket = Array<Record<string, unknown>>;
type Plan = {
  tables: {
    time_entries: { inserts: number };
    time_entry_allocations: { inserts: number };
    payroll_runs: { inserts: number };
    timesheet_approvals: { inserts: number; note: string };
  };
  hardErrors: string[];
  warnings: string[];
  missingUserRefs: Bucket;
  missingJobRefs: Bucket;
  duplicateUserDate: Bucket;
  invalidDates: Bucket;
  invalidStatuses: Bucket;
  invalidHourTotals: Bucket;
  ordinaryOvertimeMismatch: Bucket;
  over16Violations: Bucket;
  allocationSumMismatch: Bucket;
  weekStartNonMonday: Bucket;
  reopenApprovalInconsistencies: Bucket;
  quarantined: Bucket;
  summary: {
    usersWithEntries: number;
    datesDiscovered: number;
    weekStartsDiscovered: number;
    entriesByStatus: { draft: number; submitted: number; approved: number; rejected: number };
    totalHours: number;
    ordinaryHours: number;
    overtimeHours: number;
    allocationTotal: number;
    internalAllocationTotal: number;
    hoursByUserWeek: Record<string, number>;
    statusHoursByWeek: Record<string, { submitted: number; approved: number; rejected: number }>;
    payrollRunCount: number;
    clean: boolean;
  };
};

const hours = requireFromHere(planPath) as {
  buildHoursImportPlan: (s: unknown) => Plan;
  weekStartOf: (d: string) => string | null;
  isMonday: (d: string) => boolean;
};
const { resolveRunMode } = requireFromHere(runModePath) as {
  resolveRunMode: (
    argv: string[],
    env: Record<string, string | undefined>,
    guard: unknown
  ) => { mode: string };
};
const guard = requireFromHere(guardPath) as {
  PRODUCTION_PROJECT_REF: string;
  SupabaseEnvError: new (...a: never[]) => Error & { code: string };
};

function entry(
  userId: string,
  date: string,
  over: Record<string, unknown> = {},
  allocations: Array<Record<string, unknown>> = [{ jobId: "job-a", hours: 8 }]
) {
  const total =
    (over.totalHours as number) ??
    allocations.reduce((s, a) => s + (Number(a.hours) || 0), 0);
  const ordinary = (over.ordinaryHours as number) ?? Math.min(total, 8);
  const overtime = (over.overtimeHours as number) ?? Math.max(0, total - 8);
  return {
    userId,
    date,
    entry: {
      id: `te-${userId}-${date}`,
      date,
      totalHours: total,
      ordinaryHours: ordinary,
      overtimeHours: overtime,
      status: "approved",
      approvedBy: "u-admin",
      approvedAt: "2026-06-01T00:00:00Z",
      allocations,
      ...over,
    },
  };
}

function sources(over: Record<string, unknown> = {}) {
  return {
    users: { users: [{ id: "u-1" }, { id: "u-2" }, { id: "u-admin" }] },
    jobs: { jobs: [{ id: "job-a" }, { id: "job-b" }] },
    entries: [],
    payrollRuns: { runs: [] },
    ...over,
  };
}

describe("hours planner — clean parity", () => {
  // u-1: Mon 8h (job-a) approved; Tue 10h split job-a 6 + internal 4 submitted
  // u-2: Mon 7.6h internal approved
  const plan = hours.buildHoursImportPlan(
    sources({
      entries: [
        entry("u-1", "2026-06-01"),
        entry(
          "u-1",
          "2026-06-02",
          { status: "submitted", totalHours: 10, ordinaryHours: 8, overtimeHours: 2 },
          [
            { jobId: "job-a", hours: 6 },
            { jobId: null, hours: 4 },
          ]
        ),
        entry("u-2", "2026-06-01", { totalHours: 7.6, ordinaryHours: 7.6, overtimeHours: 0 }, [
          { jobId: null, hours: 7.6 },
        ]),
      ],
      payrollRuns: {
        runs: [
          { exportId: "exp_1", rowCount: 2, range: { fromDate: "2026-06-01", toDate: "2026-06-07" } },
        ],
      },
    })
  );

  it("proposes correct insert counts", () => {
    expect(plan.tables.time_entries.inserts).toBe(3);
    expect(plan.tables.time_entry_allocations.inserts).toBe(4); // 1 + 2 + 1
    expect(plan.tables.payroll_runs.inserts).toBe(1);
  });

  it("NEVER proposes timesheet_approvals inserts (projection-only)", () => {
    expect(plan.tables.timesheet_approvals.inserts).toBe(0);
    expect(plan.tables.timesheet_approvals.note).toMatch(/projection-only/);
  });

  it("computes parity hours: total = ordinary + overtime", () => {
    expect(plan.summary.totalHours).toBe(25.6);
    expect(plan.summary.ordinaryHours).toBe(23.6);
    expect(plan.summary.overtimeHours).toBe(2);
    expect(plan.summary.ordinaryHours + plan.summary.overtimeHours).toBeCloseTo(
      plan.summary.totalHours,
      2
    );
  });

  it("allocation total reconciles with entry total; internal split tracked", () => {
    expect(plan.summary.allocationTotal).toBe(25.6);
    expect(plan.summary.internalAllocationTotal).toBe(11.6); // 4 + 7.6
  });

  it("counts statuses and hours by user×week", () => {
    expect(plan.summary.entriesByStatus).toMatchObject({ approved: 2, submitted: 1 });
    // 2026-06-01 is a Monday → week start 2026-06-01
    expect(plan.summary.hoursByUserWeek["u-1|2026-06-01"]).toBe(18); // 8 + 10
    expect(plan.summary.hoursByUserWeek["u-2|2026-06-01"]).toBe(7.6);
    expect(plan.summary.statusHoursByWeek["2026-06-01"]).toMatchObject({
      approved: 15.6,
      submitted: 10,
    });
  });

  it("discovers users/dates/weeks and is CLEAN", () => {
    expect(plan.summary.usersWithEntries).toBe(2);
    expect(plan.summary.datesDiscovered).toBe(2);
    expect(plan.summary.weekStartsDiscovered).toBe(1);
    expect(plan.summary.clean).toBe(true);
  });
});

describe("hours planner — week math", () => {
  it("derives the ISO Monday week-start", () => {
    expect(hours.weekStartOf("2026-06-03")).toBe("2026-06-01"); // Wed → Mon
    expect(hours.weekStartOf("2026-06-07")).toBe("2026-06-01"); // Sun → Mon
    expect(hours.weekStartOf("2026-06-08")).toBe("2026-06-08"); // Mon → Mon
    expect(hours.isMonday("2026-06-01")).toBe(true);
    expect(hours.isMonday("2026-06-02")).toBe(false);
  });
});

describe("hours planner — quarantine buckets", () => {
  it("internal/no-job allocation is valid, not an error", () => {
    const plan = hours.buildHoursImportPlan(
      sources({ entries: [entry("u-1", "2026-06-01", {}, [{ jobId: null, hours: 8 }])] })
    );
    expect(plan.summary.clean).toBe(true);
    expect(plan.summary.internalAllocationTotal).toBe(8);
  });

  it("detects a duplicate user+date", () => {
    const plan = hours.buildHoursImportPlan(
      sources({ entries: [entry("u-1", "2026-06-01"), entry("u-1", "2026-06-01")] })
    );
    expect(plan.duplicateUserDate.length).toBe(1);
    expect(plan.summary.clean).toBe(false);
  });

  it("flags an invalid date key", () => {
    const plan = hours.buildHoursImportPlan(
      sources({ entries: [entry("u-1", "2026-13-99")] })
    );
    expect(plan.invalidDates.length).toBe(1);
    expect(plan.summary.clean).toBe(false);
  });

  it("flags an invalid status", () => {
    const plan = hours.buildHoursImportPlan(
      sources({ entries: [entry("u-1", "2026-06-01", { status: "locked" })] })
    );
    expect(plan.invalidStatuses.length).toBe(1);
    expect(plan.summary.clean).toBe(false);
  });

  it("flags an allocation sum mismatch", () => {
    const plan = hours.buildHoursImportPlan(
      sources({
        entries: [entry("u-1", "2026-06-01", { totalHours: 8 }, [{ jobId: "job-a", hours: 5 }])],
      })
    );
    expect(plan.allocationSumMismatch.length).toBe(1);
    expect(plan.summary.clean).toBe(false);
  });

  it("flags ordinary+overtime != total", () => {
    const plan = hours.buildHoursImportPlan(
      sources({
        entries: [
          entry("u-1", "2026-06-01", { totalHours: 8, ordinaryHours: 8, overtimeHours: 3 }, [
            { jobId: "job-a", hours: 8 },
          ]),
        ],
      })
    );
    expect(plan.ordinaryOvertimeMismatch.length).toBe(1);
    expect(plan.summary.clean).toBe(false);
  });

  it("flags an over-16h day (schema CHECK)", () => {
    const plan = hours.buildHoursImportPlan(
      sources({
        entries: [
          entry("u-1", "2026-06-01", { totalHours: 18, ordinaryHours: 8, overtimeHours: 10 }, [
            { jobId: "job-a", hours: 18 },
          ]),
        ],
      })
    );
    expect(plan.over16Violations.length).toBe(1);
    expect(plan.summary.clean).toBe(false);
  });

  it("quarantines an entry whose user is not in users.json", () => {
    const plan = hours.buildHoursImportPlan(
      sources({ entries: [entry("u-ghost", "2026-06-01")] })
    );
    expect(plan.missingUserRefs.length).toBe(1);
    expect(plan.tables.time_entries.inserts).toBe(0);
    expect(plan.summary.clean).toBe(false);
  });

  it("quarantines an entry whose allocation job is missing", () => {
    const plan = hours.buildHoursImportPlan(
      sources({ entries: [entry("u-1", "2026-06-01", {}, [{ jobId: "job-gone", hours: 8 }])] })
    );
    expect(plan.missingJobRefs.length).toBe(1);
    expect(plan.tables.time_entries.inserts).toBe(0);
    expect(plan.summary.clean).toBe(false);
  });

  it("warns (not quarantines) on reopen/approval inconsistency", () => {
    const plan = hours.buildHoursImportPlan(
      sources({
        entries: [entry("u-1", "2026-06-01", { status: "approved", approvedBy: null, approvedAt: null })],
      })
    );
    expect(plan.reopenApprovalInconsistencies.length).toBe(1);
    expect(plan.tables.time_entries.inserts).toBe(1); // still importable
    expect(plan.summary.clean).toBe(true);
  });

  it("hard-errors when users.json is missing", () => {
    const plan = hours.buildHoursImportPlan({ users: null, jobs: { jobs: [] }, entries: [], payrollRuns: null });
    expect(plan.hardErrors.length).toBeGreaterThan(0);
    expect(plan.summary.clean).toBe(false);
  });
});

describe("hours run mode — write is blocked", () => {
  const DEV_REF = "devprojectref0123456";
  const devEnv = {
    SUPABASE_ENV: "preview",
    SUPABASE_PROJECT_REF: DEV_REF,
    SUPABASE_DB_URL: `postgresql://postgres.${DEV_REF}:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres`,
  };

  it("defaults to dry-run", () => {
    expect(resolveRunMode([], {}, guard)).toEqual({ mode: "dry-run" });
  });

  it("refuses --write when the guard blocks (production ref in preview)", () => {
    const env = {
      SUPABASE_ENV: "preview",
      SUPABASE_PROJECT_REF: guard.PRODUCTION_PROJECT_REF,
      SUPABASE_DB_URL: `postgresql://postgres.${guard.PRODUCTION_PROJECT_REF}:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres`,
    };
    expect(() => resolveRunMode(["--write"], env, guard)).toThrowError(/PROD_REF_IN_NON_PROD_ENV/);
  });

  it("refuses --write even when the guard permits — not implemented", () => {
    expect(() => resolveRunMode(["--write"], devEnv, guard)).toThrowError(/WRITE_NOT_IMPLEMENTED/);
  });
});

describe("hours importer cannot write — source-level proof", () => {
  it("planner imports no Blob/Supabase modules at all", () => {
    const src = readFileSync(planPath, "utf8");
    expect(src).not.toMatch(/@vercel\/blob|_lib\/blob|writeBlob|deleteBlob|postgres|supabase-js/);
  });

  it("the CLI uses only read helpers (list + readBlob), never a write function", () => {
    const src = readFileSync(cliPath, "utf8");
    // read-only enumeration + reads; @vercel/blob destructured as exactly
    // { list } proves put/del are never even imported into scope
    expect(src).toMatch(/const \{ list \} = require\('@vercel\/blob'\)/);
    expect(src).toMatch(/const \{ readBlob \} = require\('\.\.\/\.\.\/api\/_lib\/blob'\)/);
    // never a write CALL (call-syntax, so safety comments don't false-trip)
    expect(src).not.toMatch(/writeBlob|deleteBlob|\bput\s*\(|\bdel\s*\(/);
  });
});
