import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobSiteCard } from "./PhilJobSiteCard";
import type { Job } from "@/domains/jobs/types";

function job(over: Partial<Job> = {}): Job {
  return { id: "j", name: "J", status: "active", ...over } as unknown as Job;
}

/**
 * Site details card — extracted from PhilJobDetail and moved to the bottom
 * reference zone. Guards: the real site fields render, the #phil-job-site
 * anchor is preserved (the induction attention item links here), the
 * induction warning surfaces, it stays hidden when there's no site context,
 * and the copy stays plain field language.
 */
describe("PhilJobSiteCard", () => {
  it("renders 'Site details' with the real site fields", () => {
    const html = renderToString(
      createElement(PhilJobSiteCard, {
        job: job({
          siteAddress: "12 Birdwood Rd",
          accessNotes: "Gate code 1234",
          parkingNotes: "Out the front",
          safetyNotes: "Live switchboard",
        }),
      }),
    );
    expect(html).toContain("Site details");
    expect(html).toContain("12 Birdwood Rd");
    expect(html).toContain("Gate code 1234");
    expect(html).toContain("Out the front");
    expect(html).toContain("Live switchboard");
  });

  it("keeps the #phil-job-site anchor (the induction attention item links here)", () => {
    const html = renderToString(
      createElement(PhilJobSiteCard, { job: job({ siteAddress: "x" }) }),
    );
    expect(html).toContain('id="phil-job-site"');
  });

  it("surfaces the induction warning when the site requires it", () => {
    const html = renderToString(
      createElement(PhilJobSiteCard, { job: job({ inductionRequired: true }) }),
    );
    expect(html).toContain("Site induction required");
    expect(html).toContain("leading hand");
  });

  it("renders nothing when the job has no site context", () => {
    const html = renderToString(createElement(PhilJobSiteCard, { job: job() }));
    expect(html).toBe("");
  });

  it("uses plain field language — no admin/payroll/Xero jargon", () => {
    const html = renderToString(
      createElement(PhilJobSiteCard, {
        job: job({ siteAddress: "x", inductionRequired: true }),
      }),
    ).toLowerCase();
    for (const banned of ["payroll", "xero", "dashboard", "admin", "registry"]) {
      expect(html).not.toContain(banned);
    }
  });
});
