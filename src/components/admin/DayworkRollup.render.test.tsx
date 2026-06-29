import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DayworkRollup } from "./DayworkRollup";
import type { DayworkRegisterSummary } from "@/domains/dayworks/service";
import type { DayworkRollupJobRow } from "@/server/dayworks/register";

function render(byJob: DayworkRollupJobRow[], summary: DayworkRegisterSummary): string {
  return renderToString(createElement(DayworkRollup, { byJob, summary })).replace(/<!-- -->/g, "");
}

const SUMMARY: DayworkRegisterSummary = {
  total: 4,
  unsigned: 2,
  signed: 1,
  invoiced: 1,
  unsignedAging: 1,
};

describe("DayworkRollup", () => {
  it("renders a per-job row that links into the job's register", () => {
    const byJob: DayworkRollupJobRow[] = [
      { jobId: "job-2", jobName: "Other site", total: 3, unsigned: 2, signed: 1, invoiced: 0, unsignedAging: 1 },
      { jobId: "job-1", jobName: "Birdwood", total: 1, unsigned: 0, signed: 0, invoiced: 1, unsignedAging: 0 },
    ];
    const html = render(byJob, SUMMARY);
    expect(html).toContain("Other site");
    expect(html).toContain("Birdwood");
    expect(html).toContain("/v2/jobs/job-2/dayworks");
    expect(html).toContain("/v2/jobs/job-1/dayworks");
    expect(html).toContain("payment risk"); // job-2 has an aging docket
  });

  it("shows an honest empty state when no job has dockets", () => {
    const html = render([], { total: 0, unsigned: 0, signed: 0, invoiced: 0, unsignedAging: 0 });
    expect(html).toContain("No daywork dockets across any job yet");
  });

  it("falls back to the job id when a job has no name", () => {
    const byJob: DayworkRollupJobRow[] = [
      { jobId: "job-x", jobName: null, total: 1, unsigned: 1, signed: 0, invoiced: 0, unsignedAging: 0 },
    ];
    const html = render(byJob, SUMMARY);
    expect(html).toContain("job-x");
  });

  it("renders the shared inbox stat strip over the rollup's OWN real data (§6)", () => {
    // SUMMARY: unsigned 2 · signed 1 · unsignedAging 1. byJob below has one job
    // with an aging docket → Jobs at risk = 1.
    const byJob: DayworkRollupJobRow[] = [
      { jobId: "job-2", jobName: "Other site", total: 3, unsigned: 2, signed: 1, invoiced: 0, unsignedAging: 1 },
      { jobId: "job-1", jobName: "Birdwood", total: 1, unsigned: 0, signed: 0, invoiced: 1, unsignedAging: 0 },
    ];
    const html = render(byJob, SUMMARY);
    expect(html).toContain("Unsigned");
    expect(html).toContain("Aging &gt; 24h");
    expect(html).toContain("Jobs at risk");
    expect(html).toContain("Signed");
  });

  it("a calm empty rollup shows muted zeros, never a fabricated number (§6)", () => {
    const html = render([], { total: 0, unsigned: 0, signed: 0, invoiced: 0, unsignedAging: 0 });
    // Every stat is a real 0 → the shell renders the value muted, not coloured.
    expect(html).toContain("tabular-nums text-text-muted");
  });
});
