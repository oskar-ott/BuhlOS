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
  it("read-only copy + both dry-run downloads, pointing at the page's hand-offs", () => {
    const html = render();
    expect(html).toContain("downloading never marks hours as sent");
    expect(html).toContain("use one of the hand-offs on this page");
    // Plain words, no payroll-run claims (BuhlOS stops at Xero drafts).
    expect(html).not.toContain("payroll run");
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

  it("names workers not linked to Xero, with the link to fix it — and stays quiet when all are linked", () => {
    const html = render({ eligibleWorkerCount: 3, unmappedEligibleWorkerCount: 2 });
    expect(html).toContain('data-testid="period-unmapped-workers"');
    expect(html.replace(/<!-- -->/g, "")).toContain("2 of 3 workers not linked to Xero yet");
    expect(html).toContain('href="/settings/integrations/xero"');
    expect(html).toContain("Link them in Xero settings");
    expect(render()).not.toContain('data-testid="period-unmapped-workers"');
  });

  it("surfaces the not-closed warning without blocking the downloads", () => {
    const html = render({ notClosed: true });
    expect(html).toContain("isn’t closed");
    expect(html).toContain("Download Xero-ready CSV");
  });
});
