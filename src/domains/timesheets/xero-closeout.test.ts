import { describe, expect, it } from "vitest";
import {
  buildReviewPlan,
  chooseBatchForPeriod,
  hasTimesheetWriteScope,
  nextBatchStep,
  pushNeedsAttention,
  summarisePushResult,
  workerInitials,
  xeroFinaleAccess,
  type ReviewCandidate,
} from "./xero-closeout";

function candidate(p: Partial<ReviewCandidate> & { workerId: string; workerName: string }): ReviewCandidate {
  return { approvedHours: 38, overtimeHours: 0, hasOvertime: false, ...p };
}

const READY = {
  isAdmin: true,
  connectionFlag: true,
  exportFlag: true,
  connectionState: "connected",
  grantedScopes: "openid profile payroll.employees.read payroll.timesheets",
};

describe("hasTimesheetWriteScope", () => {
  it("finds the write scope among many", () => {
    expect(hasTimesheetWriteScope("openid payroll.employees.read payroll.timesheets")).toBe(true);
  });

  it("is false for a read-only grant", () => {
    expect(hasTimesheetWriteScope("openid payroll.employees.read payroll.settings.read")).toBe(false);
  });

  it("is false for null/empty", () => {
    expect(hasTimesheetWriteScope(null)).toBe(false);
    expect(hasTimesheetWriteScope("")).toBe(false);
  });

  it("does not match on a prefix", () => {
    // 'payroll.timesheets.read' must not satisfy the write scope.
    expect(hasTimesheetWriteScope("payroll.timesheets.read")).toBe(false);
  });
});

describe("xeroFinaleAccess", () => {
  it("is ready when admin, both flags on, connected and write-scoped", () => {
    expect(xeroFinaleAccess(READY)).toEqual({ kind: "ready" });
  });

  it("hides the finale from a leading hand even when everything else is on", () => {
    // The Xero endpoints are admin-only — offering the control would 403.
    expect(xeroFinaleAccess({ ...READY, isAdmin: false })).toEqual({ kind: "unavailable" });
  });

  it("hides the finale when either flag is dark", () => {
    expect(xeroFinaleAccess({ ...READY, connectionFlag: false })).toEqual({ kind: "unavailable" });
    expect(xeroFinaleAccess({ ...READY, exportFlag: false })).toEqual({ kind: "unavailable" });
  });

  it("asks for a connection when Xero is disconnected (ADR P8 — state it)", () => {
    expect(xeroFinaleAccess({ ...READY, connectionState: "disconnected" })).toEqual({ kind: "connect" });
    expect(xeroFinaleAccess({ ...READY, connectionState: "not_configured" })).toEqual({ kind: "connect" });
    expect(xeroFinaleAccess({ ...READY, connectionState: null })).toEqual({ kind: "connect" });
  });

  it("asks for a reconnect when the grant predates the write scope", () => {
    expect(
      xeroFinaleAccess({ ...READY, grantedScopes: "openid payroll.employees.read" }),
    ).toEqual({ kind: "reconnect" });
  });

  it("prefers the dark-flag verdict over the connection verdict", () => {
    // A disconnected Xero behind a dark flag must reveal nothing.
    expect(
      xeroFinaleAccess({ ...READY, exportFlag: false, connectionState: "disconnected" }),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("workerInitials", () => {
  it("takes the first two words", () => {
    expect(workerInitials("Alex Buhltest")).toBe("AB");
    expect(workerInitials("Mary Jane Watson")).toBe("MJ");
  });

  it("handles one name and messy spacing", () => {
    expect(workerInitials("Rhys")).toBe("R");
    expect(workerInitials("  Sam   Taylor ")).toBe("ST");
  });

  it("degrades rather than throwing on an empty name", () => {
    expect(workerInitials("")).toBe("—");
  });
});

describe("buildReviewPlan", () => {
  const READY_VALIDATION = { ready: true, errors: [], warnings: [] };

  it("lists every candidate with initials and totals their approved hours", () => {
    const plan = buildReviewPlan(
      [candidate({ workerId: "w1", workerName: "Alex Buhltest", approvedHours: 38 }),
       candidate({ workerId: "w2", workerName: "Jamie Moss", approvedHours: 34.2 })],
      READY_VALIDATION,
    );
    expect(plan.sendCount).toBe(2);
    expect(plan.totalHours).toBe(72.2);
    expect(plan.rows.map((r) => r.initials)).toEqual(["AB", "JM"]);
    expect(plan.canPush).toBe(true);
  });

  it("BLOCKS the whole period when one worker is unmapped", () => {
    // The engine locks all-or-nothing: lockBatch refuses while validation
    // reports any error. A finale that offered a partial push here would be
    // promising something the engine will refuse.
    const plan = buildReviewPlan(
      [candidate({ workerId: "w1", workerName: "Alex Buhltest", approvedHours: 38 }),
       candidate({ workerId: "w2", workerName: "Sam Taylor", approvedHours: 30 })],
      {
        ready: false,
        errors: [{
          code: "unmapped_workers",
          message: "1 worker(s) have no confirmed Xero employee link (Sam Taylor) — link them on the Xero settings page.",
          workers: ["Sam Taylor"],
        }],
        warnings: [],
      },
    );
    expect(plan.canPush).toBe(false);
    expect(plan.workerIssues).toHaveLength(1);
    expect(plan.workerIssues[0]!.workerName).toBe("Sam Taylor");
  });

  it("fans a multi-worker finding out into one issue per worker", () => {
    const plan = buildReviewPlan(
      [candidate({ workerId: "w1", workerName: "Alex Buhltest" })],
      {
        ready: false,
        errors: [{ code: "unmapped_workers", message: "…", workers: ["Sam Taylor", "Rhys Owen"] }],
        warnings: [],
      },
    );
    expect(plan.workerIssues.map((i) => i.workerName)).toEqual(["Sam Taylor", "Rhys Owen"]);
    expect(plan.generalIssues).toHaveLength(0);
  });

  it("keeps a period-wide error out of the per-worker list", () => {
    const plan = buildReviewPlan(
      [candidate({ workerId: "w1", workerName: "Alex Buhltest" })],
      {
        ready: false,
        errors: [{ code: "org_mismatch", message: "This batch belongs to a different Xero organisation." }],
        warnings: [],
      },
    );
    expect(plan.generalIssues).toHaveLength(1);
    expect(plan.generalIssues[0]!.code).toBe("org_mismatch");
    expect(plan.workerIssues).toHaveLength(0);
    expect(plan.canPush).toBe(false);
  });

  it("surfaces warnings without blocking the push", () => {
    const plan = buildReviewPlan([candidate({ workerId: "w1", workerName: "Alex Buhltest" })], {
      ready: true,
      errors: [],
      warnings: [{ code: "employee_terminated", message: "Terminated in Xero.", workers: ["Alex Buhltest"] }],
    });
    expect(plan.canPush).toBe(true);
    expect(plan.warnings).toHaveLength(1);
    // Terminated ≠ withheld: the worker is still being sent.
    expect(plan.withheld).toHaveLength(0);
    expect(plan.sendCount).toBe(1);
  });

  it("WITHHOLDS an unmapped worker reported as a warning — the skip-with-warning engine", () => {
    // The backend is moving unmapped workers from blocking errors to warnings
    // (skipped with a warning). The plan must then name them as staying OUT of
    // this push, drop them from the send list, and still allow the push.
    const plan = buildReviewPlan(
      [candidate({ workerId: "w1", workerName: "Alex Buhltest", approvedHours: 38 }),
       candidate({ workerId: "w2", workerName: "Sam Taylor", approvedHours: 30 })],
      {
        ready: true,
        errors: [],
        warnings: [{
          code: "unmapped_workers",
          message: "1 worker(s) have no confirmed Xero employee link (Sam Taylor).",
          workers: ["Sam Taylor"],
        }],
      },
    );
    expect(plan.canPush).toBe(true);
    expect(plan.withheld.map((w) => w.workerName)).toEqual(["Sam Taylor"]);
    // The send list — and its totals — honestly exclude the withheld worker.
    expect(plan.rows.map((r) => r.workerName)).toEqual(["Alex Buhltest"]);
    expect(plan.sendCount).toBe(1);
    expect(plan.totalHours).toBe(38);
    // Withheld findings are not duplicated into the generic warning list.
    expect(plan.warnings).toHaveLength(0);
  });

  it("cannot push when EVERY worker is withheld — nothing would be sent", () => {
    const plan = buildReviewPlan(
      [candidate({ workerId: "w2", workerName: "Sam Taylor", approvedHours: 30 })],
      {
        ready: true,
        errors: [],
        warnings: [{ code: "unmapped_workers", message: "…", workers: ["Sam Taylor"] }],
      },
    );
    expect(plan.sendCount).toBe(0);
    expect(plan.canPush).toBe(false);
  });

  it("carries the overtime split for the 'incl. Xh OT' subline", () => {
    const plan = buildReviewPlan(
      [candidate({ workerId: "w1", workerName: "Alex Buhltest", approvedHours: 40.2, overtimeHours: 2.2, hasOvertime: true })],
      READY_VALIDATION,
    );
    expect(plan.rows[0]!.overtimeHours).toBe(2.2);
    expect(plan.rows[0]!.hasOvertime).toBe(true);
  });

  it("cannot push an empty week even when validation is happy", () => {
    const plan = buildReviewPlan([], READY_VALIDATION);
    expect(plan.sendCount).toBe(0);
    expect(plan.canPush).toBe(false);
  });

  it("cannot push while validation is still unknown", () => {
    // Null = the preview hasn't landed (or failed). Never offer the button.
    const plan = buildReviewPlan([candidate({ workerId: "w1", workerName: "Alex Buhltest" })], null);
    expect(plan.canPush).toBe(false);
  });
});

describe("summarisePushResult", () => {
  const hours = new Map([
    ["Alex Buhltest", 38],
    ["Jamie Moss", 34.2],
  ]);

  it("counts ONLY verified as created, and sums their hours", () => {
    const summary = summarisePushResult(
      [
        { worker: "Alex Buhltest", outcome: "verified", xeroTimesheetId: "ts1" },
        { worker: "Jamie Moss", outcome: "verified", xeroTimesheetId: "ts2" },
      ],
      hours,
    );
    expect(summary.created).toBe(2);
    expect(summary.createdHours).toBe(72.2);
    expect(summary.clean).toBe(true);
  });

  it("never counts a drifted timesheet as created", () => {
    // Xero accepted it but the readback disagreed — claiming success here
    // would be exactly the lie P7 forbids.
    const summary = summarisePushResult(
      [{ worker: "Alex Buhltest", outcome: "drifted", xeroTimesheetId: "ts1", mismatches: ["units"] }],
      hours,
    );
    expect(summary.created).toBe(0);
    expect(summary.createdHours).toBe(0);
    expect(summary.drifted).toHaveLength(1);
    expect(summary.drifted[0]!.message).toContain("units");
    expect(summary.clean).toBe(false);
  });

  it("never counts a rejection or an error as created", () => {
    const summary = summarisePushResult(
      [
        { worker: "Alex Buhltest", outcome: "rejected", category: "validation" },
        { worker: "Jamie Moss", outcome: "error", category: "network" },
      ],
      hours,
    );
    expect(summary.created).toBe(0);
    expect(summary.failed).toHaveLength(2);
    expect(summary.clean).toBe(false);
  });

  it("treats an unknown future outcome as a failure, not a success", () => {
    const summary = summarisePushResult([{ worker: "Alex Buhltest", outcome: "something_new" }], hours);
    expect(summary.created).toBe(0);
    expect(summary.failed).toHaveLength(1);
  });

  it("reports skipped separately and does not call it a failure", () => {
    const summary = summarisePushResult(
      [
        { worker: "Alex Buhltest", outcome: "verified" },
        { worker: "Jamie Moss", outcome: "skipped", reason: "already_verified" },
      ],
      hours,
    );
    expect(summary.created).toBe(1);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.failed).toHaveLength(0);
    // A skip is a retry-safe no-op, so the run is still clean.
    expect(summary.clean).toBe(true);
  });

  it("is not clean when nothing was created", () => {
    expect(summarisePushResult([], hours).clean).toBe(false);
  });

  it("falls back to 0 hours rather than inventing a figure for an unknown name", () => {
    const summary = summarisePushResult([{ worker: "Ghost Worker", outcome: "verified" }], hours);
    expect(summary.created).toBe(1);
    expect(summary.createdHours).toBe(0);
  });
});

describe("pushNeedsAttention", () => {
  it("is false for a clean run", () => {
    const summary = summarisePushResult([{ worker: "Alex Buhltest", outcome: "verified" }]);
    expect(pushNeedsAttention(summary)).toBe(false);
  });

  it("is true when anything drifted, failed or blocked", () => {
    expect(pushNeedsAttention(summarisePushResult([{ worker: "A", outcome: "drifted" }]))).toBe(true);
    expect(pushNeedsAttention(summarisePushResult([{ worker: "A", outcome: "error" }]))).toBe(true);
    expect(pushNeedsAttention(summarisePushResult([{ worker: "A", outcome: "blocked" }]))).toBe(true);
  });
});

describe("chooseBatchForPeriod", () => {
  it("returns null when the period has no batch", () => {
    expect(chooseBatchForPeriod([])).toBeNull();
  });

  it("resumes an in-flight export rather than forking a new batch", () => {
    const picked = chooseBatchForPeriod([
      { id: "b_locked", status: "locked" },
      { id: "b_exporting", status: "exporting" },
    ]);
    expect(picked!.id).toBe("b_exporting");
  });

  it("prefers a partially exported batch over a fresh locked one", () => {
    const picked = chooseBatchForPeriod([
      { id: "b_locked", status: "locked" },
      { id: "b_partial", status: "partially_exported" },
    ]);
    expect(picked!.id).toBe("b_partial");
  });

  it("prefers a locked batch over an unlocked draft", () => {
    const picked = chooseBatchForPeriod([
      { id: "b_draft", status: "draft" },
      { id: "b_locked", status: "locked" },
    ]);
    expect(picked!.id).toBe("b_locked");
  });

  it("breaks ties on the highest revision — a correction supersedes", () => {
    const picked = chooseBatchForPeriod([
      { id: "b_v1", status: "locked", revision: 1 },
      { id: "b_v2", status: "locked", revision: 2 },
    ]);
    expect(picked!.id).toBe("b_v2");
  });
});

describe("nextBatchStep", () => {
  it("creates when the period has no batch", () => {
    expect(nextBatchStep(null)).toBe("create");
  });

  it("locks a ready batch", () => {
    expect(nextBatchStep({ status: "ready" })).toBe("lock");
  });

  it("exports a locked batch, and resumes an in-flight one", () => {
    expect(nextBatchStep({ status: "locked" })).toBe("export");
    expect(nextBatchStep({ status: "exporting" })).toBe("export");
    expect(nextBatchStep({ status: "partially_exported" })).toBe("export");
  });

  it("is done once the batch is fully exported", () => {
    expect(nextBatchStep({ status: "exported" })).toBe("done");
  });

  it("routes a blocked or draft batch to a correction, never to a lock", () => {
    // Locking these would be refused server-side (validation_failed).
    expect(nextBatchStep({ status: "blocked" })).toBe("correction");
    expect(nextBatchStep({ status: "draft" })).toBe("correction");
  });
});
