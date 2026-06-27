import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #365 first increment — the read-only pricing/BOQ workbook import preview.
 * The pure parser + dependency-free .xlsx reader live in api/_lib/boq-import.js
 * (the api/_lib CJS convention); this test imports it the same way the importer
 * tests do. The fixtures mirror the real Sansara REV 5 sheet's shape (a
 * multi-line description cell, a curator-supplied line, a VE line, a PC-sum
 * line, an excluded option, and the two-section lighting/electrical layout).
 */

type Grid = { sheets: Array<{ name: string; rows: string[][] }> };
type Preview = {
  source: { sheetCount: number; sheetNames: string[] };
  sections: Array<{
    key: string;
    lineCount: number;
    computed: number;
    stated: number | null;
    delta: number | null;
    reconciles: boolean | null;
  }>;
  totals: {
    computed: number;
    stated: number | null;
    delta: number | null;
    reconciles: boolean | null;
  };
  lines: Array<{
    section: string;
    code: string | null;
    description: string;
    qty: number;
    supplyAmount: number | null;
    installAmount: number | null;
    lineTotal: number;
    notes: string;
    flags: string[];
  }>;
  ambiguities: Array<{ kind: string; ref: string; message: string }>;
  counts: { lines: number; byFlag: Record<string, number> };
};

const requireFromHere = createRequire(import.meta.url);
const mod = requireFromHere(requireFromHere.resolve("../../../api/_lib/boq-import.js")) as {
  extractXlsxGrid: (buf: Buffer) => Grid;
  parseBoq: (grid: Grid) => Preview;
  parseBoqFromXlsx: (buf: Buffer) => Preview;
};
const { extractXlsxGrid, parseBoq } = mod;

// A grid shaped like the real Sansara REV 5 sheet (lighting + electrical sections).
function sansaraLikeGrid(): Grid {
  return {
    sheets: [
      {
        name: "Sheet1",
        rows: [
          ["PRICING"],
          ["Lighting Tender A supply and install"],
          [
            "item",
            "quantity",
            "Price",
            "Supply subtotal",
            "Install Price",
            "Install subtotal",
            "NOTES",
          ],
          [
            "Supply and install L1.1 - Sasso 40 Trimless\nRemote Dali-2 Driver White",
            "16",
            "275",
            "4400",
            "110",
            "1760",
            "",
          ],
          [
            "Supply and install L5.1 - LIGHTKIT RAIL MICRO",
            "1",
            "3275",
            "",
            "600",
            "600",
            "SUPPLIED BY CURATOR, Switched 240V connection to driver within joinery only",
          ],
          [
            "Supply and install L7.1 - Modular Nyto Pista track",
            "5",
            "433",
            "2165",
            "40",
            "200",
            "REDUCED QUANTITY AS PER VE MEETING ( PREVIOUS QUANTITY 10)",
          ],
          [
            "Supply and install L12 - FOGLIO 2x70W\nPlease confirm suitability",
            "14",
            "695",
            "9730",
            "200",
            "2800",
            "",
          ],
          [
            "Supply and install L6 - B4 EVO track\nlead time 12-14 weeks based on sea freight",
            "1",
            "2560",
            "2560",
            "1200",
            "1200",
            "",
          ],
          ["Supply and install L47 Opt. 1 - Bestlite Floor Lamp", "0", "2620", "", "100", "0", ""],
          ["LIGHTING TOTAL", "", "", "25415"],
          ["Electrical"],
          ["item", "quantity", "price", "sub total", "Notes"],
          ["site establishment", "1", "500", "500", ""],
          ["Dedicated circuit to Hot pool PC SUM Power requirements TBC", "1", "950", "950", ""],
          ["Electrical Total ex GST:", "1450"],
          ["GRAND TOTAL EX GST:", "", "26865"],
        ],
      },
    ],
  };
}

describe("parseBoq — structure + classification", () => {
  const p = parseBoq(sansaraLikeGrid());

  it("parses every priced line and splits the two packages", () => {
    expect(p.counts.lines).toBe(8);
    const lighting = p.sections.find((s) => s.key === "lighting")!;
    const electrical = p.sections.find((s) => s.key === "electrical")!;
    expect(lighting.lineCount).toBe(6);
    expect(electrical.lineCount).toBe(2);
  });

  it("extracts the L-code, quantity and supply/install split", () => {
    const l11 = p.lines.find((l) => l.code === "L1.1")!;
    expect(l11.section).toBe("lighting");
    expect(l11.qty).toBe(16);
    expect(l11.supplyAmount).toBe(4400);
    expect(l11.installAmount).toBe(1760);
    expect(l11.lineTotal).toBe(6160);
  });

  it("keeps a curator-supplied line's blank supply amount null (does not invent a cost)", () => {
    const l51 = p.lines.find((l) => l.code === "L5.1")!;
    expect(l51.supplyAmount).toBeNull();
    expect(l51.installAmount).toBe(600);
    expect(l51.lineTotal).toBe(600);
  });

  it("gives electrical lines no L-code", () => {
    const site = p.lines.find((l) => l.description.startsWith("site establishment"))!;
    expect(site.section).toBe("electrical");
    expect(site.code).toBeNull();
  });
});

describe("parseBoq — commercial reconciliation (the BOQ health check)", () => {
  const p = parseBoq(sansaraLikeGrid());

  it("reconciles computed line sums against the sheet's stated totals", () => {
    const lighting = p.sections.find((s) => s.key === "lighting")!;
    expect(lighting.computed).toBe(25415);
    expect(lighting.stated).toBe(25415);
    expect(lighting.reconciles).toBe(true);
    expect(p.totals.computed).toBe(26865);
    expect(p.totals.reconciles).toBe(true);
  });

  it("flags a mismatch instead of hiding it", () => {
    const grid = sansaraLikeGrid();
    // Tamper with the stated lighting total: the tool must report the delta.
    grid.sheets[0]!.rows[9] = ["LIGHTING TOTAL", "", "", "20000"];
    const tampered = parseBoq(grid);
    const lighting = tampered.sections.find((s) => s.key === "lighting")!;
    expect(lighting.stated).toBe(20000);
    expect(lighting.delta).toBe(5415);
    expect(lighting.reconciles).toBe(false);
  });
});

describe("parseBoq — ambiguity flags (what a human must resolve before it becomes job data)", () => {
  const p = parseBoq(sansaraLikeGrid());

  it("detects supply-by-others, VE, PC-sum, clarification, long-lead and excluded", () => {
    expect(p.counts.byFlag).toEqual({
      supplied_by_others: 1, // L5.1
      value_engineered: 1, // L7.1
      needs_clarification: 2, // L12 + hot pool TBC
      long_lead: 1, // L6
      provisional_sum: 1, // hot pool
      excluded: 1, // L47 Opt 1 (qty 0)
    });
  });

  it("attaches the flags to the right lines", () => {
    expect(p.lines.find((l) => l.code === "L5.1")!.flags).toContain("supplied_by_others");
    expect(p.lines.find((l) => l.code === "L7.1")!.flags).toContain("value_engineered");
    expect(p.lines.find((l) => l.code === "L12")!.flags).toContain("needs_clarification");
    const excluded = p.lines.find((l) => l.flags.includes("excluded"))!;
    expect(excluded.qty).toBe(0);
    expect(excluded.code).toContain("L47");
  });

  it("every ambiguity carries a human-readable message", () => {
    expect(p.ambiguities.length).toBe(7);
    for (const a of p.ambiguities) expect(a.message.length).toBeGreaterThan(0);
  });
});

// ── full pipeline: a hand-built (stored) .xlsx → grid, exercising the
//    dependency-free ZIP + shared-string + worksheet reader ───────────────────
function makeXlsx(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(0, 14); // crc (reader ignores)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 10); // method: stored
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

describe("extractXlsxGrid — dependency-free .xlsx reader", () => {
  it("reads sheet names, shared strings, numbers and multi-line cells", () => {
    const xlsx = makeXlsx({
      "xl/workbook.xml": `<?xml version="1.0"?><workbook><sheets><sheet name="Pricing" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/sharedStrings.xml": `<sst><si><t>item</t></si><si><t>quantity</t></si><si><t>Hello &amp; World</t></si><si><t xml:space="preserve">Multi\nLine</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="s"><v>3</v></c></row></sheetData></worksheet>`,
    });
    const grid = extractXlsxGrid(xlsx);
    expect(grid.sheets).toHaveLength(1);
    const sheet = grid.sheets[0]!;
    const row1 = sheet.rows[1]!;
    expect(sheet.name).toBe("Pricing");
    expect(sheet.rows[0]).toEqual(["item", "quantity"]);
    expect(row1[0]).toBe("Hello & World");
    expect(row1[1]).toBe("42");
    expect(row1[2]).toContain("\n"); // multi-line cell preserved
  });

  it("throws a clear error on a non-zip buffer", () => {
    expect(() => extractXlsxGrid(Buffer.from("not a zip"))).toThrow(/zip|xlsx/i);
  });
});
