import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobsSharpened } from "./PhilJobsSharpened";
import type { Job } from "@/domains/jobs/types";

/**
 * SSR smoke for the SHARPENED Jobs screen (phil_sharpened, dark — Wave 2a).
 * The flag-off screen (PhilJobsList) keeps its own tests untouched; here we
 * pin the sharpened projection's honesty contract AND that the #145/#146
 * behaviour contract (testids, pin control, name-first SSR paint) carried
 * over into the restyle.
 */

const mk = (id: string, name: string, extra: Partial<Job> = {}) =>
  ({ id, name, status: "active", ...extra }) as unknown as Job;

describe("PhilJobsSharpened", () => {
  it("renders an honest empty state when there are no jobs", () => {
    const html = renderToString(createElement(PhilJobsSharpened, { initialJobs: [] }));
    expect(html).toContain("No jobs assigned yet");
    expect(html).not.toContain("phil-jobs-on-today");
  });

  it("omits '+ New job' entirely this wave — no dead button (P7)", () => {
    const html = renderToString(
      createElement(PhilJobsSharpened, { initialJobs: [mk("a", "Alpha")] }),
    );
    expect(html).not.toContain("New job");
  });

  it("shows the On-today hero only for the exactly-one-assigned signal", () => {
    const one = renderToString(
      createElement(PhilJobsSharpened, {
        initialJobs: [
          mk("a", "Birdwood Estate", {
            ref: "IV0041",
            siteAddress: "12 Birdwood Rd",
          } as Partial<Job>),
        ],
      }),
    );
    expect(one).toContain('data-testid="phil-jobs-on-today"');
    expect(one).toContain("On today");
    expect(one).toContain("IV0041");
    expect(one).toContain("12 Birdwood Rd");
    expect(one).toContain("border-l-accent-yellow");
    // Real job status, badge language — never an invented task state.
    expect(one).toContain(">Active<");

    const many = renderToString(
      createElement(PhilJobsSharpened, {
        initialJobs: [mk("a", "Alpha"), mk("b", "Beta")],
      }),
    );
    // With 2+ jobs there is no active-job signal — the hero is honestly absent.
    expect(many).not.toContain("phil-jobs-on-today");
    expect(many).not.toContain("On today");
  });

  it("renders the counted register with the preserved phil-jobs-all testid", () => {
    const html = renderToString(
      createElement(PhilJobsSharpened, {
        initialJobs: [mk("a", "Zebra"), mk("b", "Apple"), mk("c", "Mango")],
      }),
    );
    expect(html).toContain("Your jobs · 3");
    expect(html).toContain('data-testid="phil-jobs-all"');
    expect(html).toContain("Zebra");
    expect(html).toContain("Apple");
    expect(html).toContain("Mango");
  });

  it("keeps rows honest: real withStats signals when present, nothing when absent", () => {
    const withStats = renderToString(
      createElement(PhilJobsSharpened, {
        initialJobs: [
          mk("a", "Alpha", { statsSnagsV2Active: 2, statsItpsActive: 1 } as Partial<Job>),
          mk("b", "Beta"),
        ],
      }),
    );
    expect(withStats).toContain("2 snags");
    expect(withStats).toContain("1 ITP");

    const noStats = renderToString(
      createElement(PhilJobsSharpened, { initialJobs: [mk("a", "Alpha"), mk("b", "Beta")] }),
    );
    expect(noStats).not.toContain("snag");
    expect(noStats).not.toContain("ITP");
  });

  it("shows the real job-status badge (On hold → warning wording, not a task state)", () => {
    const html = renderToString(
      createElement(PhilJobsSharpened, {
        initialJobs: [mk("a", "Alpha", { status: "on_hold" } as Partial<Job>), mk("b", "Beta")],
      }),
    );
    expect(html).toContain(">On hold<");
  });

  it("keeps the #145 pin contract: glove-sized control + testid once a userId exists", () => {
    const html = renderToString(
      createElement(PhilJobsSharpened, {
        initialJobs: [mk("a", "Alpha"), mk("b", "Beta")],
        userId: "user-1",
      }),
    );
    expect(html).toContain('data-testid="phil-job-pin-a"');
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("min-w-[44px]");
    expect(html).toContain('aria-label="Pin Alpha"');
  });

  it("SSR paint is the stable name-first list — no Recent group, no pins without a user", () => {
    const html = renderToString(
      createElement(PhilJobsSharpened, {
        initialJobs: [mk("a", "A"), mk("b", "B"), mk("c", "C"), mk("d", "D")],
      }),
    );
    // The Recent group is post-mount + prefs-gated, exactly like PhilJobsList.
    expect(html).not.toContain("phil-jobs-recent");
    expect(html).not.toContain(">Recent<");
    expect(html).not.toContain("phil-job-pin-");
  });
});
