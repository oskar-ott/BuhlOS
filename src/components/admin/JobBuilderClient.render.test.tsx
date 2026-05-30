import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobBuilderClient } from "./JobBuilderClient";
import type { Job } from "@/domains/jobs/types";

// JobBuilderClient calls useRouter (refresh after save/publish). Stub it so the
// SSR smoke doesn't need a mounted app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

/**
 * Server-render smoke for the Job Builder / Editor workspace. Mirrors the
 * project's renderToString approach (ObservationsInbox.render.test.tsx) — node
 * env, no browser. Catches SSR crashes, broken composition and missing copy.
 *
 * Only the default (Basics) tab renders here — renderToString can't click a
 * tab — so the per-tab content (structure / preview / publish) is exercised by
 * the pure-logic tests in src/domains/jobs/builder.test.ts, which is where the
 * real risk (payload shaping + publish rules + preview derivation) lives.
 */

function makeJob(over: Partial<Job> & { id: string; name: string }): Job {
  return { ...over } as Job;
}

describe("JobBuilderClient", () => {
  it("renders the workspace shell, tabs, and basics fields for a draft", () => {
    const html = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Birdwood Tower", status: "draft" }),
      })
    );

    // Header carries the job name.
    expect(html).toContain("Birdwood Tower");
    // Every tab is reachable.
    expect(html).toContain("Basics");
    expect(html).toContain("Structure");
    expect(html).toContain("Field modules");
    expect(html).toContain("Phil preview");
    expect(html).toContain("Publish");
    expect(html).toContain("More");
    // Basics (default tab) shows its fields.
    expect(html).toContain("Job name");
    expect(html).toContain("Site address");
    expect(html).toContain("Access notes");
    expect(html).toContain("Site induction required before the crew attends");
  });

  it("shows the office-only visibility state for a draft", () => {
    const html = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Draft Job", status: "draft" }),
      })
    );
    expect(html).toContain("Office-only (not yet published)");
    // A pristine load is not dirty — nothing to save.
    expect(html).toContain("All changes saved");
  });

  it("shows the field-visible state for a published (active) job", () => {
    const html = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Live Job", status: "active" }),
      })
    );
    expect(html).toContain("Visible to the field");
  });
});
