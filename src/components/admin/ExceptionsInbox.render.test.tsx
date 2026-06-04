import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ExceptionsInbox } from "./ExceptionsInbox";
import type { ExceptionItem } from "@/domains/exceptions/types";

/**
 * SSR smoke for the operational Exceptions Inbox (node env). renderToString
 * shows the DEFAULT view (tab "all", no filters) — enough to cover the summary,
 * tabs, list rows, badges, age, and the available/fallback/unavailable action
 * rendering. Tab switching + grouping are covered by the grouping/service unit
 * tests (groupExceptionsByJob, filterExceptions, …).
 */

const ITEMS: ExceptionItem[] = [
  {
    id: "job-no-crew:j2",
    source: "job",
    sourceId: "j2",
    jobId: "j2",
    jobName: "Bravo",
    title: "Bravo: active but no field workers assigned",
    summary: "Assign workers so the crew can see this job in Phil.",
    severity: "critical",
    actionLabel: "Assign workers",
    actionHref: "/v2/jobs/j2/builder",
    actionState: "available",
    sourceLabel: "Jobs",
    ageLabel: "3h ago",
  },
  {
    id: "hours-rejected:t2",
    source: "hours",
    sourceId: "t2",
    title: "Rejected hours from Oskar (2026-06-01) need correction",
    summary: "Reason: Wrong job",
    severity: "warning",
    actionLabel: "Review rejections",
    actionHref: "/hours/approvals",
    actionState: "available",
    sourceLabel: "Hours",
  },
];

const FALLBACK_ITEM: ExceptionItem = {
  id: "evidence-job:j9",
  source: "evidence",
  sourceId: "j9",
  jobId: "j9",
  jobName: "Charlie",
  title: "Charlie: 2 evidence to review",
  severity: "warning",
  actionLabel: "Open evidence",
  actionHref: "/v2/jobs/j9", // degraded to the job hub
  actionState: "fallback",
  actionReason: "Section route unavailable; opening the job.",
  sourceLabel: "Evidence",
};

const UNAVAILABLE_ITEM: ExceptionItem = {
  id: "future:x1",
  source: "gear",
  sourceId: "x1",
  jobName: "Bravo",
  title: "Gear overdue (source not wired yet)",
  severity: "info",
  actionLabel: "Open gear",
  actionHref: undefined,
  actionState: "unavailable",
  actionReason: "Gear surface isn’t wired into the inbox yet.",
  sourceLabel: "Gear",
};

function render(props: Parameters<typeof ExceptionsInbox>[0]): string {
  return renderToString(createElement(ExceptionsInbox, props));
}

describe("ExceptionsInbox", () => {
  it("renders the title, operational summary, tabs, rows, badges and age", () => {
    const html = render({ initialItems: ITEMS });
    expect(html).toContain("Needs attention");
    expect(html).toContain("2 open");
    // operational summary line
    expect(html).toContain("1 critical");
    expect(html).toContain("actionable");
    // view tabs
    expect(html).toContain('data-testid="exceptions-tabs"');
    for (const t of ["All", "Needs action", "Waiting", "By job", "By source"]) {
      expect(html).toContain(t);
    }
    // rows + badges + age + source label
    expect(html).toContain("Bravo: active but no field workers assigned");
    expect(html).toContain("Critical");
    expect(html).toContain("Jobs"); // source badge label
    expect(html).toContain("3h ago"); // age label
  });

  it("renders available actions as links and a fallback as a link to the parent surface", () => {
    const html = render({ initialItems: [...ITEMS, FALLBACK_ITEM] });
    expect(html).toContain('data-testid="exception-action-link"');
    expect(html).toContain('href="/v2/jobs/j2/builder"');
    expect(html).toContain('href="/hours/approvals"');
    // fallback still renders a (safe) link, flagged "(job)"
    expect(html).toContain('href="/v2/jobs/j9"');
    expect(html).toContain("(job)");
  });

  it("renders an unavailable action as a muted state, never a broken link", () => {
    const html = render({ initialItems: [UNAVAILABLE_ITEM] });
    expect(html).toContain('data-testid="exception-action-unavailable"');
    expect(html).toContain("not available yet");
    expect(html).toContain("Gear surface isn");
    expect(html).not.toContain('data-testid="exception-action-link"');
    expect(html).not.toContain("href=");
  });

  it("renders the refining filters (source, severity, job, search) when there are items", () => {
    const html = render({ initialItems: ITEMS });
    expect(html).toContain('data-testid="exceptions-filter-source"');
    expect(html).toContain("All sources");
    expect(html).toContain("Hours");
    expect(html).toContain("Jobs");
    expect(html).toContain('data-testid="exceptions-filter-severity"');
    expect(html).toContain('data-testid="exceptions-filter-job"');
    expect(html).toContain('data-testid="exceptions-search"');
  });

  it("applies and clears the source filter in rendered component state", () => {
    const filteredHtml = render({ initialItems: ITEMS, initialSource: "hours" });
    expect(filteredHtml).toContain("Rejected hours from Oskar");
    expect(filteredHtml).not.toContain("Bravo: active but no field workers assigned");

    const resetHtml = render({ initialItems: ITEMS, initialSource: "all" });
    expect(resetHtml).toContain("Rejected hours from Oskar");
    expect(resetHtml).toContain("Bravo: active but no field workers assigned");
  });

  it("renders the All clear empty state (no tabs/filters) when there are no items", () => {
    const html = render({ initialItems: [] });
    expect(html).toContain("All clear");
    expect(html).not.toContain('data-testid="exception-item"');
    expect(html).not.toContain('data-testid="exceptions-tabs"');
  });

  it("shows the partial-load notice when a source failed", () => {
    const html = render({ initialItems: ITEMS, partial: true });
    expect(html).toContain("this list may be incomplete");
  });
});
