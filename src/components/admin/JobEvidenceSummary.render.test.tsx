import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobEvidenceSummary } from "./JobEvidenceSummary";
import type { EvidenceItem } from "@/domains/evidence/types";

function ev(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "ev-1",
    jobId: "job-1",
    kind: "photo",
    photoId: "p1",
    photoUrl: "https://blob/p1.jpg",
    status: "submitted",
    source: "phil",
    capturedById: "u1",
    capturedByName: "Jack",
    capturedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    taskId: "t1",
    stage: "roughIn",
    auditLogIds: [],
    createdAt: "2026-06-01T09:00:00Z",
    updatedAt: "2026-06-01T09:00:00Z",
    ...over,
  } as unknown as EvidenceItem;
}

function render(props: {
  evidence: EvidenceItem[];
  jobId: string;
  fetchError: string | null;
}): string {
  return renderToString(createElement(JobEvidenceSummary, props));
}

describe("JobEvidenceSummary", () => {
  it("shows an honest empty state and deep-links to the evidence tab", () => {
    const html = render({ evidence: [], jobId: "job-1", fetchError: null });
    expect(html).toContain("No evidence captured for this job yet");
    expect(html).toContain("/v2/jobs/job-1/evidence");
    expect(html).toContain("Open evidence");
  });

  it("breaks captures down by status with the latest-capture caption", () => {
    // Explicit timestamps so "latest" is deterministic (Sam, 3 Jun).
    const html = render({
      evidence: [
        ev({ id: "a", status: "submitted", capturedByName: "Jack", capturedAt: "2026-06-01T09:00:00Z" }),
        ev({ id: "b", status: "reviewed", capturedById: "u2", capturedByName: "Sam", capturedAt: "2026-06-03T11:30:00Z" }),
        ev({ id: "c", status: "rejected", rejectionReason: "blurry", capturedByName: "Jack", capturedAt: "2026-06-02T08:00:00Z" }),
      ],
      jobId: "job-1",
      fetchError: null,
    });
    expect(html).toContain("to review");
    expect(html).toContain("reviewed");
    expect(html).toContain("rejected");
    expect(html).toContain("3 captures");
    expect(html).toContain("2 workers");
    expect(html).toContain("Sam"); // newest capture's author
  });

  it("flags captures missing context", () => {
    const html = render({
      evidence: [ev({ id: "a", taskId: null, areaId: null, stage: null })],
      jobId: "job-1",
      fetchError: null,
    });
    expect(html).toContain("not linked to a task or area");
  });

  it("does not fabricate evidence on a fetch error", () => {
    const html = render({ evidence: [], jobId: "job-1", fetchError: "API returned 502" });
    expect(html).toContain("load evidence for this job");
    expect(html).toContain("API returned 502");
    // No status breakdown / counts when the fetch failed.
    expect(html).not.toContain("to review");
    expect(html).not.toContain("worker");
  });
});
