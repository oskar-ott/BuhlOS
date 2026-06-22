import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PeriodPayrollExport } from "./PeriodPayrollExport";

/**
 * Static-render guards for the pay-period payroll export (#131). The live
 * confirm→POST→download flow is pinned by the export API harness (POST
 * finalise tests); these pin the INITIAL surface: conservative bridge copy,
 * dry-run-only download links, and the block states.
 *
 * CRITICAL invariant: the committed/mutating run is NEVER an <a href> — the
 * only endpoint links carry dryRun=1; finalising is a POST behind a button.
 */

// useRouter() needs the app-router context renderToString doesn't provide.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const base = {
  fromDate: "2026-06-08",
  toDate: "2026-06-14",
  unexportedApprovedHours: 22.8,
  eligibleWorkerCount: 3,
  unmappedEligibleWorkerCount: 0,
  notClosed: false,
};

const render = (props: Partial<typeof base> = {}) =>
  renderToString(createElement(PeriodPayrollExport, { ...base, ...props }));

describe("PeriodPayrollExport", () => {
  it("uses conservative bridge copy and offers both dry-run downloads", () => {
    const html = render();
    expect(html).toContain("Xero-ready CSV bridge — no direct Xero connection yet");
    expect(html).toContain("Preview downloads do not mark hours as exported");
    // both download links are dry runs against the export endpoint
    expect(html).toContain("/api/time-entries-export?status=approved&amp;fromDate=2026-06-08&amp;toDate=2026-06-14&amp;shape=review&amp;dryRun=1");
    expect(html).toContain("&amp;shape=xero&amp;dryRun=1");
  });

  it("NEVER renders a committed/mutating GET link — only dryRun=1 hrefs", () => {
    const html = render();
    // every endpoint href must be a dry run; no bare committed link
    const hrefs = [...html.matchAll(/href="([^"]*time-entries-export[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toContain("dryRun=1");
    // the old #649 committed link ended with shape=xero" (no dryRun) — gone
    expect(html).not.toContain('shape=xero"');
  });

  it("offers Finalise when there are new hours and all workers are mapped", () => {
    const html = render();
    expect(html).toContain("Finalise + record export");
    expect(html).not.toContain("nothing new to finalise");
  });

  it("blocks finalise (disabled) and warns when an eligible worker has no Xero id", () => {
    const html = render({ unmappedEligibleWorkerCount: 2 });
    expect(html).toContain("no Xero employee id");
    expect(html).toContain("disabled");
    expect(html).toContain("blocked");
  });

  it("does NOT block finalise when unmapped workers are all already exported (eligible-scoped gate)", () => {
    // period-wide unmapped workers exist, but none have NEW hours → finalise allowed
    const html = render({ unmappedEligibleWorkerCount: 0 });
    expect(html).toContain("Finalise + record export");
    expect(html).not.toContain("blocked");
  });

  it("shows nothing-new and no Finalise button when all hours are already exported", () => {
    const html = render({ unexportedApprovedHours: 0 });
    expect(html).toContain("already in a committed run — nothing new to finalise");
    expect(html).not.toContain("Finalise + record export");
  });

  it("surfaces the not-closed warning without blocking the downloads", () => {
    const html = render({ notClosed: true });
    expect(html).toContain("isn’t closed");
    // downloads still present
    expect(html).toContain("Download Xero-ready CSV");
  });
});
