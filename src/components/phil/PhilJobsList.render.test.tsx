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
});
