import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QuoteDeliveryCard } from "./QuoteDeliveryCard";

/**
 * #240 — the quote client-status card's initial render (renderToString skips the
 * mount fetch). The lifecycle logic is pinned by the pure/API harnesses; this
 * guards the card mounts with its title + loading state.
 */
describe("QuoteDeliveryCard — initial render", () => {
  it("renders the Client status title and a loading state", () => {
    const html = renderToString(createElement(QuoteDeliveryCard, { quoteId: "q1" }));
    expect(html).toContain("Client status");
    expect(html).toContain("Loading");
  });
});
