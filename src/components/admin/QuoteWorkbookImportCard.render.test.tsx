import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { QuoteWorkbookImportBody } from "./QuoteWorkbookImportCard";
import type { WorkbookImportRecord } from "@/domains/job-doc-import/schema";

/**
 * Server-render tests for the #365 quote workbook-import review card. Renders
 * the populated body to HTML (no DOM — the JobDocImportPreview.render.test.tsx
 * pattern) and asserts the honest review framing: the "imported — N findings,
 * M unconfirmed classifications" state, the named findings with their cell
 * provenance, the classification confirm affordance, the superseded-upload
 * record and the stamped-counts completion state.
 */

function record(over: Partial<WorkbookImportRecord> = {}): WorkbookImportRecord {
  return {
    quoteId: "qv2_arthur",
    current: {
      importId: "wbimp_1",
      importedAt: "2026-07-03T00:00:00.000Z",
      importedById: "u_boss",
      importedByName: "boss",
      fileName: "100-arthur.xlsx",
      parse: {
        source: { sheetCount: 1, sheetNames: ["BOQ"] },
        lines: [
          {
            id: "wl_1_6",
            sheet: "BOQ",
            row: 6,
            section: "East Gym",
            description: "Dedicated 20A ZIP circuit",
            qty: 2,
            unit: "ea",
            rate: 450,
            subtotal: 1400,
            lineTotal: 1400,
            classification: "base",
            classificationReason: null,
            cells: { description: "BOQ!A6", qty: "BOQ!B6", unit: "BOQ!C6", rate: "BOQ!D6", subtotal: "BOQ!E6" },
          },
          {
            id: "wl_1_9",
            sheet: "BOQ",
            row: 9,
            section: "East Gym",
            description: "PL3 pendants — Alternative",
            qty: 8,
            unit: "ea",
            rate: 365,
            subtotal: 2920,
            lineTotal: 2920,
            classification: "alternate",
            classificationReason: 'matched "Alternative"',
            cells: { description: "BOQ!A9", qty: "BOQ!B9", unit: "BOQ!C9", rate: "BOQ!D9", subtotal: "BOQ!E9" },
          },
        ],
        sections: [
          {
            name: "East Gym",
            lineCount: 2,
            computed: 4320,
            base: 1400,
            stated: 4320,
            statedCellRef: "BOQ!E11",
            reconciles: true,
          },
        ],
        statedTotal: { value: 46034, cellRef: "BOQ!E2" },
        totals: {
          all: 4320,
          base: 1400,
          byClassification: { base: 1400, alternate: 2920, exclusion: 0, pc_sum: 0, by_others: 0 },
          stated: 46034,
          delta: -41714,
          reconciles: false,
        },
        findings: [
          {
            id: "qty_rate_mismatch:BOQ!E6",
            kind: "qty_rate_mismatch",
            severity: "error",
            cellRef: "BOQ!E6",
            message: '"Dedicated 20A ZIP circuit": 2 × 450 = 900, but the subtotal says 1400 (off by 500).',
          },
          {
            id: "alternate_counted_in_base:BOQ!E9",
            kind: "alternate_counted_in_base",
            severity: "error",
            cellRef: "BOQ!E9",
            message: '"PL3 pendants — Alternative" is marked Alternative but its 2920 is counted in the base total.',
          },
        ],
        counts: { lines: 2, findings: 2, bySeverity: { error: 2, warning: 0 } },
      },
    },
    confirmations: [],
    resolutions: [],
    review: { status: "pending" },
    superseded: [],
    status: { openFindings: 2, unconfirmedClassifications: 2 },
    ...over,
  };
}

function render(r: WorkbookImportRecord): string {
  // Strip React's SSR text-node separators so plain-substring asserts work.
  return renderToString(
    createElement(QuoteWorkbookImportBody, { record: r, onRecord: () => {} })
  ).replace(/<!-- -->/g, "");
}

describe("QuoteWorkbookImportBody", () => {
  it("shows the honest review state: imported — N findings, M unconfirmed classifications", () => {
    const html = render(record());
    expect(html).toContain("imported — 2 findings, 2 unconfirmed classifications");
    expect(html).toContain("Mark review complete");
  });

  it("renders each named finding with its cell provenance and resolve/waive actions", () => {
    const html = render(record());
    expect(html).toContain("Qty × rate ≠ subtotal");
    expect(html).toContain("BOQ!E6");
    expect(html).toContain("Alternate counted in base");
    expect(html).toContain("BOQ!E9");
    expect(html).toContain("Resolved");
    expect(html).toContain("Waive");
  });

  it("shows base vs stated totals with the non-reconciling delta named, never hidden", () => {
    const html = render(record());
    expect(html).toContain("Base total");
    expect(html).toContain("$1,400.00");
    expect(html).toContain("$46,034.00");
    expect(html).toContain("off by");
  });

  it("offers a classification confirm on every line and marks confirmed ones", () => {
    const html = render(record());
    expect(html.match(/Confirm/g)?.length).toBeGreaterThanOrEqual(2);

    const confirmed = render(
      record({
        confirmations: [
          { lineId: "wl_1_9", classification: "alternate", by: "boss", at: "2026-07-03T01:00:00.000Z" },
        ],
        status: { openFindings: 2, unconfirmedClassifications: 1 },
      })
    );
    expect(confirmed).toContain("✓ boss");
    expect(confirmed).toContain("1 unconfirmed classification");
  });

  it("completion stamps the counts — the state never fakes clean", () => {
    const html = render(
      record({
        review: {
          status: "complete",
          completedBy: "boss",
          completedAt: "2026-07-03T02:00:00.000Z",
          openFindingsAtCompletion: 1,
          unconfirmedAtCompletion: 0,
        },
      })
    );
    expect(html).toContain("review complete — boss");
    expect(html).toContain("1 findings, 0 unconfirmed at sign-off");
    expect(html).not.toContain("Mark review complete");
  });

  it("names the superseded uploads (the kept record)", () => {
    const html = render(
      record({
        superseded: [
          {
            importId: "wbimp_0",
            importedAt: "2026-07-01T00:00:00.000Z",
            importedByName: "boss",
            fileName: "100-arthur-rev1.xlsx",
            lineCount: 8,
            findingCount: 5,
            supersededAt: "2026-07-03T00:00:00.000Z",
            supersededById: "u_boss",
          },
        ],
      })
    );
    expect(html).toContain("Superseded uploads:");
    expect(html).toContain("100-arthur-rev1.xlsx");
    expect(html).toContain("supersedes 1 earlier upload");
  });
});
