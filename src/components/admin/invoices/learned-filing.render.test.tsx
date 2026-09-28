import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { LearnedFilingCard, LearnedFilingRow } from "./LearnedFilingCard";
import { InvoiceInboxClient } from "./InvoiceInboxClient";

/**
 * Task I (2026-09-27): the "Remembered filing" card starts collapsed and
 * fabricates nothing; a row names the supplier (or "Any supplier"), the
 * product key, the category, who set it, and offers a two-step Forget.
 */
const noop = () => undefined;
const rule = { id: "r1", supplierKey: "sparky", supplierName: "Sparky Supplies", descriptionKey: "25mm tps cable 100m", category: "cable", setBy: "Karen Boss", setAt: "2026-09-24T03:00:00.000Z", linesFiledNow: 3 };

describe("LearnedFilingCard — render contract", () => {
  it("collapsed by default: explanation, no list, no fetch", () => {
    const html = renderToString(createElement(LearnedFilingCard));
    expect(html).toContain("Remembered filing");
    expect(html).toContain("Only a person creates a rule");
    expect(html).not.toContain("learned-filing-rules");
    expect(html).not.toContain("learned-filing-skeleton");
  });

  it("a row names supplier, product key, category, setter and count, with Forget as the only action", () => {
    const html = renderToString(createElement("ul", null, createElement(LearnedFilingRow, { rule, busy: false, onForget: noop }))).replace(/<!--\s*-->/g, "");
    expect(html).toContain("Sparky Supplies");
    expect(html).toContain("25mm tps cable 100m");
    expect(html).toContain("Cable");
    expect(html).toContain("set by Karen Boss");
    expect(html).toContain("files 3 lines now");
    expect(html).toContain('data-testid="learned-rule-forget-r1"');
    expect(html).not.toContain("Yes, forget");
  });

  it("an any-supplier rule is named as such", () => {
    const html = renderToString(createElement("ul", null, createElement(LearnedFilingRow, { rule: { ...rule, supplierKey: "", supplierName: null }, busy: false, onForget: noop })));
    expect(html).toContain("Any supplier");
  });

  it("the inbox still renders with the card in place", () => {
    const html = renderToString(createElement(InvoiceInboxClient, {}));
    expect(html).toContain("Remembered filing");
    expect(html).toContain("Inbound email");
  });
});
