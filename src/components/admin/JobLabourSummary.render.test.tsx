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
  estimatedHours?: number | null;
  progressPct?: number | null;
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
    // No hours stat tiles render at all (the honest empty state), so the
    // other job's "8h" never surfaces as a labour figure. (Assert on the tile
    // label rather than a bare "8h" substring — lucide icon SVG paths like the
    // Info glyph's "M12 8h.01" contain "8h" incidentally.)
    expect(html).not.toContain("Awaiting approval");
    expect(html).not.toContain("By worker");
  });

  it("shows an honest error note but still links to approvals", () => {
    const html = render({ entries: [], jobId: "job-1", fetchError: "API returned 500" });
    expect(html).toContain("load hours for this job");
    expect(html).toContain("API returned 500");
    expect(html).toContain("/hours/approvals");
  });

  // #343 — time-overrun early-warning, surfaced honestly on the Labour card.
  it("with NO estimate (every job today) shows 'No time estimate set', never a fabricated ratio", () => {
    const html = render({
      entries: [entry({ status: "approved", allocations: [{ jobId: "job-1", hours: 40 }] } as Partial<TimeEntry>)],
      jobId: "job-1",
      fetchError: null,
      estimatedHours: null,
      progressPct: 20,
    });
    expect(html).toContain("No time estimate set");
  });

  it("flags an overrun with its exact math when hours outpace progress", () => {
    const html = render({
      entries: [entry({ status: "approved", allocations: [{ jobId: "job-1", hours: 80 }] } as Partial<TimeEntry>)],
      jobId: "job-1",
      fetchError: null,
      estimatedHours: 100, // 80/100 = 80% burnt
      progressPct: 30, // 30% complete → flag fires
    });
    expect(html).toContain("Hours outpacing progress");
    expect(html).toContain("80 of 100 estimated hours used (80%), 30% complete");
  });

  it("stays quiet when hours are on track (no false alarm)", () => {
    const html = render({
      entries: [entry({ status: "approved", allocations: [{ jobId: "job-1", hours: 40 }] } as Partial<TimeEntry>)],
      jobId: "job-1",
      fetchError: null,
      estimatedHours: 100, // 40% burnt
      progressPct: 60, // ahead of spend
    });
    expect(html).not.toContain("Hours outpacing progress");
    expect(html).not.toContain("No time estimate set");
  });

  it("with an estimate but no task lists says it can't compare to progress", () => {
    const html = render({
      entries: [entry({ status: "approved", allocations: [{ jobId: "job-1", hours: 90 }] } as Partial<TimeEntry>)],
      jobId: "job-1",
      fetchError: null,
      estimatedHours: 100,
      progressPct: null, // no tasks
    });
    expect(html).toContain("No progress to compare");
    expect(html).toContain("no tasks set up");
  });
});
