import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobFieldViewCard } from "./JobFieldViewCard";
import type { Job } from "@/domains/jobs/types";

// Plain server component — renderToString needs no mocks. Asserts the hub
// "What the field sees" card reuses saved job structure + statsCrewCount
// honestly and does not pretend to know worker activity.
function job(over: Partial<Job> = {}): Job {
  return { id: "job-1", name: "Birdwood IV3232", status: "active", ...over } as unknown as Job;
}

const STRUCTURED: Partial<Job> = {
  roughInTasks: [{ id: "t1", name: "Rough in GPOs" }],
  areaGroups: [{ id: "g1", name: "Ground", areas: [{ id: "a1", name: "Kitchen" }] }],
} as Partial<Job>;

function render(j: Job): string {
  // Strip React's SSR comment markers (inserted between adjacent text /
  // expression nodes, e.g. "Rough-in<!-- --> · <!-- -->1<!-- --> task") so
  // substring assertions match the visible text, not the render plumbing.
  return renderToString(createElement(JobFieldViewCard, { job: j })).replace(/<!-- -->/g, "");
}

describe("JobFieldViewCard (What the field sees)", () => {
  it("shows the published + assigned-crew connection and current Phil screen sections", () => {
    const html = render(
      job({
        ...STRUCTURED,
        statsCrewCount: 3,
        modules: { photos: true, snags: true, itps: true, plans: true },
        siteAddress: "12 Birdwood Rd",
      } as Partial<Job>),
    );
    expect(html).toContain("What the field sees");
    expect(html).toContain("Visible in Phil to 3 assigned field workers");
    expect(html).toContain("Current Phil job-screen structure");
    expect(html).toContain("not worker activity telemetry");
    // Worker-visible stage derived from real job-level tasks.
    expect(html).toContain("Rough-in · 1 task");
    // Current Phil screen shape, not the old generic "Worker can" tool list.
    expect(html).toContain("Phil screen includes");
    expect(html).toContain("Quick actions");
    expect(html).toContain("Work to do");
    expect(html).toContain("Capture evidence");
    expect(html).toContain("Issues / snags");
    expect(html).toContain("Checks / ITPs");
    expect(html).toContain("Plans &amp; documents");
    expect(html).toContain("Site details");
    expect(html).toContain("Materials and job history are still shown in Phil as not connected yet");
  });

  it("honestly flags a published job with NO workers assigned (broken loop)", () => {
    const html = render(job({ ...STRUCTURED, statsCrewCount: 0 }));
    expect(html).toContain("no field workers are assigned");
    expect(html).not.toContain("Visible in Phil to");
    expect(html).toContain("Stages configured for Phil");
    expect(html).toContain("If assigned and published, Phil would include");
    expect(html).not.toContain("Stages the worker sees");
    expect(html).not.toContain("Phil screen includes");
  });

  it("honestly flags a draft job as office-only (worker can't see it)", () => {
    const html = render(job({ ...STRUCTURED, status: "draft", statsCrewCount: 3 }));
    expect(html).toContain("Office-only — not published");
    expect(html).not.toContain("Visible in Phil to");
    expect(html).toContain("Stages configured for Phil");
    expect(html).toContain("If assigned and published, Phil would include");
    expect(html).not.toContain("Stages the worker sees");
    expect(html).not.toContain("Phil screen includes");
  });

  it("shows an honest empty reason when there is no work structure yet", () => {
    const html = render(job({ statsCrewCount: 2 })); // no areas, no tasks
    expect(html).toContain("No areas or tasks yet");
    expect(html).not.toContain("Stages the worker sees");
  });

  it("does not fake worker activity, evidence, tasks, checks, hours, or payroll state", () => {
    const html = render(job({ ...STRUCTURED, statsCrewCount: 1 })).toLowerCase();
    expect(html).toContain("not represented here");
    expect(html).toContain("whether a worker has viewed the job");
    expect(html).toContain("completed tasks");
    expect(html).toContain("captured evidence");
    expect(html).toContain("fixed hours");
    expect(html).toContain("finished checks");
    for (const banned of ["payroll", "xero", "realtime", "synced", "ready for payroll"]) {
      expect(html).not.toContain(banned);
    }
  });
});
