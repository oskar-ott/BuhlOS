import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobRecentActivity } from "./JobRecentActivity";
import type { AuditLogEntry } from "@/domains/audit-log/types";

function act(over: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: "a1",
    ts: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    action: "evidence.captured",
    actorId: "u1",
    actorName: "Jack",
    actorRole: "tradie",
    jobId: "job-1",
    targetType: "evidence",
    targetId: "ev1",
    summary: "Captured a photo at the meter board",
    ...over,
  } as unknown as AuditLogEntry;
}

function render(props: {
  entries: AuditLogEntry[];
  jobId: string;
  fetchError: string | null;
}): string {
  return renderToString(createElement(JobRecentActivity, props));
}

describe("JobRecentActivity", () => {
  it("shows an honest empty state and deep-links to the history feed", () => {
    const html = render({ entries: [], jobId: "job-1", fetchError: null });
    expect(html).toContain("No recent activity yet");
    expect(html).toContain("/v2/jobs/job-1/history");
    expect(html).toContain("View all activity");
  });

  it("renders real audit-log events with actor + human action label", () => {
    const html = render({
      entries: [
        act({ id: "a", action: "evidence.captured", actorName: "Jack", summary: "Photo at the board" }),
        act({ id: "b", action: "snag.created", targetType: "snag", actorName: "Sam", summary: "Cracked conduit" }),
      ],
      jobId: "job-1",
      fetchError: null,
    });
    expect(html).toContain("Captured evidence"); // actionLabel(evidence.captured)
    expect(html).toContain("Raised snag"); // actionLabel(snag.created)
    expect(html).toContain("Jack");
    expect(html).toContain("Sam");
    expect(html).toContain("Photo at the board");
  });

  it("limits to five and shows a '+N more' hint", () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      act({ id: `e${i}`, ts: `2026-06-0${i + 1}T08:00:00Z`, summary: `event ${i}` }),
    );
    const html = render({ entries, jobId: "job-1", fetchError: null });
    expect(html).toContain("View all activity (+2 more)");
  });

  it("does not fabricate activity on a fetch error", () => {
    const html = render({ entries: [], jobId: "job-1", fetchError: "API returned 500" });
    expect(html).toContain("load activity for this job");
    expect(html).toContain("API returned 500");
  });
});
