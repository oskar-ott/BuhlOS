import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobItpPanel } from "./JobItpPanel";
import type { Job } from "@/domains/jobs/types";

const job = { id: "j", name: "J", status: "active" } as unknown as Job;

/**
 * Field-language guard for the checks panel. The heading leads with "Checks"
 * (plain field language) while the description keeps "(ITPs)" for recognition,
 * and the empty state is honest + plain. No office/module jargon, no fake state.
 */
describe("JobItpPanel — field language", () => {
  it("leads with 'Checks', keeping ITP recognisable in the description", () => {
    const html = renderToString(
      createElement(JobItpPanel, { job, initialItps: [] }),
    );
    expect(html).toContain("Checks");
    expect(html).toContain("ITPs"); // retained for recognition, not the lead label
  });

  it("shows an honest, plain empty state", () => {
    const html = renderToString(
      createElement(JobItpPanel, { job, initialItps: [] }),
    );
    expect(html).toContain("No checks listed for this job yet");
  });

  it("uses no admin / payroll / Xero / module jargon", () => {
    const html = renderToString(
      createElement(JobItpPanel, { job, initialItps: [] }),
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
