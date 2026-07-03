import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #212 — the pure cross-sheet linking helpers (api/_lib/entity-links.js):
 * identifier normalisation, exact-match proposals with rejection stickiness,
 * live reference resolution, and the duplicate-count warning derivation.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS module under test
const el: any = requireFromHere("../../../api/_lib/entity-links.js");

type Row = Record<string, unknown>;

describe("normaliseIdentifier (#212)", () => {
  it("canonicalises case, spacing and unicode dashes for exact matching", () => {
    expect(el.normaliseIdentifier("db-1")).toBe("DB-1");
    expect(el.normaliseIdentifier("DB – 1")).toBe("DB-1");
    expect(el.normaliseIdentifier("  MSB  ")).toBe("MSB");
    expect(el.normaliseIdentifier("DB  1")).toBe("DB 1"); // spacing collapses, no dash invented
  });
});

describe("boardSightings + proposeBoardLinks (#212)", () => {
  const table = (board: string, planId: string, pageIndex: number): Row => ({
    board_identifier: board,
    plan_id: planId,
    page_index: pageIndex,
  });
  const pin = (board: string, planId: string, pageIndex: number): Row => ({
    board_identifier: board,
    plan_id: planId,
    page_index: pageIndex,
  });

  it("proposes one link per identifier per page pair — exact matches only", () => {
    const sightings = el.boardSightings(
      [table("DB-1", "pl1", 2), table("DB-2", "pl1", 2)],
      [pin("db-1", "pl1", 0), pin("DB-1", "pl2", 0)],
    );
    const proposals = el.proposeBoardLinks(sightings, []);
    // DB-1 on three pages → 3 pairs; DB-2 on one page → none
    expect(proposals).toHaveLength(3);
    expect(proposals.every((p: Row) => p.kind === "same-board")).toBe(true);
    expect(proposals.every((p: Row) => p.identifier === "DB-1")).toBe(true);
    const pair = proposals.find(
      (p: Row) => p.aPlanId === "pl1" && p.aPageIndex === 0 && p.bPlanId === "pl1",
    );
    expect(pair).toMatchObject({ bPageIndex: 2, confidence: 0.9 });
    expect(String(pair?.evidence)).toContain("match exactly");
  });

  it("same identifier on the SAME page never proposes; existing links (incl. rejected) suppress re-proposal", () => {
    const sightings = el.boardSightings(
      [table("DB-1", "pl1", 0)],
      [pin("DB-1", "pl1", 0), pin("DB-1", "pl2", 0)],
    );
    const existing = [
      {
        kind: "same-board",
        identifier: "DB-1",
        a_plan_id: "pl1",
        a_page_index: 0,
        b_plan_id: "pl2",
        b_page_index: 0,
        status: "rejected",
      },
    ];
    expect(el.proposeBoardLinks(sightings, existing)).toHaveLength(0);
  });
});

describe("resolveRefs (#212)", () => {
  const ref = (target: string, planId = "pl1", pageIndex = 0): Row => ({
    plan_id: planId,
    page_index: pageIndex,
    target_sheet_number: target,
  });

  it("resolves against effective sheet numbers; unresolved stays null; self-refs don't count", () => {
    const sheets = [
      { planId: "pl1", pageIndex: 0, sheetNumber: "E-101" },
      { planId: "pl1", pageIndex: 4, sheetNumber: "E-501" },
    ];
    const out = el.resolveRefs(
      [ref("E-501"), ref("E-999"), ref("E-101" /* self */)],
      sheets,
    );
    expect(out[0]?.resolved).toEqual({ planId: "pl1", pageIndex: 4 });
    expect(out[1]?.resolved).toBeNull();
    expect(out[2]?.resolved).toBeNull(); // its own page is not a resolution
  });

  it("matches case-insensitively via normalisation", () => {
    const out = el.resolveRefs(
      [ref("e-501")],
      [{ planId: "pl2", pageIndex: 1, sheetNumber: "E-501" }],
    );
    expect(out[0]?.resolved).toEqual({ planId: "pl2", pageIndex: 1 });
  });
});

describe("duplicateCountWarnings (#212)", () => {
  const link = (status: string): Row => ({
    status,
    identifier: "DB-1",
    a_plan_id: "pl1",
    a_page_index: 0,
    b_plan_id: "pl2",
    b_page_index: 0,
  });

  it("warns BOTH sides when both pages carry accepted counts — proposed already warns", () => {
    const counted = new Set(["pl1:0", "pl2:0"]);
    const warnings = el.duplicateCountWarnings([link("proposed")], counted);
    expect(warnings.get("pl1:0")).toEqual([
      { otherPlanId: "pl2", otherPageIndex: 0, identifier: "DB-1", status: "proposed" },
    ]);
    expect(warnings.get("pl2:0")).toHaveLength(1);
  });

  it("no warning when only one side is counted, or the link was rejected", () => {
    expect(el.duplicateCountWarnings([link("proposed")], new Set(["pl1:0"])).size).toBe(0);
    expect(
      el.duplicateCountWarnings([link("rejected")], new Set(["pl1:0", "pl2:0"])).size,
    ).toBe(0);
  });
});
