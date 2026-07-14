import { describe, expect, it } from "vitest";
import { notPayrollReadyWorkers, payrollPreviewUrl } from "./payroll-export";

/**
 * Guards for the pay-period payroll download helpers (#126 / #895). The commit
 * URL builder is retired with the legacy committed run; the dry-run PREVIEW URL
 * still REFUSES to emit a request without an explicit week (the endpoint's
 * default range is server-local — the wrong week on a Sydney Monday morning).
 */

const WEEK = { fromDate: "2026-06-08", toDate: "2026-06-14" };

describe("payroll export URLs", () => {
  it("preview URL: dry-run JSON with the explicit week", () => {
    expect(payrollPreviewUrl(WEEK)).toBe(
      "/api/time-entries-export?dryRun=1&format=json&fromDate=2026-06-08&toDate=2026-06-14",
    );
  });

  it("the preview builder throws rather than fall back to the server's default week", () => {
    expect(() => payrollPreviewUrl({ fromDate: "", toDate: "2026-06-14" })).toThrow();
    expect(() => payrollPreviewUrl({ fromDate: "2026-06-08", toDate: "next sunday" })).toThrow();
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
