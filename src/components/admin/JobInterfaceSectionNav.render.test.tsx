import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobInterfaceSectionNav } from "./JobInterfaceSectionNav";
import type { Job } from "@/domains/jobs/types";

/**
 * The 2026-07-27 gut (docs/product/02-lean-reset.md) cut the job-hub section
 * nav to the two sections the lean core still owns: Evidence and Photos. This
 * pins that list so a deleted feature's row can't reappear and so the hub never
 * links at a route that no longer exists. Props-only SSR render (no router).
 */

const job = { id: "j1", name: "Riverside" } as unknown as Job;

function render(extra: Partial<Job> = {}): string {
  return renderToString(
    createElement(JobInterfaceSectionNav, { job: { ...job, ...extra } as Job }),
  );
}

describe("<JobInterfaceSectionNav />", () => {
  it("renders exactly the two surviving sections", () => {
    const html = render();
    expect(html).toContain("Evidence");
    expect(html).toContain("Photos");
    expect(html).toContain("/v2/jobs/j1/evidence");
    expect(html).toContain("/v2/jobs/j1/photos");
  });

  it("shows no row for a gutted feature", () => {
    const html = render();
    for (const gone of [
      "Snags",
      "Observations",
      "ITP / QA",
      "Scope reconciliation",
      "Job control",
      "Closeout",
      "Documents",
      "Circuit schedules",
      "Material requests",
      "Diary",
      "Activity",
      "Safety",
      "Certificates",
      "RFIs",
      "Variations",
      "Minutes",
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  it("shows the evidence count only when the job carries one (never a fake zero)", () => {
    expect(render({ statsEvidenceV2Pending: 4 } as Partial<Job>)).toContain(">4<");
    // No stat loaded -> the chip is omitted entirely.
    const bare = render();
    expect(bare).toContain("Evidence");
    expect(bare).not.toContain(">0<");
  });
});
