import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobsList } from "./PhilJobsList";
import type { Job } from "@/domains/jobs/types";

const job = {
  id: "job-1",
  name: "Birdwood Rd — Rough-in",
  status: "active",
  siteAddress: "12 Birdwood Rd, Sydney",
  ref: "BW-001",
} as unknown as Job;

/**
 * SSR smoke for the jobs list: the honest empty state, and a job row whose
 * whole row is the tap target (a link to the job) carrying the name + address.
 */
describe("PhilJobsList", () => {
  it("renders an honest empty state when there are no jobs", () => {
    const html = renderToString(createElement(PhilJobsList, { initialJobs: [] }));
    expect(html).toContain("No jobs assigned yet");
  });

  it("renders a job row linking to the job with name and address", () => {
    const html = renderToString(createElement(PhilJobsList, { initialJobs: [job] }));
    expect(html).toContain("Birdwood Rd — Rough-in");
    expect(html).toContain("12 Birdwood Rd, Sydney");
    expect(html).toContain("/phil/jobs/job-1");
  });

  it("shows real 'open work' chips when the job carries stats", () => {
    const withStats = {
      ...job,
      statsSnagsV2Active: 3,
      statsItpsActive: 2,
    } as unknown as Job;
    const html = renderToString(
      createElement(PhilJobsList, { initialJobs: [withStats] }),
    );
    expect(html).toContain("3 snags");
    expect(html).toContain("2 ITPs");
    // also folded into the row's accessible name (announced once, not twice)
    expect(html).toContain("3 snags, 2 ITPs");
  });

  it("renders no 'open work' chips when stats are absent (graceful, no fake)", () => {
    const html = renderToString(createElement(PhilJobsList, { initialJobs: [job] }));
    // the row is otherwise unchanged
    expect(html).toContain("Birdwood Rd — Rough-in");
    // and never fabricates a count or an "all clear"
    expect(html).not.toContain("snag");
    expect(html).not.toContain("ITP");
  });
});
