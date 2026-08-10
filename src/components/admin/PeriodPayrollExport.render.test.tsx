import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PeriodPayrollExport } from "./PeriodPayrollExport";

/**
 * Static-render guards for the pay-period payroll downloads (#131 / #895).
 * The committed finalise POST is retired — this surface is read-only CSV
 * previews plus copy pointing at the payroll-batch flow.
 *
 * CRITICAL invariant: every export-endpoint href is a dry run (dryRun=1); no
 * mutating GET link, and no finalise action.
 */

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
  it("read-only copy + both dry-run downloads, pointing at the batch flow", () => {
    const html = render();
    expect(html).toContain("never mark hours as exported");
    expect(html).toContain("Payroll batch panel");
    expect(html).toContain(
      "/api/time-entries-export?status=approved&amp;fromDate=2026-06-08&amp;toDate=2026-06-14&amp;shape=review&amp;dryRun=1",
    );
    expect(html).toContain("&amp;shape=xero&amp;dryRun=1");
    // Owner pull 2026-08-10 — the printable sheet alongside the CSVs, equally
    // read-only (the dryRun=1 invariant below covers every href).
    expect(html).toContain("&amp;format=pdf&amp;dryRun=1");
    expect(html).toContain("Download PDF");
  });

  it("NEVER renders a committed/mutating GET link — only dryRun=1 hrefs, no finalise", () => {
    const html = render();
    const hrefs = [...html.matchAll(/href="([^"]*time-entries-export[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toContain("dryRun=1");
    // the old committed link ended with shape=xero" (no dryRun) — gone
    expect(html).not.toContain('shape=xero"');
    // the finalise POST action is retired
    expect(html).not.toContain("Finalise + record export");
  });

  it("shows unbatched-hours context only when there are unexported hours", () => {
    expect(render()).toContain("aren’t in a locked batch yet");
    expect(render({ unexportedApprovedHours: 0 })).not.toContain("aren’t in a locked batch yet");
  });

  it("surfaces the not-closed warning without blocking the downloads", () => {
    const html = render({ notClosed: true });
    expect(html).toContain("isn’t closed");
    expect(html).toContain("Download Xero-ready CSV");
  });
});
