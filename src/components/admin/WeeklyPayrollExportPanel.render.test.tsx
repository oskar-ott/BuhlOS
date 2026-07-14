import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { WeeklyPayrollExportPanel } from "./WeeklyPayrollExportPanel";
import type { PayrollRun } from "@/domains/timesheets/types";

/**
 * Static-render guards for the weekly payroll runs panel (#126 / #895).
 *
 * The committed (mutating) run is retired — this surface is now a READ-ONLY
 * run log plus copy pointing at the payroll-batch flow. The critical invariant
 * survives: no mutating export URL renders as an <a href> (there is no export
 * link at all now), and there is no preview/commit action.
 */

const run: PayrollRun = {
  exportId: "exp_abc123",
  hash: "deadbeef".repeat(8),
  actorName: "boss",
  at: "2026-06-12T06:00:00.000Z",
  range: { fromDate: "2026-06-08", toDate: "2026-06-14", status: "approved" },
  rowCount: 12,
} as PayrollRun;

const base = {
  weekStart: "2026-06-08",
  weekEnd: "2026-06-14",
  weekLabel: "8 Jun – 14 Jun",
  notReadyWorkers: [],
  initialRuns: [run],
  runsError: null,
};

describe("WeeklyPayrollExportPanel", () => {
  it("read-only: points at the batch flow, no export link or commit action", () => {
    const html = renderToString(createElement(WeeklyPayrollExportPanel, base));
    expect(html).toContain("Hours → Payroll period");
    expect(html).toContain("no longer stamps hours");
    // no mutating GET as a hyperlink, and no preview/commit action
    expect(html).not.toContain('href="/api/time-entries-export');
    expect(html).not.toContain("Preview this week");
  });

  it("renders the run log verbatim: id, range, rows, actor, hash prefix", () => {
    const html = renderToString(createElement(WeeklyPayrollExportPanel, base));
    expect(html).toContain("exp_abc123");
    expect(html).toContain("2026-06-08");
    expect(html).toContain("2026-06-14");
    expect(html).toContain("12 rows");
    expect(html).toContain("by boss");
    expect(html).toContain("deadbeef");
  });

  it("empty log and failed log are distinct and honest", () => {
    const empty = renderToString(
      createElement(WeeklyPayrollExportPanel, { ...base, initialRuns: [] }),
    );
    expect(empty).toContain("No committed runs yet");

    const failed = renderToString(
      createElement(WeeklyPayrollExportPanel, {
        ...base,
        initialRuns: [],
        runsError: "Runs API returned 500",
      }),
    );
    expect(failed).toContain("load the run log");
    expect(failed).not.toContain("No committed runs yet");
  });
});
