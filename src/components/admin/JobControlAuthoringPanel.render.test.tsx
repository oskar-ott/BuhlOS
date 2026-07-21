import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { JobControlAuthoringPanel } from "./JobControlAuthoringPanel";
import type { Job } from "@/domains/jobs/types";

const JOB = {
  id: "job_1",
  name: "Test Job",
  status: "active",
  scopeOfWork: [
    { id: "sw_zip", title: "Dedicated 20A ZIP circuit, East Gym", detail: "Priced field work", order: 0 },
  ],
  areaGroups: [
    {
      id: "ag_1",
      name: "Level 3",
      areas: [
        {
          id: "ar_east_gym",
          name: "East Gym",
          fitOffTasks: [{ id: "ft_zip", name: "ZIP tap — dedicated 20A circuit" }],
        },
      ],
    },
  ],
  roughInTasks: [],
  fitOffTasks: [],
} as unknown as Job;

function render(job: Job): string {
  return renderToString(createElement(JobControlAuthoringPanel, { job })).replace(/<!-- -->/g, "");
}

describe("JobControlAuthoringPanel", () => {
  it("renders the scope clause, the step labels, and the plain flow line", () => {
    const html = render(JOB);
    expect(html).toContain("Dedicated 20A ZIP circuit, East Gym");
    expect(html).toContain("Priced field work"); // classification label, not raw enum
    expect(html).toContain("1. Scope clause");
    expect(html).toContain("2. Worker task");
    expect(html).toContain("3. Required proof");
    expect(html).toContain("4. Compile for the field");
    expect(html).toContain("Scope clause → worker task → required proof → compile for the field");
  });

  it("renders the area / stage / task selectors from real job structure", () => {
    const html = render(JOB);
    expect(html).toContain("East Gym"); // area option
    expect(html).toContain("Rough-in"); // stage option
    expect(html).toContain("Fit-off");
    // the task option only becomes available once area+stage are chosen, so the
    // placeholder is shown initially (no interaction in SSR)
    expect(html).toContain("Pick area + stage first");
  });

  it("renders the required-proof inputs with plain kind labels", () => {
    const html = render(JOB);
    expect(html).toContain("Proof label");
    expect(html).toContain("Photo"); // kind option
    expect(html).toContain("Test result");
    expect(html).toContain("As-built");
    expect(html).toContain("Certificate");
    expect(html).toContain("Note (optional)");
  });

  it("disables Save with no selection (the no-task-selected guard, SSR view)", () => {
    const html = render(JOB);
    const save = html.match(/<button[^>]*>\s*Save required proof\s*<\/button>/);
    expect(save).not.toBeNull();
    expect(save![0]).toContain("disabled");
  });

  it("does NOT leak a raw clause/area/task id as a primary label", () => {
    const html = render(JOB);
    // ids only live inside the Developer details foldout, not as visible labels
    expect(html).toContain("Developer details");
    // the clause radio shows the title, not the sw_ id, as its label text
    expect(html).not.toMatch(/>\s*sw_zip\s*</);
  });

  it("shows an honest empty state when the job has no scope clauses", () => {
    const empty = { ...JOB, scopeOfWork: [] } as unknown as Job;
    const html = render(empty);
    expect(html).toContain("No scope clauses yet");
    expect(html).not.toContain("1. Scope clause");
  });
});
