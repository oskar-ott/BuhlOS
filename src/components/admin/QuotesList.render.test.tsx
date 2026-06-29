import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/v2/quotes",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

import { QuotesList } from "./QuotesList";
import type { QuoteSummary } from "@/domains/quoting/schema";

/**
 * SSR smoke for the /v2/quotes list body (#183): summary rows print
 * name · status (format.ts vocabulary) · line count · total inc GST
 * (formatMoney — the ONE money formatter), rows deep-link into the
 * builder, the create entry point renders, and the honest new-quotes-only
 * note is always present (the #172 ruling made the legacy draft shells
 * deliberately unlisted — the note says so instead of hiding it).
 */

const QUOTES: ReadonlyArray<QuoteSummary> = [
  {
    id: "qv2_a",
    name: "Birdwood St rewire",
    clientName: "B. Hender",
    status: "draft",
    updatedAt: "2026-06-12T01:00:00.000Z",
    totalIncGst: 416,
    lineCount: 3,
  },
  {
    id: "qv2_b",
    name: "East Gym fitout",
    clientName: null, // not captured → honest dash
    status: "submitted",
    updatedAt: "2026-06-11T01:00:00.000Z",
    totalIncGst: 12345.5,
    lineCount: 1,
  },
];

function render(quotes: ReadonlyArray<QuoteSummary> = QUOTES): string {
  return renderToString(createElement(QuotesList, { quotes }));
}

describe("QuotesList (#183)", () => {
  it("renders a row per quote with name, status label, line count and total inc GST", () => {
    const html = render();
    expect(html).toContain("Birdwood St rewire");
    expect(html).toContain("East Gym fitout");
    expect(html).toContain("Draft"); // format.ts vocabulary, not raw status strings
    expect(html).toContain("Submitted");
    expect(html).toContain("$416.00");
    expect(html).toContain("$12,345.50"); // en-AU grouping + forced cents
    expect(html).toContain("3 lines");
    expect(html).toContain("1 line"); // singular
  });

  it("renders the Client column — captured client name, or an honest dash (§8A)", () => {
    const html = render();
    // clientName is already captured on the quote; the list now shows it.
    expect(html).toContain("B. Hender");
    // A quote with no client name shows "—", never a fabricated client.
    expect(html).toContain("—");
  });

  it("never exposes cost or margin in the list projection (confidential — §8A)", () => {
    // The list summary is SELL-SIDE only. Cost/margin live behind the admin gate
    // on the detail surface; they must not appear in the registry-fed list.
    const html = render();
    expect(html.toLowerCase()).not.toContain("cost");
    expect(html.toLowerCase()).not.toContain("margin");
  });

  it("rows deep-link into the builder", () => {
    const html = render();
    expect(html).toContain('href="/v2/quotes/qv2_a"');
    expect(html).toContain('href="/v2/quotes/qv2_b"');
  });

  it("offers the create entry point", () => {
    expect(render()).toContain('data-testid="quotes-new-quote"');
  });

  it("shows an honest empty state when there are no quotes", () => {
    const html = render([]);
    expect(html).toContain("No quotes yet");
    expect(html).toContain('data-testid="quotes-empty"');
    expect(html).not.toContain('data-testid="quotes-rows"');
  });

  it("always carries the new-quotes-only note (legacy drafts stay unlisted, stated honestly)", () => {
    for (const html of [render(), render([])]) {
      expect(html).toContain('data-testid="quotes-legacy-note"');
      expect(html).toContain("remain in the old quoting store");
    }
  });
});
