import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ExceptionsInbox } from "./ExceptionsInbox";
import type { ExceptionItem } from "@/domains/exceptions/types";

/**
 * SSR smoke for the Exceptions Inbox (node env). The component is driven by
 * pre-projected props, so renderToString covers the list, empty state, badges,
 * filters chrome and action links. Filter *interaction* is covered by the
 * service unit tests (filterExceptions).
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
  },
  {
    id: "hours-rejected:t2",
    source: "hours",
    sourceId: "t2",
    title: "Rejected hours from Oskar (2026-06-01) need correction",
    summary: "Reason: Wrong job",
    severity: "warning",
    actionLabel: "Review approvals",
    actionHref: "/hours/approvals",
    actionState: "available",
  },
];

/** An item whose source surface isn't reachable — must NOT render a link. */
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
};

function render(props: Parameters<typeof ExceptionsInbox>[0]): string {
  return renderToString(createElement(ExceptionsInbox, props));
}

describe("ExceptionsInbox", () => {
  it("renders the inbox title, open count, items, badges and action links", () => {
    const html = render({ initialItems: ITEMS });
    expect(html).toContain("Needs attention");
    expect(html).toContain("2 open");
    expect(html).toContain("Bravo: active but no field workers assigned");
    expect(html).toContain("Rejected hours from Oskar");
    // severity badges
    expect(html).toContain("Critical");
    expect(html).toContain("Action");
    // action links use the canonical internal hrefs
    expect(html).toContain('href="/v2/jobs/j2/builder"');
    expect(html).toContain('href="/hours/approvals"');
    expect(html).toContain("Assign workers");
    // available actions render as real links
    expect(html).toContain('data-testid="exception-action-link"');
    expect(html).not.toContain('data-testid="exception-action-unavailable"');
  });

  it("renders an unavailable action as a muted state, never a broken link", () => {
    const html = render({ initialItems: [UNAVAILABLE_ITEM] });
    expect(html).toContain('data-testid="exception-action-unavailable"');
    expect(html).toContain("not available yet");
    expect(html).toContain("Gear surface isn");
    // no link + no href is emitted for the unavailable item
    expect(html).not.toContain('data-testid="exception-action-link"');
    expect(html).not.toContain("href=");
  });

  it("renders the filter controls when there are items", () => {
    const html = render({ initialItems: ITEMS });
    expect(html).toContain('data-testid="exceptions-filter-source"');
    expect(html).toContain('data-testid="exceptions-filter-severity"');
    expect(html).toContain('data-testid="exceptions-filter-job"');
  });

  it("renders the All clear empty state when there are no items", () => {
    const html = render({ initialItems: [] });
    expect(html).toContain("All clear");
    expect(html).not.toContain('data-testid="exception-item"');
    // no filter chrome on an empty inbox
    expect(html).not.toContain('data-testid="exceptions-filter-source"');
  });

  it("shows the partial-load notice when a source failed", () => {
    const html = render({ initialItems: ITEMS, partial: true });
    expect(html).toContain("this list may be incomplete");
  });
});
