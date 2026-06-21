import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { RejectedHoursResubmitSheet } from "./RejectedHoursResubmitSheet";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * SSR render tests (vitest `environment: node`, no jsdom). They assert the
 * initial rendered markup; the dynamic submit success/error and the
 * attribution-blocking logic are unit-tested as pure functions in
 * src/domains/timesheets/resubmit.test.ts (the component delegates to them).
 */

function te(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "te-1",
    userId: "u1",
    date: "2026-06-03",
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "rejected",
    rejectedReason: "Logged to the wrong job",
    allocations: [{ jobId: "job-a", hours: 7.6, notes: null }],
    createdAt: "2026-06-03T08:00:00Z",
    updatedAt: "2026-06-03T08:00:00Z",
    ...over,
  } as unknown as TimeEntry;
}

const ONE_JOB = [{ id: "job-a", name: "Smith St" }];
const TWO_JOBS = [
  { id: "job-a", name: "Smith St" },
  { id: "job-b", name: "Jones Rd" },
];

function render(props: Parameters<typeof RejectedHoursResubmitSheet>[0]): string {
  return renderToString(createElement(RejectedHoursResubmitSheet, props));
}

describe("RejectedHoursResubmitSheet", () => {
  it("collapses to a single 'Fix rejected hours' trigger", () => {
    const html = render({ entry: te(), assignedJobs: ONE_JOB });
    expect(html).toContain("Fix rejected hours");
    expect(html).not.toContain("Submit correction");
  });

  it("opens to a resubmit form showing the reason and the assigned job", () => {
    const html = render({ entry: te(), assignedJobs: ONE_JOB, defaultOpen: true });
    expect(html).toContain("Reason:");
    expect(html).toContain("Logged to the wrong job");
    expect(html).toContain("Hours for this job");
    expect(html).toContain("Submit correction");
    expect(html).toContain("Smith St");
  });

  it("requires an explicit pick when multiple jobs and the original job is null", () => {
    const nullJob = te({ allocations: [{ jobId: null, hours: 7.6, notes: null }] });
    const html = render({ entry: nullJob, assignedJobs: TWO_JOBS, defaultOpen: true });
    expect(html).toContain("Pick one");
    expect(html).toContain("Jones Rd");
  });

  it("blocks honestly when jobs failed to load (no null fallback)", () => {
    const html = render({ entry: te(), assignedJobs: [], jobsError: true, defaultOpen: true });
    expect(html).toContain("load your jobs");
  });

  it("blocks honestly when the worker has no active assigned job", () => {
    const html = render({ entry: te(), assignedJobs: [], defaultOpen: true });
    expect(html).toContain("No active assigned job");
  });

  it("shows no admin / payroll controls", () => {
    const html = render({ entry: te(), assignedJobs: ONE_JOB, defaultOpen: true });
    for (const banned of ["Payroll", "Xero", "Pay run", "Approve", "Reject"]) {
      expect(html).not.toContain(banned);
    }
  });

  // #128 — a rejected SPLIT day opens the split editor (allocations preserved),
  // never the single-job form.
  const splitEntry = () =>
    te({
      totalHours: 7.6,
      allocations: [
        { jobId: "job-a", hours: 4, notes: null },
        { jobId: "job-b", hours: 3.6, notes: null },
      ],
    });

  it("a split day still collapses to the single 'Fix rejected hours' trigger", () => {
    const html = render({ entry: splitEntry(), assignedJobs: TWO_JOBS });
    expect(html).toContain("Fix rejected hours");
    expect(html).not.toContain("split-day-sheet");
  });

  it("opens a split entry into the split editor, not the single-job form", () => {
    const html = render({ entry: splitEntry(), assignedJobs: TWO_JOBS, defaultOpen: true });
    expect(html).toContain("split-day-sheet"); // SplitDaySheet rendered
    expect(html).toContain("Fix &amp; resubmit the split day");
    expect(html).not.toContain("Hours for this job"); // NOT the single-job legend
    expect(html).not.toContain("Submit correction"); // NOT the single-job action
  });

  it("blocks a split resubmit honestly when jobs failed to load", () => {
    const html = render({ entry: splitEntry(), assignedJobs: [], jobsError: true, defaultOpen: true });
    expect(html).toContain("load your jobs");
    expect(html).not.toContain("split-day-sheet"); // editor not shown until jobs load
  });
});
