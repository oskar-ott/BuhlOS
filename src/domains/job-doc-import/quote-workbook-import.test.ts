import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkbookParseSchema } from "./schema";

/**
 * #365 — the quote-workbook parser + named health checks, driven by the
 * COMMITTED 100-Arthur-shaped fixture workbook
 * (fixtures/100-arthur-boq.xlsx, built by fixtures/build-100-arthur-fixture.mjs).
 *
 * The fixture reproduces the real failure modes the issue pins:
 *   - the ZIP-circuit qty×rate ≠ subtotal (2 × $450 stated as $1,400)
 *   - a live #REF! formula error
 *   - the header-total reconciliation failure ($46,034 stated vs
 *     $28,820 + $12,730 section totals)
 *   - "Alternative"-marked PL3 pendants counted in the base section total
 * plus a subtotal-without-inputs allowance and a hardcoded-among-formulas cell.
 */

type Parse = ReturnType<typeof WorkbookParseSchema.parse>;

const requireFromHere = createRequire(import.meta.url);
const mod = requireFromHere(requireFromHere.resolve("../../../api/_lib/boq-import.js")) as {
  parseQuoteWorkbookFromXlsx: (buf: Buffer) => unknown;
  parseQuoteWorkbook: (grid: unknown) => unknown;
  QUOTE_LINE_CLASSIFICATIONS: string[];
};

const fixturePath = join(__dirname, "fixtures", "100-arthur-boq.xlsx");

function parseFixture(): Parse {
  const raw = mod.parseQuoteWorkbookFromXlsx(readFileSync(fixturePath));
  // The wire schema is the contract the UI parses against — the parser output
  // must satisfy it exactly.
  return WorkbookParseSchema.parse(raw);
}

describe("parseQuoteWorkbook — the committed 100-Arthur fixture", () => {
  const p = parseFixture();

  it("extracts every priced line with sheet/cell provenance", () => {
    expect(p.counts.lines).toBe(9);
    const zip = p.lines.find((l) => /ZIP circuit/.test(l.description));
    expect(zip).toBeTruthy();
    expect(zip?.sheet).toBe("BOQ");
    expect(zip?.row).toBe(6);
    expect(zip?.cells.subtotal).toBe("BOQ!E6");
    expect(zip?.cells.qty).toBe("BOQ!B6");
    expect(zip?.qty).toBe(2);
    expect(zip?.unit).toBe("ea");
    expect(zip?.rate).toBe(450);
    expect(zip?.subtotal).toBe(1400);
    expect(zip?.section).toBe("East Gym");
  });

  it("catches the ZIP-circuit qty×rate ≠ subtotal as a named finding on the cell", () => {
    const f = p.findings.find((x) => x.kind === "qty_rate_mismatch");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("error");
    expect(f?.cellRef).toBe("BOQ!E6");
    expect(f?.message).toContain("2 × 450 = 900");
  });

  it("catches the #REF! formula error with its cell reference", () => {
    const f = p.findings.find((x) => x.kind === "formula_error");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("error");
    expect(f?.cellRef).toBe("BOQ!E10");
    expect(f?.message).toContain("#REF!");
  });

  it("catches the header-total reconciliation failure ($46,034 vs $28,820 + $12,730)", () => {
    expect(p.statedTotal).toEqual({ value: 46034, cellRef: "BOQ!E2" });
    const east = p.sections.find((s) => s.name === "East Gym");
    const upper = p.sections.find((s) => s.name === "Upper Ground");
    expect(east?.stated).toBe(28820);
    expect(upper?.stated).toBe(12730);
    const f = p.findings.find((x) => x.kind === "total_mismatch");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("error");
    expect(f?.cellRef).toBe("BOQ!E2");
    expect(f?.message).toContain("41550");
    expect(f?.message).toContain("46034");
  });

  it("flags the Alternative-marked pendants counted in the base section total", () => {
    const pl3 = p.lines.find((l) => /PL3 pendants/.test(l.description));
    expect(pl3?.classification).toBe("alternate");
    const f = p.findings.find((x) => x.kind === "alternate_counted_in_base");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("error");
    expect(f?.cellRef).toBe("BOQ!E9");
  });

  it("flags a subtotal that has no qty/rate behind it", () => {
    const f = p.findings.find((x) => x.kind === "subtotal_missing_inputs");
    expect(f?.cellRef).toBe("BOQ!E18");
    expect(f?.severity).toBe("warning");
  });

  it("flags the hardcoded subtotal among formula siblings (and only that one)", () => {
    const hard = p.findings.filter((x) => x.kind === "hardcoded_value");
    expect(hard.map((f) => f.cellRef)).toEqual(["BOQ!E6"]);
    expect(hard[0]?.severity).toBe("warning");
  });

  it("defaults classifications by detection: by-others and PC/allowance lines", () => {
    const data = p.lines.find((l) => /Data cabling/.test(l.description));
    expect(data?.classification).toBe("by_others");
    const allowance = p.lines.find((l) => /allowance/i.test(l.description));
    expect(allowance?.classification).toBe("pc_sum");
  });

  it("never counts alternates (or exclusions/PC/by-others) in the base total", () => {
    expect(p.totals.all).toBe(41550);
    expect(p.totals.base).toBe(36400); // all − 2920 alt − 1730 by-others − 500 PC
    expect(p.totals.byClassification.alternate).toBe(2920);
    expect(p.totals.byClassification.by_others).toBe(1730);
    expect(p.totals.byClassification.pc_sum).toBe(500);
  });

  it("gives every finding a stable id and every line a deterministic id", () => {
    const ids = p.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(p.lines.map((l) => l.id)).toContain("wl_1_6");
    // Same bytes → same ids (re-upload of an identical workbook is stable).
    const again = parseFixture();
    expect(again.findings.map((f) => f.id)).toEqual(ids);
  });
});

describe("parseQuoteWorkbook — detection defaults on synthetic grids", () => {
  const cell = (ref: string, v: string | number, extra?: { f?: boolean; err?: string }) => ({
    ref,
    v: String(v),
    f: extra?.f ?? false,
    err: extra?.err ?? null,
  });

  function grid(rows: Array<{ rowNum: number; cells: ReturnType<typeof cell>[] }>) {
    return { sheets: [{ name: "S", rows }] };
  }

  const header = (rowNum: number) => ({
    rowNum,
    cells: [
      cell(`A${rowNum}`, "Description"),
      cell(`B${rowNum}`, "Qty"),
      cell(`C${rowNum}`, "Unit"),
      cell(`D${rowNum}`, "Rate"),
      cell(`E${rowNum}`, "Amount"),
    ],
  });

  it("qty 0 → exclusion; 'excluded' text → exclusion", () => {
    const p = WorkbookParseSchema.parse(
      mod.parseQuoteWorkbook(
        grid([
          header(1),
          { rowNum: 2, cells: [cell("A2", "Optional sauna feed"), cell("B2", 0), cell("C2", "ea"), cell("D2", 500), cell("E2", 0)] },
          { rowNum: 3, cells: [cell("A3", "Generator — excluded"), cell("B3", 1), cell("C3", "ea"), cell("D3", 900), cell("E3", 900)] },
        ])
      )
    );
    expect(p.lines[0]?.classification).toBe("exclusion");
    expect(p.lines[1]?.classification).toBe("exclusion");
  });

  it("plain lines default to base and a PC sum is detected", () => {
    const p = WorkbookParseSchema.parse(
      mod.parseQuoteWorkbook(
        grid([
          header(1),
          { rowNum: 2, cells: [cell("A2", "GPO double outlets"), cell("B2", 10), cell("C2", "ea"), cell("D2", 85), cell("E2", 850)] },
          { rowNum: 3, cells: [cell("A3", "PC sum — feature lighting"), cell("B3", 1), cell("C3", "lot"), cell("D3", 5000), cell("E3", 5000)] },
        ])
      )
    );
    expect(p.lines[0]?.classification).toBe("base");
    expect(p.lines[1]?.classification).toBe("pc_sum");
    expect(p.totals.base).toBe(850);
  });

  it("a workbook with no BOQ table yields zero lines (never invented rows)", () => {
    const p = WorkbookParseSchema.parse(
      mod.parseQuoteWorkbook(
        grid([{ rowNum: 1, cells: [cell("A1", "Just a cover sheet")] }])
      )
    );
    expect(p.counts.lines).toBe(0);
    expect(p.findings).toEqual([]);
  });

  it("tolerates rounding: qty×rate within a cent-per-unit is NOT a mismatch", () => {
    const p = WorkbookParseSchema.parse(
      mod.parseQuoteWorkbook(
        grid([
          header(1),
          // 3 × 33.333 = 99.999 stated as 100.00 — rounding, not an error.
          { rowNum: 2, cells: [cell("A2", "Cable per metre"), cell("B2", 3), cell("C2", "m"), cell("D2", "33.333"), cell("E2", 100)] },
        ])
      )
    );
    expect(p.findings.filter((f) => f.kind === "qty_rate_mismatch")).toEqual([]);
  });
});
