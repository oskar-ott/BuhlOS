import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobDetailShell, type JobShellHeader } from "./PhilJobDetailShell";

const header: JobShellHeader = {
  id: "job-1",
  name: "Birdwood Rd — Rough-in",
  status: "active",
  ref: "BW-001",
  siteAddress: "12 Birdwood Rd, Sydney",
  typeName: "Residential",
};

/**
 * SSR smoke for the job-detail fast shell (the <Suspense> fallback): it shows a
 * useful, honest header from the summary while the full detail streams — and
 * never fabricates job structure/counts or leaks identity when the job isn't
 * visible (null header).
 */
describe("PhilJobDetailShell", () => {
  it("renders a useful header from the summary + an honest loading placeholder", () => {
    const html = renderToString(createElement(PhilJobDetailShell, { header }));
    expect(html).toContain("Birdwood Rd — Rough-in");
    expect(html).toContain("12 Birdwood Rd, Sydney");
    expect(html).toContain("BW-001");
    expect(html).toContain("Residential");
    expect(html).toContain("All jobs"); // back link preserved (place-first nav)
    expect(html).toContain("Loading job details"); // honest — not a fake "all clear"
    expect(html).toContain('aria-busy="true"');
  });

  it("does NOT render money/commercial values (none are in the shell contract)", () => {
    // A money figure would only appear if the shell were fed full job data; it
    // is fed only the redacted summary header, so commercial figures can't show.
    const html = renderToString(createElement(PhilJobDetailShell, { header }));
    expect(html).not.toMatch(/contractValue|labourEstimate|\$\d/);
  });

  it("leaks no job identity when the header is null (job not visible)", () => {
    const html = renderToString(createElement(PhilJobDetailShell, { header: null }));
    expect(html).toContain("All jobs"); // still navigable back
    expect(html).toContain("Loading job details");
    expect(html).not.toContain("Birdwood Rd — Rough-in"); // no name leak
    expect(html).not.toContain("12 Birdwood Rd, Sydney"); // no address leak
  });
});
