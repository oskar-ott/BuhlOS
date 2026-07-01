import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/v2/quotes/qv2_a",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

import { QuoteBuilderClient } from "./QuoteBuilderClient";
import type { Quote } from "@/domains/quoting/schema";

/**
 * SSR smoke for the quote builder (#183): sections render with their line
 * grids, the LIVE totals come from src/domains/quoting/totals.ts (the
 * golden quote prints the golden numbers — the same fixture pinned in
 * totals.test.ts and the api harness), the save chip starts at "Saved" on
 * a clean load, and out-of-scope capabilities (versions / approval / PDF /
 * acceptance / convert) are genuinely DARK — not stubbed.
 *
 * Interaction paths (dirty chip, 409 banner, id adoption) are pure-function
 * + fetch flows exercised through the api harness and the totals suite;
 * SSR cannot click, so this suite pins the render contract.
 */

/** The GOLDEN quote — same numbers as totals.test.ts / quotes-v2-api.test.ts. */
function goldenQuote(): Quote {
  return {
    id: "qv2_a",
    name: "Birdwood St rewire",
    clientName: "B. Hender",
    status: "draft",
    createdAt: "2026-06-12T00:00:00.000Z",
    createdBy: "quinn",
    updatedAt: "2026-06-12T01:00:00.000Z",
    sections: [
      {
        id: "qsec_a",
        title: "Power",
        sortOrder: 0,
        lines: [
          { id: "qline_1", kind: "material", description: "Twin GPO", qty: 3, unit: "ea", rate: 99.95 },
          { id: "qline_2", kind: "labour", description: "Rough-in", qty: 0.5, unit: "hrs", rate: 150 },
        ],
      },
      {
        id: "qsec_b",
        title: "Sundries",
        sortOrder: 1,
        lines: [
          { id: "qline_3", kind: "other", description: "Cable ties", qty: 10, unit: "ea", rate: 0.333 },
        ],
      },
    ],
    totals: { subtotalExGst: 378.18, gst: 37.82, totalIncGst: 416, lineCount: 3 },
  };
}

function render(quote: Quote = goldenQuote(), viewerIsAdmin = true): string {
  return renderToString(
    createElement(QuoteBuilderClient, { initialQuote: quote, viewerIsAdmin }),
  );
}

describe("QuoteBuilderClient (#183) — render contract", () => {
  it("renders every section with its title and line fields", () => {
    const html = render();
    expect(html).toContain('value="Power"');
    expect(html).toContain('value="Sundries"');
    expect(html).toContain('value="Twin GPO"');
    expect(html).toContain('value="Rough-in"');
    expect(html).toContain('value="Cable ties"');
    // Line kind selects carry the three foundation kinds.
    for (const kind of ["Material", "Labour", "Other"]) expect(html).toContain(kind);
    expect(html).toContain('data-testid="quote-builder-section-0"');
    expect(html).toContain('data-testid="quote-builder-section-1"');
  });

  it("LIVE totals are computed from totals.ts and print the golden numbers", () => {
    const html = render();
    expect(html).toContain("$378.18"); // subtotal ex GST
    expect(html).toContain("$37.82"); // GST
    expect(html).toContain("$416.00"); // total inc GST
    // Line totals are computed (3 × 99.95) and rounded at the line (10 × 0.333).
    expect(html).toContain("$299.85");
    expect(html).toContain("$3.33");
    // Per-section subtotal in the section header.
    expect(html).toContain("$374.85");
  });

  it("starts at the Saved chip on a clean load, with the save button disabled", () => {
    const html = render();
    expect(html).toMatch(/data-testid="quote-builder-save-state"[^>]*>Saved</);
    expect(html).toMatch(/data-testid="quote-builder-save"[^>]*disabled/);
    // No stale banner, no save error on a clean load.
    expect(html).not.toContain('data-testid="quote-builder-stale-banner"');
    expect(html).not.toContain('data-testid="quote-builder-save-error"');
  });

  it("offers add-section / add-line / reorder / remove controls", () => {
    const html = render();
    expect(html).toContain('data-testid="quote-builder-add-section"');
    expect(html).toContain('data-testid="quote-builder-add-line-0"');
    expect(html).toContain('aria-label="Move section 1 down"');
    expect(html).toContain('aria-label="Remove section 1"');
    expect(html).toContain('aria-label="Remove line"');
  });

  it("renders an honest empty state for a freshly created quote", () => {
    const html = render({ ...goldenQuote(), sections: [], totals: { subtotalExGst: 0, gst: 0, totalIncGst: 0, lineCount: 0 } });
    expect(html).toContain('data-testid="quote-builder-no-sections"');
    expect(html).toContain("$0.00");
  });

  it("keeps still-out-of-scope capabilities dark — no stubs for the sibling issues", () => {
    const html = render();
    // #214/#193 (margin + cost + presets) now SHIP, so they're no longer absent.
    // The remaining siblings (markup table, contingency, versions, approval, PDF,
    // acceptance, convert, templates) stay dark — no stubs.
    for (const absent of [
      "Version",
      "Approval",
      "PDF",
      "Acceptance",
      "Convert",
      "Template",
      "Markup",
      "Contingency",
      "coming soon",
      "Under construction",
    ]) {
      expect(html).not.toContain(absent);
    }
  });

  it("renders the office-only margin view for an admin viewer (#214) — honest about uncosted lines", () => {
    const html = render(goldenQuote(), true);
    expect(html).toContain('data-testid="quote-builder-margin"');
    expect(html).toContain("Margin — office only");
    expect(html).toContain("Never shown to the client");
    // The golden quote carries no unit costs yet → honest uncosted state, no fake %.
    expect(html).toContain("lines costed");
    expect(html).toContain("Rate presets");
    // Per-line internal cost entry is present.
    expect(html).toContain("Unit cost ex GST");
  });

  it("NEVER renders cost or margin for a non-admin viewer (confidential gate — §8A)", () => {
    // Defence-in-depth: the surface is admin-gated, but even if a non-admin
    // reached the builder, the cost/margin panel + per-line cost entry must be
    // absent. The sell-side line grid + totals still render normally.
    const html = render(goldenQuote(), false);
    // Confidential UI is gone.
    expect(html).not.toContain('data-testid="quote-builder-margin"');
    expect(html).not.toContain("Margin — office only");
    expect(html).not.toContain("Unit cost ex GST");
    expect(html).not.toContain("Rate presets");
    // The sell-side quote still renders (sections + the golden totals).
    expect(html).toContain('value="Power"');
    expect(html).toContain("$416.00");
  });

  it("defaults to NO cost/margin when viewerIsAdmin is omitted (fail-closed — §8A)", () => {
    // The prop defaults to false, so a caller that forgets it leaks nothing.
    const html = renderToString(createElement(QuoteBuilderClient, { initialQuote: goldenQuote() }));
    expect(html).not.toContain('data-testid="quote-builder-margin"');
    expect(html).not.toContain("Unit cost ex GST");
  });
});
