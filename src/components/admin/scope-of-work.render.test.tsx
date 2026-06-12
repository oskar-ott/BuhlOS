import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ScopeOfWorkSection } from "./ScopeOfWorkSection";
import { JobScopeCard } from "./JobScopeCard";
import type { Job } from "@/domains/jobs/types";

/**
 * Render guards for scope of work (#200). The write path + visibility
 * matrix are pinned by the jobs-api harness; these pin the builder CRUD
 * surface and the read-only hub card (filled + honest empty).
 */

const job = (scope?: Job["scopeOfWork"]): Job =>
  ({ id: "j1", name: "Riverside", status: "draft", scopeOfWork: scope }) as unknown as Job;

describe("ScopeOfWorkSection (builder)", () => {
  it("renders existing items in order with the add affordance", () => {
    const html = renderToString(
      createElement(ScopeOfWorkSection, {
        job: job([
          { id: "sw_2", title: "Second", detail: "", order: 1 },
          { id: "sw_1", title: "First", detail: "Detail here", order: 0 },
        ]),
      })
    );
    expect(html).toContain("Scope of work");
    expect(html).toContain("scope-add");
    expect(html).toContain("scope-save");
    expect(html).toContain("First");
    expect(html).toContain("Detail here");
    // Order respected: First (order 0) appears before Second (order 1).
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
  });

  it("honest empty state", () => {
    const html = renderToString(createElement(ScopeOfWorkSection, { job: job([]) }));
    expect(html).toContain("No scope captured yet");
  });
});

describe("JobScopeCard (hub, read-only)", () => {
  it("renders numbered items with preserved detail", () => {
    const html = renderToString(
      createElement(JobScopeCard, {
        job: job([{ id: "sw_1", title: "Install DB-1", detail: "Line one\nLine two", order: 0 }]),
      })
    );
    expect(html).toContain("Install DB-1");
    expect(html).toContain("Line one");
    expect(html).toContain("whitespace-pre-line"); // newlines preserved
    expect(html).not.toContain("scope-add"); // no editing affordance
  });

  it("empty state is exactly the AC copy", () => {
    const html = renderToString(createElement(JobScopeCard, { job: job([]) }));
    expect(html).toContain("No scope captured.");
  });
});
