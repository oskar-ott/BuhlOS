import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QaStatusBoard } from "./QaStatusBoard";
import type { QaStatusResult } from "@/server/itp/qa-status";
import { buildQaDashboard } from "@/domains/itp/qa-rollup";
import type { ITPInstance, ITPStatus } from "@/domains/itp/types";

function render(result: QaStatusResult): string {
  return renderToString(createElement(QaStatusBoard, { result })).replace(/<!-- -->/g, "");
}

function inst(status: ITPStatus, updatedAt: string): ITPInstance {
  return {
    id: `i_${status}_${updatedAt}`,
    templateId: "t",
    templateSnapshot: { templateId: "t", name: "T", points: [] },
    scope: "job",
    status,
    results: {},
    createdAt: updatedAt,
    createdBy: "u",
    updatedAt,
    ...(status === "signed-off" ? { signedOffBy: "b", signedOffAt: updatedAt } : {}),
  } as unknown as ITPInstance;
}

const RESULT: QaStatusResult = {
  ok: true,
  scannedJobs: 3,
  failedJobs: ["j_bad"],
  dashboard: {
    rows: [
      {
        jobId: "j_await",
        jobName: "Reception fitout",
        rollup: {
          total: 2,
          statusCounts: { pending: 0, "in-progress": 1, witnessed: 1, "signed-off": 0 },
          activeCount: 2,
          awaitingSignOff: 1,
          openPoints: 3,
          oldestActiveAt: "2026-06-06T00:00:00.000Z",
          oldestActiveAgeDays: 9,
        },
      },
      {
        jobId: "j_empty",
        jobName: "New shed",
        rollup: {
          total: 0,
          statusCounts: { pending: 0, "in-progress": 0, witnessed: 0, "signed-off": 0 },
          activeCount: 0,
          awaitingSignOff: 0,
          openPoints: 0,
          oldestActiveAt: null,
          oldestActiveAgeDays: null,
        },
      },
    ],
    totals: {
      jobs: 2,
      jobsWithItps: 1,
      instances: 2,
      activeInstances: 2,
      awaitingSignOff: 1,
      openPoints: 3,
    },
    oldestActiveAgeDays: 9,
  },
};

describe("QaStatusBoard", () => {
  it("renders the totals header and rows in the given (worst-first) order", () => {
    const html = render(RESULT);
    expect(html).toContain("QA status");
    expect(html).toContain("Reception fitout");
    expect(html).toContain("Awaiting sign-off: 1");
    expect(html).toContain("Active checks: 2");
    expect(html).toMatch(/Oldest active:\s*9d/); // exact header age, not a loose "9d"
    // rows render in the order given (the server sorts worst-first)
    expect(html.indexOf("Reception fitout")).toBeLessThan(html.indexOf("New shed"));
  });

  it("renders from a REAL buildQaDashboard result (exercises the producer sort + totals end-to-end)", () => {
    const NOW = "2026-06-15T00:00:00.000Z";
    const dashboard = buildQaDashboard(
      [
        { jobId: "j_clear", jobName: "Clear job", instances: [inst("signed-off", "2026-06-01T00:00:00.000Z")] },
        { jobId: "j_await", jobName: "Awaiting job", instances: [inst("witnessed", "2026-06-05T00:00:00.000Z")] },
      ],
      NOW,
    );
    const html = render({ ok: true, scannedJobs: 2, failedJobs: [], dashboard });
    // worst-first comes from the real sort, not a hand-authored order
    expect(html.indexOf("Awaiting job")).toBeLessThan(html.indexOf("Clear job"));
    expect(html).toContain("Awaiting sign-off: 1");
    expect(html).toMatch(/Oldest active:\s*10d/); // computed: 2026-06-05 → 2026-06-15
  });

  it("drills through to the existing per-job ITP surface", () => {
    expect(render(RESULT)).toContain('href="/v2/jobs/j_await/itps"');
  });

  it("renders a job with no ITPs as an honest gap, not all-clear", () => {
    const html = render(RESULT);
    expect(html).toContain("New shed");
    expect(html).toContain("No ITPs attached");
  });

  it("surfaces jobs whose QA couldn't be read", () => {
    expect(render(RESULT)).toMatch(/1 job.*couldn.t be read/i);
  });

  it("renders an empty board honestly when there are no active jobs", () => {
    const html = render({ ok: true, scannedJobs: 0, failedJobs: [], dashboard: { rows: [], totals: { jobs: 0, jobsWithItps: 0, instances: 0, activeInstances: 0, awaitingSignOff: 0, openPoints: 0 }, oldestActiveAgeDays: null } });
    expect(html).toContain("No active jobs to report QA on.");
  });

  it("renders a plain error when the read failed", () => {
    expect(render({ ok: false, error: "x" })).toContain("Could not load the QA dashboard.");
  });
});
