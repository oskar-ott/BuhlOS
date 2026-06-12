import { describe, expect, it } from "vitest";
import {
  notPayrollReadyWorkers,
  payrollCommitUrl,
  payrollPreviewUrl,
  summariseAlreadyExported,
} from "./payroll-export";

/**
 * Guards for the two payroll-export traps (#126): the URL builders REFUSE to
 * emit a request without an explicit week (the endpoint's default range is
 * server-local — the wrong week on a Sydney Monday morning), and the commit
 * URL never widens beyond approved or carries dryRun.
 */

const WEEK = { fromDate: "2026-06-08", toDate: "2026-06-14" };

describe("payroll export URLs", () => {
  it("preview URL: dry-run JSON with the explicit week", () => {
    expect(payrollPreviewUrl(WEEK)).toBe(
      "/api/time-entries-export?dryRun=1&format=json&fromDate=2026-06-08&toDate=2026-06-14",
    );
  });

  it("commit URL: status pinned to approved, NO dryRun, explicit week", () => {
    const url = payrollCommitUrl(WEEK);
    expect(url).toBe(
      "/api/time-entries-export?status=approved&fromDate=2026-06-08&toDate=2026-06-14",
    );
    expect(url).not.toContain("dryRun");
  });

  it("both builders throw rather than fall back to the server's default week", () => {
    expect(() => payrollPreviewUrl({ fromDate: "", toDate: "2026-06-14" })).toThrow();
    expect(() => payrollCommitUrl({ fromDate: "2026-06-08", toDate: "next sunday" })).toThrow();
  });
});

describe("summariseAlreadyExported", () => {
  it("counts stamped rows and collects distinct run ids", () => {
    const result = summariseAlreadyExported([
      { date: "2026-06-09", workerName: "A", exportId: "exp_1" },
      { date: "2026-06-10", workerName: "A", exportId: "exp_1" },
      { date: "2026-06-10", workerName: "B", exportId: "exp_2" },
      { date: "2026-06-11", workerName: "B" },
    ]);
    expect(result).toEqual({ rowCount: 3, exportIds: ["exp_1", "exp_2"] });
  });

  it("a clean week reports zero", () => {
    expect(summariseAlreadyExported([])).toEqual({ rowCount: 0, exportIds: [] });
  });
});

describe("notPayrollReadyWorkers", () => {
  it("names everyone the closeout didn't band payroll-ready", () => {
    expect(
      notPayrollReadyWorkers([
        { workerName: "Sam", readiness: "payroll-ready" },
        { workerName: "Alex", readiness: "needs-review" },
        { workerName: "Riley", readiness: "missing-hours" },
      ]),
    ).toEqual(["Alex", "Riley"]);
  });
});
