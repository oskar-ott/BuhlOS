import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PreviewLinksRow } from "./PreviewLinksRow";

/**
 * The read-only previews row (owner redesign 2026-08-16) — successor to the
 * PeriodPayrollExport card's guards.
 *
 * CRITICAL invariant carried over (#895 / ADR #609): every export-endpoint
 * href is a dry run (dryRun=1). No mutating GET link, ever — a browser
 * prefetch must never be able to stamp hours.
 */

const render = () =>
  renderToString(
    createElement(PreviewLinksRow, { fromDate: "2026-08-10", toDate: "2026-08-16" }),
  );

describe("PreviewLinksRow", () => {
  it("serves all three previews off the export endpoint", () => {
    const html = render();
    expect(html).toContain(
      "/api/time-entries-export?status=approved&amp;fromDate=2026-08-10&amp;toDate=2026-08-16&amp;shape=review&amp;dryRun=1",
    );
    expect(html).toContain("&amp;shape=xero&amp;dryRun=1");
    expect(html).toContain("&amp;format=pdf&amp;dryRun=1");
  });

  it("NEVER renders a committed/mutating GET link — only dryRun=1 hrefs", () => {
    const html = render();
    const hrefs = [...html.matchAll(/href="([^"]*time-entries-export[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(3);
    for (const href of hrefs) expect(href).toContain("dryRun=1");
  });

  it("says plainly that downloads never mark hours exported", () => {
    expect(render()).toContain("they never mark hours exported");
  });
});
