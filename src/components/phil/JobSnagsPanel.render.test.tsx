import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobSnagsPanel } from "./JobSnagsPanel";
import type { Job } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";

const job = { id: "j", name: "J", status: "active" } as unknown as Job;
const viewer = { id: "u1", role: "electrician" };
const context = { stage: null, areaId: null };

/**
 * Field-language guard for the issues panel. The heading leads with "Issues"
 * (plain field language) while the action keeps the established AU site term
 * "Report snag". Empty state honest + plain; no office/module jargon.
 */
describe("JobSnagsPanel — field language", () => {
  it("leads with 'Issues' and keeps the established 'Report snag' action", () => {
    const html = renderToString(
      createElement(JobSnagsPanel, { job, initialSnags: [], context, viewer }),
    );
    expect(html).toContain("Issues");
    expect(html).toContain("Report snag"); // established site term, kept for recognition
  });

  it("shows an honest, plain empty state", () => {
    const html = renderToString(
      createElement(JobSnagsPanel, { job, initialSnags: [], context, viewer }),
    );
    expect(html).toContain("No open issues on this job");
  });

  it("explainer teaches only when empty; a populated panel is heading + content (#424)", () => {
    const emptyHtml = renderToString(
      createElement(JobSnagsPanel, { job, initialSnags: [], context, viewer }),
    );
    expect(emptyHtml).toContain("Things on site that need fixing");
    const snag = {
      id: "s1",
      jobId: "j",
      title: "Loose meter box",
      status: "open",
      severity: "normal",
      createdAt: "2026-06-01",
    } as unknown as SnagItem;
    const fullHtml = renderToString(
      createElement(JobSnagsPanel, { job, initialSnags: [snag], context, viewer }),
    );
    expect(fullHtml).not.toContain("Things on site that need fixing");
    expect(fullHtml).toContain("Report snag"); // action still present
  });

  it("uses no admin / payroll / Xero / module jargon", () => {
    const html = renderToString(
      createElement(JobSnagsPanel, { job, initialSnags: [], context, viewer }),
    ).toLowerCase();
    for (const banned of [
      "payroll",
      "xero",
      "dashboard",
      "registry",
      "workflow",
      "document-control",
      "module",
    ]) {
      expect(html).not.toContain(banned);
    }
  });
});
