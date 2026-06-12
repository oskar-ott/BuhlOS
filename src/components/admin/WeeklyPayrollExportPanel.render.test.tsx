import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { WeeklyPayrollExportPanel } from "./WeeklyPayrollExportPanel";
import type { PayrollRun } from "@/domains/timesheets/types";

/**
 * Static-render guards for the committed-export panel (#126). The live
 * preview→confirm→commit flow is pinned by the export API harness + the
 * pure URL-builder tests; these pin the initial surface and the runs-log
 * rendering (straight from payroll-runs.json fields, no embellishment).
 *
 * CRITICAL invariant asserted here: the committed (mutating) export URL
 * never renders as an <a href> — navigation happens only inside an onClick,
 * so nothing can prefetch a payroll mutation.
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
  it("initial state: preview CTA, no committed-export link anywhere", () => {
    const html = renderToString(createElement(WeeklyPayrollExportPanel, base));
    expect(html).toContain("Preview this week");
    expect(html).toContain("nothing is stamped until");
    // The mutating GET must never be a hyperlink Next could prefetch.
    expect(html).not.toContain('href="/api/time-entries-export');
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
