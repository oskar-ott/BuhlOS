import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobItpPanel } from "./JobItpPanel";
import type { Job } from "@/domains/jobs/types";

const job = { id: "j", name: "J", status: "active" } as unknown as Job;

/**
 * Field-language guard for the checks panel: site language to leaf (#516, P11).
 * The heading AND the description speak "Checks" — the "(ITPs)" parenthetical is
 * gone so no screen shows both dialects for the same thing. Empty state honest +
 * plain. No office/module jargon, no fake state.
 */
describe("JobItpPanel — field language", () => {
  it("leads with 'Checks' and the description no longer carries the '(ITPs)' parenthetical", () => {
    const html = renderToString(
      createElement(JobItpPanel, { job, initialItps: [] }),
    );
    expect(html).toContain("Checks");
    expect(html).toContain("Inspection checks for this job");
    expect(html).not.toContain("(ITPs)"); // P11 — one dialect per thing
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
