import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ScheduleTablesCard } from "./ScheduleTablesCard";
import type { ScheduleRow, ScheduleTable } from "@/domains/ai-drawings/schema";

/**
 * SSR smoke for the #202 schedule verification card. renderToString draws the
 * default state; extraction/review behaviour is covered by the API tests
 * (src/domains/ai-drawings/ai-drawings-api.test.ts).
 */

const TABLE: ScheduleTable = {
  id: "st_1",
  planId: "pl1",
  pageIndex: 0,
  pageSha256: "sha0",
  tableKind: "lighting",
  boardIdentifier: null,
  region: { x: 0.1, y: 0.1, w: 0.6, h: 0.5 },
  headers: ["TYPE", "DESCRIPTION", "QTY"],
  columnMap: { TYPE: "typeCode", DESCRIPTION: "description", QTY: "qty" },
  rowCount: 2,
  model: "claude-opus-4-8",
  promptVersion: "sl-v1",
  createdAt: "2026-07-03T00:00:00.000Z",
};

function row(over: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: "sr_1",
    tableId: "st_1",
    rowIndex: 0,
    cells: {
      typeCode: { value: "L1", confidence: 0.95 },
      description: { value: "LED PANEL 600x600", confidence: 0.9 },
      qty: { value: "24", confidence: 0.92 },
    },
    humanCells: null,
    effective: {
      typeCode: { value: "L1", confidence: 0.95, corrected: false },
      description: { value: "LED PANEL 600x600", confidence: 0.9, corrected: false },
      qty: { value: "24", confidence: 0.92, corrected: false },
    },
    rowRegion: { x: 0.1, y: 0.2, w: 0.6, h: 0.03 },
    status: "suggested",
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    ...over,
  };
}

const ROWS: ScheduleRow[] = [
  row({}),
  row({
    id: "sr_2",
    rowIndex: 1,
    cells: {
      typeCode: { value: "L2", confidence: 0.9 },
      description: { value: null, confidence: 0.3 },
      qty: { value: "6", confidence: 0.88 },
    },
    humanCells: { description: "EXIT LIGHT LED" },
    effective: {
      typeCode: { value: "L2", confidence: 0.9, corrected: false },
      description: { value: "EXIT LIGHT LED", confidence: 0.3, corrected: true },
      qty: { value: "6", confidence: 0.88, corrected: false },
    },
    status: "edited",
    reviewedAt: "2026-07-03T00:00:00.000Z",
    reviewedBy: "boss",
  }),
];

function strip(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("ScheduleTablesCard (#202)", () => {
  it("renders the table, honest cell states, and the open accuracy count", () => {
    const html = strip(
      renderToString(
        createElement(ScheduleTablesCard, {
          jobId: "j1",
          tables: [TABLE],
          rows: ROWS,
          columns: { lighting: ["typeCode", "description", "manufacturer", "model", "lamp", "wattage", "qty"] },
          lookup: {
            pngUrlFor: () => "https://blob.test/pl1-0.png",
            labelFor: () => "E-SET · Rev C",
          },
          onRow: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-testid="schedule-tables"');
    expect(html).toContain("Lighting schedule");
    expect(html).toContain("1/2 rows reviewed");
    expect(html).toContain("1 of 6 cells corrected"); // errors counted, not hidden
    expect(html.match(/data-testid="schedule-row"/g) ?? []).toHaveLength(2);
    expect(html).toContain("LED PANEL 600x600");
    expect(html).toContain("EXIT LIGHT LED"); // correction wins on read
    expect(html).toContain("fixed"); // edited status pill
    expect(html).toContain('aria-label="Accept row 1"');
    expect(html).toContain('aria-label="Show source strip for row 1"');
  });

  it("stitches multi-page boards at read time — same board adjacent, parts numbered (#207)", () => {
    const board = (id: string, pageIndex: number): ScheduleTable => ({
      ...TABLE,
      id,
      pageIndex,
      tableKind: "switchboard",
      boardIdentifier: "DB-1",
      headers: ["CCT"],
      columnMap: { CCT: "circuitRef" },
      rowCount: 0,
    });
    const html = strip(
      renderToString(
        createElement(ScheduleTablesCard, {
          jobId: "j1",
          tables: [board("st_b2", 3), board("st_b1", 2)],
          rows: [],
          columns: { switchboard: ["circuitRef", "description", "protection", "cableSize", "phase", "load"] },
          lookup: {
            pngUrlFor: () => null,
            labelFor: () => "E-SET",
          },
          onRow: () => undefined,
        }),
      ),
    );
    expect(html).toContain("Switchboard schedule · DB-1");
    const p1 = html.indexOf("(part 1 of 2)");
    const p2 = html.indexOf("(part 2 of 2)");
    expect(p1).toBeGreaterThan(-1);
    expect(p2).toBeGreaterThan(p1); // page 2 renders before page 3
  });
});
