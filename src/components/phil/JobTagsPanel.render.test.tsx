import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobTagsPanel } from "./JobTagsPanel";
import type { TagItem } from "@/domains/tags/schema";

/**
 * Field-language + honesty guard for the job-page Test & tag section (#388):
 * plain heading, honest empty state, real counts only, and the register link
 * the command panel's #phil-job-tags anchor relies on.
 */

function ddmm(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

const tag = (id: string, expiryDate?: string): TagItem =>
  ({ id, applianceType: `Item ${id}`, expiryDate }) as TagItem;

describe("JobTagsPanel", () => {
  it("leads with plain field language and links to the register", () => {
    const html = renderToString(
      createElement(JobTagsPanel, { jobId: "j1", initialTags: [] }),
    );
    expect(html).toContain("Test &amp; tag");
    expect(html).toContain("/phil/jobs/j1/tags");
    expect(html).toContain("Open the register");
  });

  it("shows an honest empty state — no fabricated counts", () => {
    const html = renderToString(
      createElement(JobTagsPanel, { jobId: "j1", initialTags: [] }),
    );
    expect(html).toContain("No tags recorded on this job yet");
    expect(html).not.toContain("expired");
  });

  it("flags expired entries loudest, then due-soon", () => {
    const expiredHtml = renderToString(
      createElement(JobTagsPanel, {
        jobId: "j1",
        initialTags: [tag("a", ddmm(-3)), tag("b", ddmm(5)), tag("c", ddmm(300))],
      }),
    );
    expect(expiredHtml).toContain("1 expired");
    expect(expiredHtml).toContain("· 1 due within 14 days");

    const dueHtml = renderToString(
      createElement(JobTagsPanel, { jobId: "j1", initialTags: [tag("b", ddmm(5))] }),
    );
    expect(dueHtml).toContain("1 due soon");
  });

  it("a failed load shows a retry notice, never a misleading zero", () => {
    const html = renderToString(
      createElement(JobTagsPanel, { jobId: "j1", initialTags: [], loadError: true }),
    );
    expect(html).toContain("Pull to refresh to try again");
    expect(html).not.toContain("No tags recorded");
    expect(html).not.toContain("Open the register");
  });
});
