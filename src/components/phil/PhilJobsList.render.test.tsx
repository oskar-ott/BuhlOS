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

  // --- #145: recent + pinned ---

  const mk = (id: string, name: string) =>
    ({ id, name, status: "active" }) as unknown as Job;

  it("shows no pin control and no Recent group without a userId (SSR / no session)", () => {
    const html = renderToString(
      createElement(PhilJobsList, {
        initialJobs: [mk("a", "A"), mk("b", "B"), mk("c", "C"), mk("d", "D")],
      }),
    );
    expect(html).not.toContain("phil-job-pin-");
    // The automatic Recent group is post-mount + gated; never in the SSR paint.
    expect(html).not.toContain("phil-jobs-recent");
    expect(html).not.toContain(">Recent<");
  });

  it("renders a glove-sized pin control per row once a userId is present", () => {
    const html = renderToString(
      createElement(PhilJobsList, {
        initialJobs: [mk("a", "Alpha")],
        userId: "user-1",
      }),
    );
    expect(html).toContain('data-testid="phil-job-pin-a"');
    // ≥44px tap target (P8 — gloved thumb)
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("min-w-[44px]");
    // honest default: nothing claims it's pinned without stored prefs
    expect(html).toContain('aria-label="Pin Alpha"');
  });

  it("single-job worker: list unchanged, no Recent group (P10 — zero clutter)", () => {
    const html = renderToString(
      createElement(PhilJobsList, {
        initialJobs: [mk("only", "Only job")],
        userId: "user-1",
      }),
    );
    expect(html).toContain("Only job");
    // no automatic Recent section for a worker with a single job
    expect(html).not.toContain("phil-jobs-recent");
    expect(html).not.toContain(">Recent<");
  });

  it("renders the full name-first list (the SSR paint) for a many-job worker", () => {
    const html = renderToString(
      createElement(PhilJobsList, {
        initialJobs: [mk("a", "Zebra"), mk("b", "Apple"), mk("c", "Mango"), mk("d", "Kiwi")],
        userId: "user-1",
      }),
    );
    // every assigned job appears in the full list
    expect(html).toContain('data-testid="phil-jobs-all"');
    expect(html).toContain("Zebra");
    expect(html).toContain("Apple");
    expect(html).toContain("Mango");
    expect(html).toContain("Kiwi");
  });
});
