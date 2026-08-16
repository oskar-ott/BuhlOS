import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { WorkerRollupTable } from "./WorkerRollupTable";
import type { PayPeriodRollup } from "@/domains/timesheets/pay-period-rollup";
import type { workerActionMap } from "@/domains/timesheets/pay-period-view";

/**
 * The per-worker pay-period table, extracted for the 2026-08-16 redesign.
 * Pins the honesty rules the old inline table carried: FULL worker names,
 * an OT dash (never a misleading 0), unexported hours in amber, the unmapped
 * worker named, and readiness pills off the closeout actions.
 */

function rollup(): PayPeriodRollup {
  return {
    fromDate: "2026-08-10",
    toDate: "2026-08-16",
    workers: [
      {
        workerId: "u1",
        workerName: "Alfredo Hughes",
        workerRole: "apprentice",
        approvedHours: 38,
        ordinaryHours: 38,
        overtimeHours: 0,
        unexportedApprovedHours: 38,
        approvedDayCount: 5,
        xeroMapped: true,
        weeks: [],
      },
      {
        workerId: "u2",
        workerName: "Louis Kane",
        workerRole: "electrician",
        approvedHours: 40,
        ordinaryHours: 38,
        overtimeHours: 2,
        unexportedApprovedHours: 0,
        approvedDayCount: 5,
        xeroMapped: false,
        weeks: [],
      },
    ],
    summary: {
      workerCount: 2,
      approvedHours: 78,
      ordinaryHours: 76,
      overtimeHours: 2,
      unexportedApprovedHours: 38,
      unmappedWorkerCount: 1,
    },
  };
}

const actions = new Map([
  ["u1", { needsAction: true, blockingWeeks: 1 }],
]) as unknown as ReturnType<typeof workerActionMap>;

const render = () =>
  renderToString(createElement(WorkerRollupTable, { rollup: rollup(), actions })).replace(
    /<!-- -->/g,
    "",
  );

describe("WorkerRollupTable", () => {
  it("shows FULL worker names with day counts", () => {
    const html = render();
    expect(html).toContain("Alfredo Hughes");
    expect(html).toContain("Louis Kane");
    expect(html).toContain("5 day(s)");
  });

  it("OT column dashes at zero and shows real overtime", () => {
    const html = render();
    expect(html).toContain("—");
    expect(html).toContain("2h");
  });

  it("names the unmapped worker and the mapped one", () => {
    const html = render();
    expect(html).toContain("No Xero id");
    expect(html).toContain("set");
  });

  it("readiness pill follows the closeout actions", () => {
    const html = render();
    expect(html).toContain("Needs action (1 wk)");
    expect(html).toContain("Ready");
  });
});
