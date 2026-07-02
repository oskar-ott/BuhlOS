import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SheetRegistryCard } from "./SheetRegistryCard";
import type { RegistryRow } from "@/domains/ai-drawings/registry";

/**
 * SSR smoke for the #199 sheet registry. renderToString draws the default
 * state (no query, type=all) — the search/filter behaviour itself is covered
 * by the pure tests in src/domains/ai-drawings/registry.test.ts.
 */

function row(over: Partial<RegistryRow>): RegistryRow {
  return {
    planId: "pl1",
    pageIndex: 0,
    pngUrl: "https://blob/pl1-0.png",
    docLabel: "E-SET · Rev C",
    docStatus: "current",
    sheetType: "floorPlan",
    sheetNumber: "E-101",
    sheetTitle: "LEVEL 1 POWER",
    revision: "C",
    scale: "1:100",
    needsReview: false,
    corrected: false,
    ...over,
  };
}

describe("SheetRegistryCard (#199)", () => {
  it("renders search, type filters, and a row per sheet with honest markers", () => {
    // renderToString separates adjacent text expressions with <!-- --> —
    // strip them so assertions can span JSX expression boundaries.
    const html = strip(renderToString(
      createElement(SheetRegistryCard, {
        rows: [
          row({}),
          row({
            pageIndex: 1,
            sheetNumber: "E-601",
            sheetTitle: null,
            sheetType: "schedule",
            needsReview: true,
            corrected: true,
          }),
        ],
      }),
    ));
    expect(html).toContain('data-testid="sheet-registry"');
    expect(html).toContain("Search sheets by number or title");
    expect(html).toContain("Floor plan"); // type chip vocabulary
    expect(html.match(/data-testid="sheet-registry-row"/g) ?? []).toHaveLength(2);
    expect(html).toContain("E-101");
    expect(html).toContain("LEVEL 1 POWER");
    expect(html).toContain("(no title read)"); // null title never invented
    expect(html).toContain("unreviewed"); // needs-review visibly marked
    expect(html).toContain("corrected");
    expect(html).toContain("2 of 2 sheets");
    expect(html).toContain("1 unreviewed");
  });

  it("says so when every row is filtered away (empty rows edge)", () => {
    const html = strip(
      renderToString(createElement(SheetRegistryCard, { rows: [] })),
    );
    expect(html).toContain("0 of 0 sheets");
    expect(html).toContain("No sheets match this search.");
  });
});

function strip(html: string): string {
  return html.replace(/<!-- -->/g, "");
}
