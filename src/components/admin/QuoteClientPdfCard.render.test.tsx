import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QuoteClientPdfCard } from "./QuoteClientPdfCard";

/**
 * #243 — the client-PDF card's initial render (renderToString skips the mount
 * fetch). Generation/register logic is pinned by the API harness
 * (src/domains/quoting/quote-pdf-api.test.ts); this guards the card mounts
 * with its title, both actions and the loading state.
 */
describe("QuoteClientPdfCard — initial render", () => {
  it("renders the title, preview link, issue action and loading state", () => {
    const html = renderToString(createElement(QuoteClientPdfCard, { quoteId: "qv2_1" }));
    expect(html).toContain("Client PDF");
    expect(html).toContain("Preview PDF");
    expect(html).toContain("Generate &amp; file PDF");
    expect(html).toContain("/api/quote-pdf?id=qv2_1&amp;download=1");
    expect(html).toContain("Loading");
  });
});
