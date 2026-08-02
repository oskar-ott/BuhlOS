import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobOverviewSummary } from "./JobOverviewSummary";
import type { Job } from "@/domains/jobs/types";

// Plain server component (no hooks / next-navigation), so renderToString needs
// no mocks. Asserts the hub Overview surfaces the real stats it already loads.
function job(over: Partial<Job> = {}): Job {
  return { id: "job-1", name: "Birdwood IV3232", ...over } as unknown as Job;
}

function render(j: Job): string {
  return renderToString(createElement(JobOverviewSummary, { job: j }));
}

describe("JobOverviewSummary", () => {
  it("shows job health from real stats (progress %, crew, updated)", () => {
    const html = render(
      job({
        statsPct: 62.4,
        statsCrewCount: 3,
        updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
    );
    expect(html).toContain("62%"); // rounded, real statsPct
    expect(html).toContain("Complete");
    expect(html).toContain("3");
    expect(html).toContain("Field crew");
    expect(html).toContain("Updated"); // lastActivityCaption
  });

  it("omits health stats that are genuinely absent (no fabricated zeros)", () => {
    const html = render(job()); // no stats at all
    expect(html).not.toContain("Complete");
    expect(html).not.toContain("Field crew");
  });

  it("renders a Needs-attention chip per real issue, deep-linking to its tab", () => {
    const html = render(
      job({ id: "job/1", statsEvidenceV2Pending: 2 }),
    );
    expect(html).toContain("Needs attention");
    expect(html).toContain("Evidence to review");
    // Deep-links to the per-job tab with an encoded id; no snags chip (count 0).
    expect(html).toContain("/v2/jobs/job%2F1/evidence");
    expect(html).not.toContain("Open snags");
    expect(html).not.toContain("All clear");
  });

  it("shows an honest All-clear when nothing needs office action", () => {
    const html = render(
      job({ statsEvidenceV2Pending: 0, statsSnagsV2Active: 0 }),
    );
    expect(html).toContain("All clear");
    expect(html).not.toContain("Evidence to review");
  });
});

describe("canonical progress (#198)", () => {
  it("renders counts-first progress when the stats fields are present", () => {
    const html = renderToString(
      createElement(JobOverviewSummary, {
        job: job({ statsTasksTotal: 30, statsTasksComplete: 12, statsPct: 40 }),
      })
    );
    expect(html).toContain("12/30 done");
    expect(html).toContain("40%");
  });

  it("renders the honest empty state for a zero-task job, never 0%", () => {
    const html = renderToString(
      createElement(JobOverviewSummary, {
        job: job({ statsTasksTotal: 0, statsTasksComplete: 0, statsPct: null }),
      })
    );
    expect(html).toContain("No tasks yet");
    expect(html).not.toContain("0%");
  });
});
