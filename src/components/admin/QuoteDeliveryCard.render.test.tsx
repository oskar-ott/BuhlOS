import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QuoteDeliveryCard } from "./QuoteDeliveryCard";
import type { QuoteLine, QuoteSection } from "@/domains/quoting/schema";

/**
 * #240 — the quote client-status card's initial render (renderToString skips the
 * mount fetch). The lifecycle logic is pinned by the pure/API harnesses; this
 * guards the card mounts with its title + loading state, plus the #246
 * needs-pricing warning (warn only — the card never blocks a send).
 */

let lineSeq = 0;
function line(overrides: Partial<QuoteLine> = {}): QuoteLine {
  lineSeq += 1;
  return {
    id: `l${lineSeq}`,
    kind: "material",
    description: "Cable run",
    qty: 1,
    unit: "ea",
    rate: 100,
    ...overrides,
  };
}

function section(lines: QuoteLine[]): QuoteSection {
  return { id: "s1", title: "Power", sortOrder: 0, lines };
}

function aiLine(): QuoteLine {
  return line({ kind: "other", rate: 0, source: "ai_suggested", aiSuggestionId: "sug1", needsPricing: true });
}

describe("QuoteDeliveryCard — initial render", () => {
  it("renders the Client status title and a loading state", () => {
    const html = renderToString(
      createElement(QuoteDeliveryCard, { quoteId: "q1", sections: [section([line()])] })
    );
    expect(html).toContain("Client status");
    expect(html).toContain("Loading");
  });

  it("shows no needs-pricing warning when no line carries needsPricing", () => {
    const html = renderToString(
      createElement(QuoteDeliveryCard, { quoteId: "q1", sections: [section([line(), line()])] })
    );
    expect(html).not.toContain("quote-needs-pricing-warning");
    expect(html).not.toContain("AI-drafted");
  });

  it("warns with a singular count for one AI-drafted unpriced line", () => {
    const html = renderToString(
      createElement(QuoteDeliveryCard, { quoteId: "q1", sections: [section([line(), aiLine()])] })
    );
    expect(html).toContain("quote-needs-pricing-warning");
    expect(html).toContain("1 AI-drafted line still has no price");
    expect(html).toContain("$0");
  });

  it("counts AI-drafted unpriced lines across sections, plural copy", () => {
    const sections: QuoteSection[] = [
      section([aiLine(), line()]),
      { id: "s2", title: "Lighting", sortOrder: 1, lines: [aiLine(), aiLine()] },
    ];
    const html = renderToString(createElement(QuoteDeliveryCard, { quoteId: "q1", sections }));
    expect(html).toContain("3 AI-drafted lines still have no price");
    // Warn only — the send action must still be reachable (never blocked).
    expect(html).toContain("Client status");
  });
});
