import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobFieldViewCard } from "./JobFieldViewCard";
import type { Job } from "@/domains/jobs/types";

// Plain server component — renderToString needs no mocks. Asserts the hub
// "What the field sees" card reuses buildPhilPreview + statsCrewCount honestly.
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
  it("shows the published + assigned-crew connection and the real worker structure", () => {
    const html = render(job({ ...STRUCTURED, statsCrewCount: 3 }));
    expect(html).toContain("What the field sees");
    expect(html).toContain("Visible in Phil to 3 assigned field workers");
    // Worker-visible stage derived from real job-level tasks.
    expect(html).toContain("Rough-in · 1 task");
    // Enabled field tools (module defaults).
    expect(html).toContain("Worker can");
    expect(html).toContain("Capture photos / evidence");
  });

  it("honestly flags a published job with NO workers assigned (broken loop)", () => {
    const html = render(job({ ...STRUCTURED, statsCrewCount: 0 }));
    expect(html).toContain("no field workers are assigned");
    expect(html).not.toContain("Visible in Phil to");
  });

  it("honestly flags a draft job as office-only (worker can't see it)", () => {
    const html = render(job({ ...STRUCTURED, status: "draft", statsCrewCount: 3 }));
    expect(html).toContain("Office-only — not published");
    expect(html).not.toContain("Visible in Phil to");
  });

  it("shows an honest empty reason when there is no work structure yet", () => {
    const html = render(job({ statsCrewCount: 2 })); // no areas, no tasks
    expect(html).toContain("No areas or tasks yet");
    expect(html).not.toContain("Stages the worker sees");
  });
});
