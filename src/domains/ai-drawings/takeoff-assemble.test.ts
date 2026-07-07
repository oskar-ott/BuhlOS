import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #213 — the pure takeoff assembler (api/_lib/takeoff-assemble.js): only
 * human-accepted rows in, provenance-carrying lines out, estimates always
 * labelled, unparseable quantities flagged instead of invented.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS module under test
const ta: any = requireFromHere("../../../api/_lib/takeoff-assemble.js");

type Row = Record<string, unknown>;

describe("parseQty (#213)", () => {
  it("plain integers parse; anything else is null, never invented", () => {
    expect(ta.parseQty("12")).toBe(12);
    expect(ta.parseQty(" 3 ")).toBe(3);
    expect(ta.parseQty("2 + 2")).toBeNull();
    expect(ta.parseQty("TBC")).toBeNull();
    expect(ta.parseQty("")).toBeNull();
    expect(ta.parseQty(null)).toBeNull();
  });
});

describe("assembleLines (#213)", () => {
  const count = (over: Row = {}): Row => ({
    id: "ac_1",
    plan_id: "pl1",
    page_index: 0,
    page_sha256: "sha0",
    label: "Double GPO",
    count: 12,
    basis: { markerKeys: ["d:d1"] },
    accepted_by_label: "boss",
    accepted_at: "2026-07-03T00:00:00.000Z",
    ...over,
  });

  it("device counts become qty lines with full provenance", () => {
    const { lines, warnings } = ta.assembleLines({ acceptedCounts: [count()] });
    expect(warnings).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      sourceType: "device-count",
      description: "Double GPO",
      qty: 12,
      unit: "ea",
      estimate: false,
      flagged: false,
    });
    expect(lines[0].provenance).toMatchObject({
      planId: "pl1",
      pageIndex: 0,
      acceptedCountId: "ac_1",
      acceptedBy: "boss",
      markerKeys: ["d:d1"],
    });
  });

  const legendEntry = (over: Row = {}): Row => ({
    id: "le_1",
    label: "DGPO C2000 Clipsal",
    normalized_label: "dgpo c2000 clipsal",
    human_label: null,
    description: "49 EA",
    status: "accepted",
    source_plan_id: "pl1",
    source_page_index: 0,
    source_page_sha256: "sha0",
    reviewed_by_label: "boss",
    ...over,
  });

  it("#882: a legend entry with a tabulated quantity assembles as THE line, first, with provenance", () => {
    const { lines } = ta.assembleLines({ legendEntries: [legendEntry()] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      sourceType: "legend-qty",
      description: "DGPO C2000 Clipsal",
      qty: 49,
      unit: "ea",
      estimate: false,
      flagged: false,
    });
    expect(lines[0].provenance).toMatchObject({
      planId: "pl1",
      pageIndex: 0,
      legendEntryId: "le_1",
      legendText: "49 EA",
      acceptedBy: "boss",
      located: 0,
    });
  });

  it("#882: a matching device count becomes a SPOT-CHECK on the legend line — never a competing count", () => {
    const { lines, warnings } = ta.assembleLines({
      legendEntries: [legendEntry()],
      acceptedCounts: [count({ label: "DGPO C2000 Clipsal", count: 2 })],
    });
    // One line only — the legend's 49, not the located 2.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sourceType: "legend-qty", qty: 49, flagged: false });
    expect(lines[0].provenance.located).toBe(2);
    expect(lines[0].provenance.locatedCounts).toHaveLength(1);
    expect(warnings).toHaveLength(0); // fewer located than tabulated = expected spot-check
  });

  it("#882: MORE located than the legend tabulates is a surfaced mismatch — flagged, never merged", () => {
    const { lines, warnings } = ta.assembleLines({
      legendEntries: [legendEntry({ description: "3 EA" })],
      acceptedCounts: [count({ label: "DGPO C2000 Clipsal", count: 5 })],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sourceType: "legend-qty", qty: 3, flagged: true });
    expect(String(lines[0].flagReason)).toContain("5 located");
    expect(String(lines[0].flagReason)).toContain("3 from the legend");
    expect(warnings.some((w: Row) => w.kind === "legend-mismatch")).toBe(true);
  });

  it("#882: an entry with NO tabulated quantity changes nothing — the detection path stands", () => {
    const { lines } = ta.assembleLines({
      legendEntries: [legendEntry({ description: null })],
      acceptedCounts: [count({ label: "DGPO C2000 Clipsal", count: 12 })],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sourceType: "device-count", qty: 12 });
  });

  it("#882: a human-corrected label still matches counts accepted under the original vocabulary label", () => {
    const { lines } = ta.assembleLines({
      legendEntries: [legendEntry({ human_label: "Double GPO C2000" })],
      acceptedCounts: [count({ label: "DGPO C2000 Clipsal", count: 4 })],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      sourceType: "legend-qty",
      description: "Double GPO C2000",
      qty: 49,
    });
    expect(lines[0].provenance.located).toBe(4);
  });

  it("duplicate-scope warnings flag the affected lines and land in warnings", () => {
    const warningsByPage = new Map([
      [
        "pl1:0",
        [{ otherPlanId: "pl2", otherPageIndex: 0, identifier: "DB-1", status: "confirmed" }],
      ],
    ]);
    const { lines, warnings } = ta.assembleLines({
      acceptedCounts: [count()],
      warningsByPage,
    });
    expect(lines[0]).toMatchObject({ flagged: true });
    expect(String(lines[0].flagReason)).toContain("duplicate scope");
    expect(warnings[0]).toMatchObject({ kind: "duplicate-scope", planId: "pl1" });
    expect(String(warnings[0].detail)).toContain("DB-1 also on pl2 p1");
  });

  it("lighting schedule rows use effective cells (human wins) and flag unparseable qty", () => {
    const table: Row = {
      id: "st_1",
      plan_id: "pl1",
      page_index: 2,
      page_sha256: "sha2",
      table_kind: "lighting",
      board_identifier: null,
    };
    const rows: Row[] = [
      {
        id: "sr_1",
        table_id: "st_1",
        row_index: 0,
        status: "accepted",
        cells: {
          typeCode: { value: "L1", confidence: 0.9 },
          description: { value: "LED DOWNLIGHT 13W", confidence: 0.9 },
          qty: { value: "24", confidence: 0.9 },
        },
        human_cells: null,
      },
      {
        id: "sr_2",
        table_id: "st_1",
        row_index: 1,
        status: "edited",
        cells: {
          typeCode: { value: "L2", confidence: 0.9 },
          description: { value: "OYSTER", confidence: 0.9 },
          qty: { value: "AS REQ", confidence: 0.4 },
        },
        human_cells: { description: "OYSTER 18W" }, // human correction wins
      },
      {
        id: "sr_3",
        table_id: "st_1",
        row_index: 2,
        status: "suggested", // NOT accepted — never assembles
        cells: { typeCode: { value: "L3", confidence: 0.9 } },
        human_cells: null,
      },
    ];
    const { lines } = ta.assembleLines({ scheduleTables: [table], scheduleRows: rows });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      description: "L1 — LED DOWNLIGHT 13W",
      qty: 24,
      flagged: false,
    });
    expect(lines[1]).toMatchObject({
      description: "L2 — OYSTER 18W",
      qty: null,
      flagged: true,
    });
    expect(String(lines[1].flagReason)).toContain("set the quantity");
  });

  it("switchboard rows assemble as circuit-scope lines keyed to their board", () => {
    const table: Row = {
      id: "st_b",
      plan_id: "pl1",
      page_index: 3,
      page_sha256: "sha3",
      table_kind: "switchboard",
      board_identifier: "DB-1",
    };
    const row: Row = {
      id: "sr_b1",
      table_id: "st_b",
      row_index: 0,
      status: "accepted",
      cells: {
        circuitRef: { value: "C1", confidence: 0.9 },
        description: { value: "KITCHEN GPOs", confidence: 0.9 },
      },
      human_cells: null,
    };
    const { lines } = ta.assembleLines({ scheduleTables: [table], scheduleRows: [row] });
    expect(lines[0]).toMatchObject({
      sourceType: "schedule-row",
      description: "DB-1 — C1 — KITCHEN GPOs",
      qty: 1,
      unit: "cct",
    });
    expect(lines[0].provenance).toMatchObject({ boardIdentifier: "DB-1", rowId: "sr_b1" });
  });

  it("accepted cable runs assemble per board, ALWAYS labelled estimate", () => {
    const run: Row = {
      id: "cr_1",
      plan_id: "pl1",
      page_index: 0,
      page_sha256: "sha0",
      factors: { routingFactor: 1.15, riseDropMm: 4000, slackFactor: 1.1 },
      accepted_by_label: "boss",
      results: {
        boards: [
          { boardIdentifier: "DB-1", deviceCount: 12, totalMm: 184600 },
          { boardIdentifier: "MSB", deviceCount: 2, totalMm: 40120 },
        ],
      },
    };
    const { lines } = ta.assembleLines({ cableRuns: [run] });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      sourceType: "cable-estimate",
      description: "Cable runs to DB-1 (heuristic estimate)",
      qty: 184.6,
      unit: "m",
      estimate: true,
    });
    expect(lines[0].provenance).toMatchObject({
      cableRunId: "cr_1",
      factors: { routingFactor: 1.15, riseDropMm: 4000, slackFactor: 1.1 },
    });
  });

  it("orders device counts → schedule rows → cable estimates", () => {
    const { lines } = ta.assembleLines({
      acceptedCounts: [count()],
      scheduleTables: [
        {
          id: "st_1",
          plan_id: "pl1",
          page_index: 2,
          page_sha256: "sha2",
          table_kind: "lighting",
          board_identifier: null,
        },
      ],
      scheduleRows: [
        {
          id: "sr_1",
          table_id: "st_1",
          row_index: 0,
          status: "accepted",
          cells: { typeCode: { value: "L1", confidence: 0.9 }, qty: { value: "4", confidence: 1 } },
          human_cells: null,
        },
      ],
      cableRuns: [
        {
          id: "cr_1",
          plan_id: "pl1",
          page_index: 0,
          page_sha256: "sha0",
          factors: {},
          results: { boards: [{ boardIdentifier: "DB-1", deviceCount: 1, totalMm: 1000 }] },
        },
      ],
    });
    expect(lines.map((l: Row) => l.sourceType)).toEqual([
      "device-count",
      "schedule-row",
      "cable-estimate",
    ]);
  });
});
