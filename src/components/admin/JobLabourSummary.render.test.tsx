import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobLabourSummary } from "./JobLabourSummary";
import type { TimeEntry } from "@/domains/timesheets/types";

// Plain server component (no hooks / next-navigation), so renderToString needs
// no mocks. Asserts the Labour card surfaces only real, job-scoped pending
// hours and is honest when there are none.
function entry(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "te-1",
    userId: "u1",
    userName: "Jack",
    date: "2026-06-04",
    status: "submitted",
    totalHours: 8,
    allocations: [{ jobId: "job-1", hours: 8 }],
    ...over,
  } as unknown as TimeEntry;
}

function render(props: {
  entries: TimeEntry[];
  jobId: string;
  fetchError: string | null;
}): string {
  return renderToString(createElement(JobLabourSummary, props));
}

describe("JobLabourSummary", () => {
  it("is honest when nothing is awaiting approval (never 'no hours logged')", () => {
    const html = render({ entries: [], jobId: "job-1", fetchError: null });
    expect(html).toContain("No labour recorded on this job yet");
    expect(html).not.toContain("Awaiting approval"); // no stat tiles
    // Always deep-links to the full approvals ledger.
    expect(html).toContain("/hours/approvals");
    expect(html).toContain("Review hours approvals");
  });

  it("summarises pending hours and the per-worker breakdown from real data", () => {
    const html = render({
      entries: [
        entry({ id: "a", userId: "u1", userName: "Jack", allocations: [{ jobId: "job-1", hours: 8 }] } as Partial<TimeEntry>),
        entry({ id: "b", userId: "u2", userName: "Sam", allocations: [{ jobId: "job-1", hours: 4 }] } as Partial<TimeEntry>),
      ],
      jobId: "job-1",
      fetchError: null,
    });
    expect(html).toContain("Awaiting approval");
    expect(html).toContain("12h"); // 8 + 4 pending
    expect(html).toContain("By worker");
    expect(html).toContain("Jack");
    expect(html).toContain("Sam");
    expect(html).toContain("8h");
    expect(html).toContain("4h");
  });

  it("shows approved AND pending hours by status (#134), both workers in the breakdown", () => {
    const html = render({
      entries: [
        entry({ id: "a", userId: "u1", userName: "Jack", status: "submitted", allocations: [{ jobId: "job-1", hours: 8 }] } as Partial<TimeEntry>),
        entry({ id: "b", userId: "u2", userName: "Sam", status: "approved", allocations: [{ jobId: "job-1", hours: 12 }] } as Partial<TimeEntry>),
      ],
      jobId: "job-1",
      fetchError: null,
    });
    expect(html).toContain("Approved");
    expect(html).toContain("12h"); // approved now surfaces
    expect(html).toContain("Awaiting approval");
    expect(html).toContain("8h"); // pending
    expect(html).toContain("Jack");
    expect(html).toContain("Sam"); // both workers in the breakdown
    // (rejected/draft are excluded at the /api/job-hours endpoint, tested in
    // job-hours-api.test.ts — the card buckets whatever statuses it's handed.)
  });

  it("filters to this job — other jobs' hours never leak in", () => {
    const html = render({
      entries: [entry({ allocations: [{ jobId: "job-OTHER", hours: 8 }] } as Partial<TimeEntry>)],
      jobId: "job-1",
      fetchError: null,
    });
    expect(html).toContain("No labour recorded on this job yet");
    expect(html).not.toContain("8h");
  });

  it("shows an honest error note but still links to approvals", () => {
    const html = render({ entries: [], jobId: "job-1", fetchError: "API returned 500" });
    expect(html).toContain("load hours for this job");
    expect(html).toContain("API returned 500");
    expect(html).toContain("/hours/approvals");
  });
});
