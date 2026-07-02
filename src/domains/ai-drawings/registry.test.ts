import { describe, expect, it } from "vitest";
import {
  buildRegistryRows,
  filterRegistryRows,
  naturalCompare,
  type RegistrySourcePlan,
} from "./registry";
import type { EffectiveSheet } from "./schema";

/**
 * #199 — sheet-registry projection: rows from effective sheets + plans,
 * natural sheet-number ordering, honest handling of missing pages/docs,
 * substring search + type filter. Pure logic — the API/server side is
 * covered in ai-drawings-api.test.ts.
 */

function field(effective: string | null, corrected = false) {
  return {
    ai: { value: effective, confidence: 0.9 },
    override: corrected
      ? { value: effective, correctedBy: "boss", correctedAt: "2026-07-03T00:00:00.000Z" }
      : null,
    effective,
  };
}

function sheet(
  planId: string,
  pageIndex: number,
  over: {
    number?: string | null;
    title?: string | null;
    type?: string | null;
    needsReview?: boolean;
    correctedField?: boolean;
  } = {},
): EffectiveSheet {
  return {
    planId,
    pageIndex,
    pageSha256: `sha-${planId}-${pageIndex}`,
    model: "claude-opus-4-8",
    promptVersion: "pu-v1",
    updatedAt: "2026-07-03T00:00:00.000Z",
    fields: {
      sheetType: field(over.type === undefined ? "floorPlan" : over.type),
      sheetNumber: field(over.number === undefined ? null : over.number, over.correctedField),
      sheetTitle: field(over.title === undefined ? null : over.title),
      revision: field("C"),
      scale: field("1:100"),
    },
    needsReview: over.needsReview ?? false,
  } as EffectiveSheet;
}

const PLANS: RegistrySourcePlan[] = [
  {
    id: "pl1",
    label: "E-SET · Rev C",
    status: "current",
    pages: [
      { pageIndex: 0, pngUrl: "https://blob/pl1-0.png" },
      { pageIndex: 1, pngUrl: "https://blob/pl1-1.png" },
    ],
  },
  { id: "pl2", label: "A-SET", status: "superseded", pages: [{ pageIndex: 0, pngUrl: "https://blob/pl2-0.png" }] },
];

describe("naturalCompare", () => {
  it("sorts digit runs numerically (E-2 before E-10)", () => {
    expect(naturalCompare("E-2", "E-10")).toBeLessThan(0);
    expect(["E-10", "E-2", "E-1"].sort(naturalCompare)).toEqual(["E-1", "E-2", "E-10"]);
  });
});

describe("buildRegistryRows", () => {
  it("orders numbered sheets naturally, unnumbered after, and resolves page links", () => {
    const rows = buildRegistryRows(
      [
        sheet("pl1", 1, { number: "E-10" }),
        sheet("pl2", 0, { number: null, title: "UNNUMBERED" }),
        sheet("pl1", 0, { number: "E-2" }),
      ],
      PLANS,
    );
    expect(rows.map((r) => r.sheetNumber)).toEqual(["E-2", "E-10", null]);
    expect(rows[0]?.pngUrl).toBe("https://blob/pl1-0.png");
    expect(rows[0]?.docLabel).toBe("E-SET · Rev C");
    expect(rows[2]?.docStatus).toBe("superseded");
  });

  it("marks corrected rows and never invents a label for a missing document", () => {
    const rows = buildRegistryRows(
      [sheet("ghost", 0, { number: "E-1", correctedField: true })],
      PLANS,
    );
    expect(rows[0]?.corrected).toBe(true);
    expect(rows[0]?.pngUrl).toBe(null);
    expect(rows[0]?.docLabel).toBe("(document no longer on this job)");
  });
});

describe("filterRegistryRows", () => {
  const rows = buildRegistryRows(
    [
      sheet("pl1", 0, { number: "E-101", title: "LEVEL 1 POWER", type: "floorPlan" }),
      sheet("pl1", 1, { number: "E-601", title: "SWITCHBOARD SCHEDULE", type: "schedule" }),
      sheet("pl2", 0, { number: null, title: null, type: "legend", needsReview: true }),
    ],
    PLANS,
  );

  it("searches number, title and document label case-insensitively", () => {
    expect(filterRegistryRows(rows, "e-101", "all")).toHaveLength(1);
    expect(filterRegistryRows(rows, "power", "all")).toHaveLength(1);
    expect(filterRegistryRows(rows, "a-set", "all")).toHaveLength(1);
    expect(filterRegistryRows(rows, "zzz", "all")).toHaveLength(0);
  });

  it("filters by sheet type, composing with the query", () => {
    expect(filterRegistryRows(rows, "", "schedule")).toHaveLength(1);
    expect(filterRegistryRows(rows, "switchboard", "schedule")).toHaveLength(1);
    expect(filterRegistryRows(rows, "switchboard", "legend")).toHaveLength(0);
  });

  it("keeps null-field rows reachable (empty query, type filter)", () => {
    const legends = filterRegistryRows(rows, "", "legend");
    expect(legends).toHaveLength(1);
    expect(legends[0]?.needsReview).toBe(true);
  });
});
