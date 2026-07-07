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

  it("shows the navy '+ New job' header button (Wave 2b) with the sheet closed", () => {
    const html = renderToString(
      createElement(PhilJobsSharpened, { initialJobs: [mk("a", "Alpha")] }),
    );
    expect(html).toContain('data-testid="phil-new-job-open"');
    expect(html).toContain("New job");
    expect(html).toContain("bg-brand-navy");
    // The create form itself is in-page client state — never SSR'd open.
    expect(html).not.toContain('data-testid="phil-new-job-sheet"');
  });

  it("keeps '+ New job' available on the honest empty state (first job is a create)", () => {
    const html = renderToString(createElement(PhilJobsSharpened, { initialJobs: [] }));
    expect(html).toContain('data-testid="phil-new-job-open"');
    expect(html).toContain("No jobs assigned yet");
  });

  it("chips the real `code` field, falling back to legacy `ref` (unchanged rows)", () => {
    const html = renderToString(
      createElement(PhilJobsSharpened, {
        initialJobs: [
          mk("a", "Coded", { code: "IV7001", ref: "OLD-REF" } as Partial<Job>),
          mk("b", "Ref only", { ref: "IV0038" } as Partial<Job>),
          mk("c", "Bare"),
        ],
      }),
    );
    expect(html).toContain("IV7001"); // code wins over ref
    expect(html).not.toContain("OLD-REF");
    expect(html).toContain("IV0038"); // no code → today's ref rendering
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

  it("a lone NON-ACTIVE job is never framed 'On today' — it lists plainly with its truthful badge", () => {
    for (const [status, badge] of [
      ["complete", ">Complete<"],
      ["on_hold", ">On hold<"],
    ] as const) {
      const html = renderToString(
        createElement(PhilJobsSharpened, {
          initialJobs: [mk("a", "Wrapped Up Estate", { status } as Partial<Job>)],
        }),
      );
      // No hero, no yellow active rule — the job isn't on today (P7).
      expect(html, status).not.toContain("phil-jobs-on-today");
      expect(html, status).not.toContain("On today");
      expect(html, status).not.toContain("border-l-accent-yellow");
      // It still renders exactly once, in the register, honestly badged
      // (one row link — its aria-label — not a hero AND a row).
      expect(html, status).toContain("Your jobs · 1");
      expect(html, status).toContain('data-testid="phil-jobs-all"');
      expect(html.match(/Open Wrapped Up Estate/g), status).toHaveLength(1);
      expect(html, status).toContain(badge);
    }
  });

  it("the hero job never repeats in the register — one job renders ONCE (hero only, no 'Your jobs · 1')", () => {
    const html = renderToString(
      createElement(PhilJobsSharpened, {
        initialJobs: [mk("a", "Birdwood Estate")],
        userId: "u1",
      }),
    );
    expect(html).toContain('data-testid="phil-jobs-on-today"');
    // Exactly one rendered entry for the job.
    expect(html.match(/Birdwood Estate/g)).toHaveLength(1);
    // The register (the OTHERS) is empty → the whole section drops.
    expect(html).not.toContain("Your jobs");
    expect(html).not.toContain('data-testid="phil-jobs-all"');
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
