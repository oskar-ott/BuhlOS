import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobActivityFeed } from "./JobActivityFeed";
import type { AuditLogEntry } from "@/domains/audit-log/types";

// RefreshButton (rendered in the error path) calls useRouter; stub it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

function ent(over: Partial<AuditLogEntry> & { id: string }): AuditLogEntry {
  return {
    ts: "2026-05-28T10:00:00.000Z",
    action: "evidence.captured",
    actorId: "u_field",
    actorName: "Sparky",
    actorRole: "electrician",
    jobId: "job-1",
    targetType: "evidence",
    targetId: "ev_1",
    summary: "captured rough-in",
    metadata: {},
    ...over,
  } as AuditLogEntry;
}

describe("JobActivityFeed", () => {
  it("renders the empty state when there are no entries", () => {
    const html = renderToString(
      createElement(JobActivityFeed, {
        initialEntries: [],
        fetchError: null,
        jobName: "Birdwood IV",
      })
    );
    expect(html).toContain("Activity on");
    expect(html).toContain("Birdwood IV");
    expect(html).toContain("Nothing has happened on this job yet");
    // The "All" filter chip is always rendered with the running count.
    expect(html).toContain("All");
  });

  it("renders rows with action labels, actor and summary", () => {
    const html = renderToString(
      createElement(JobActivityFeed, {
        initialEntries: [
          ent({ id: "a1" }),
          ent({
            id: "a2",
            action: "snag.created",
            targetType: "snag",
            targetId: "sn_1",
            summary: "raised damaged fitting",
          }),
          ent({
            id: "a3",
            action: "observation.converted_to_snag",
            targetType: "observation",
            targetId: "ob_1",
            actorName: "Boss",
            actorRole: "boss",
            summary: "converted plan mismatch",
          }),
        ],
        fetchError: null,
        jobName: "Birdwood IV",
      })
    );
    // Plain-English action labels.
    expect(html).toContain("Captured evidence");
    expect(html).toContain("Raised snag");
    expect(html).toContain("Converted observation to snag");
    // Actor + summary text.
    expect(html).toContain("Sparky");
    expect(html).toContain("Boss");
    expect(html).toContain("captured rough-in");
    expect(html).toContain("converted plan mismatch");
    // Filter chips for present groups.
    expect(html).toContain("Evidence");
    expect(html).toContain("Snags");
    expect(html).toContain("Observations");
  });

  it("renders the fetch-error banner", () => {
    const html = renderToString(
      createElement(JobActivityFeed, {
        initialEntries: [],
        fetchError: "API returned 503",
        jobName: "Birdwood IV",
      })
    );
    expect(html).toContain("Couldn");
    expect(html).toContain("API returned 503");
  });
});
