import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { CostImportCardBody } from "./JobCostImportCard";
import type { CostImportSummary } from "@/domains/job-doc-import/schema";

/**
 * Server-render tests for the job-hub cost-basis card body (#365). Renders the
 * presentational body (no fetch) and asserts the honest headline: the imported
 * total, the line/package counts, the reconciliation state (green when it
 * balances, the delta when it doesn't, "no stated total" when there's nothing to
 * check against), and the provenance line.
 */

function summary(over: Partial<CostImportSummary> = {}): CostImportSummary {
  return {
    source: "boq-import",
    importedAt: "2026-06-28T00:00:00Z",
    importedByName: "boss",
    fileName: "REV5.xlsx",
    total: 7110,
    stated: 7160,
    delta: -50,
    reconciles: false,
    lines: 2,
    sections: 2,
    ...over,
  };
}

const strip = (html: string) => html.replace(/<!-- -->/g, "");

describe("CostImportCardBody", () => {
  it("leads with the imported total + the line/package counts + provenance", () => {
    const html = strip(renderToString(createElement(CostImportCardBody, { costImport: summary() })));
    expect(html).toContain("Imported cost estimate");
    expect(html).toContain("$7,110.00");
    expect(html).toContain("2 priced lines across 2 packages");
    expect(html).toContain("from REV5.xlsx");
    expect(html).toContain("imported by boss");
    expect(html).toContain("2026"); // the imported-at date renders (locale-robust)
  });

  it("shows the delta (absolute) when the bill does not reconcile", () => {
    const html = strip(renderToString(createElement(CostImportCardBody, { costImport: summary() })));
    expect(html).toContain("off by $50.00");
  });

  it("shows a green reconciles chip when it balances", () => {
    const html = strip(
      renderToString(
        createElement(CostImportCardBody, {
          costImport: summary({ stated: 7110, delta: 0, reconciles: true }),
        })
      )
    );
    expect(html).toContain("reconciles");
    expect(html).not.toContain("off by");
  });

  it("reads 'no stated total' when there's nothing to reconcile against", () => {
    const html = strip(
      renderToString(
        createElement(CostImportCardBody, {
          costImport: summary({ stated: null, delta: null, reconciles: null }),
        })
      )
    );
    expect(html).toContain("no stated total");
  });
});
