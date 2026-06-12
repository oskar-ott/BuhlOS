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

function render(quote: Quote = goldenQuote()): string {
  return renderToString(createElement(QuoteBuilderClient, { initialQuote: quote }));
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

  it("keeps out-of-scope capabilities dark — no stubs for the sibling issues", () => {
    const html = render();
    for (const absent of [
      "Version",
      "Approval",
      "PDF",
      "Acceptance",
      "Accept",
      "Convert",
      "Template",
      "Markup",
      "Contingency",
      "Margin",
      "coming soon",
      "Under construction",
    ]) {
      expect(html).not.toContain(absent);
    }
  });
});
