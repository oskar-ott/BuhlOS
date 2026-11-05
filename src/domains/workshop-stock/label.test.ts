import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ean13Modules, ean13Valid, labelSize, layoutLabel, LABEL_SIZES, wrapText } from "./label";

const requireFromHere = createRequire(import.meta.url);
const codes = requireFromHere("../../../api/_lib/workshop-stock/codes.js") as {
  inStoreBarcode: (random?: () => number) => string;
  isInStoreBarcode: (v: string) => boolean;
  cleanBarcode: (v: string) => string | null;
};

// EAN-13 digit patterns, to read the bars back (L, G and R sets)
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** Decode 95 modules back to the 13 digits — what a scanner does. */
function decode(m: string): string {
  const left = [0, 1, 2, 3, 4, 5].map((i) => m.slice(3 + i * 7, 10 + i * 7));
  const right = [0, 1, 2, 3, 4, 5].map((i) => m.slice(50 + i * 7, 57 + i * 7));
  const parity = left.map((p) => (L.includes(p) ? "L" : "G")).join("");
  const first = PARITY.indexOf(parity);
  return String(first) + left.map((p) => (L.includes(p) ? L.indexOf(p) : G.indexOf(p))).join("") + right.map((p) => R.indexOf(p)).join("");
}

describe("NIIMBOT barcode labels (2026-11-03)", () => {
  it("our own barcodes are valid EAN-13s in the in-store range, never a real product's", () => {
    let n = 0;
    const seq = () => ((n = (n + 7) % 10) / 10);
    for (let i = 0; i < 20; i++) {
      const b = codes.inStoreBarcode(seq);
      expect(b).toMatch(/^21\d{11}$/);
      expect(codes.cleanBarcode(b)).toBe(b);
      expect(ean13Valid(b)).toBe(true);
      expect(codes.isInStoreBarcode(b)).toBe(true);
    }
    expect(codes.isInStoreBarcode("9338475023035")).toBe(false); // the scanned real product
  });

  it("the bars read back as the same code (guards, centre, 95 modules)", () => {
    for (const code of ["9338475023035", "4006381333931", "2112345678900".slice(0, 12) + "0"]) {
      const valid = ean13Valid(code) ? code : null;
      if (!valid) continue;
      const m = ean13Modules(valid)!;
      expect(m).toHaveLength(95);
      expect(m.slice(0, 3)).toBe("101");
      expect(m.slice(45, 50)).toBe("01010");
      expect(m.slice(92)).toBe("101");
      expect(decode(m)).toBe(valid);
    }
    expect(ean13Modules("9338475023036")).toBeNull(); // wrong check digit
    expect(ean13Modules("abc")).toBeNull();
  });

  it("every label size fits the bars in whole dots, at least 2 per module, with room for the name and digits", () => {
    for (const s of LABEL_SIZES) {
      const l = layoutLabel(s, "Clipsal Iconic 2 gang switch plate vivid white", "Shelf A2, Bin 4");
      expect(l.module).toBeGreaterThanOrEqual(2);
      expect(l.barsX).toBeGreaterThanOrEqual(0);
      expect(l.barsX + 95 * l.module).toBeLessThanOrEqual(l.width);
      expect(l.barsY + l.barsHeight + l.digitsSize).toBeLessThanOrEqual(l.height);
      expect(l.nameLines.length).toBeGreaterThan(0);
    }
    expect(labelSize("nope").key).toBe(LABEL_SIZES[0]!.key);
  });

  it("long names wrap to the lines there are, and say they were cut", () => {
    expect(wrapText("Clipsal Iconic 2 gang switch plate vivid white", 20, 2)).toEqual(["Clipsal Iconic 2", "gang switch plate…"]);
    expect(wrapText("Short", 20, 1)).toEqual(["Short"]);
  });
});
