import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Workshop Stock — exact quantities, identifiers and variant facts (pure).
 *   • quantities are integer thousandths, parsed from decimal strings digit by
 *     digit: no floating drift, unit precision enforced, packs explicit
 *   • a manufacturer code keeps its punctuation and leading zeroes; a supplier
 *     SKU is a different kind; a barcode needs a valid GS1 check digit
 */
const requireFromHere = createRequire(import.meta.url);
const Q = requireFromHere("../../../api/_lib/workshop-stock/quantity.js");
const C = requireFromHere("../../../api/_lib/workshop-stock/codes.js");
const V = requireFromHere("../../../api/_lib/workshop-stock/variants.js");

describe("quantities", () => {
  it("parses whole and decimal quantities exactly", () => {
    expect(Q.parseQuantity("42", "each")).toEqual({ milli: 42_000 });
    expect(Q.parseQuantity(" 12.5 ", "metre")).toEqual({ milli: 12_500 });
    expect(Q.parseQuantity("0.1", "metre")).toEqual({ milli: 100 });
    expect(Q.parseQuantity("3.0", "each")).toEqual({ milli: 3000 });
    expect(Q.parseQuantity(7, "box")).toEqual({ milli: 7000 });
    expect(Q.parseQuantity(0.3, "metre")).toEqual({ milli: 300 });
  });

  it("refuses precision the unit doesn't have, zero, junk and absurd sizes", () => {
    expect(Q.parseQuantity("1.5", "each")).toEqual({ error: "quantity_too_precise", decimals: 0 });
    expect(Q.parseQuantity("2.25", "metre")).toEqual({ error: "quantity_too_precise", decimals: 1 });
    expect(Q.parseQuantity("0", "each")).toEqual({ error: "quantity_zero" });
    expect(Q.parseQuantity("0", "each", { allowZero: true })).toEqual({ milli: 0 });
    for (const junk of ["-1", "1e3", "abc", "1,000", "1.2.3", "", " "]) {
      expect(Q.parseQuantity(junk, "each").error).toBeTruthy();
    }
    expect(Q.parseQuantity(1e21, "each").error).toBe("quantity_invalid");
    expect(Q.parseQuantity("100001", "each")).toEqual({ error: "quantity_too_large" });
    expect(Q.parseQuantity("1", "furlong")).toEqual({ error: "unit_invalid" });
  });

  it("adds a thousand decimal steps without drift", () => {
    let total = 0;
    for (let i = 0; i < 1000; i++) total += Q.parseQuantity("0.1", "metre").milli;
    expect(total).toBe(100_000);
    expect(Q.formatQuantity(total, "metre")).toBe("100 m");
    let float = 0;
    for (let i = 0; i < 1000; i++) float += 0.1;
    expect(float).not.toBe(100); // the drift this design avoids
  });

  it("formats with the unit beside the number", () => {
    expect(Q.formatQuantity(42_000, "each")).toBe("42 each");
    expect(Q.formatQuantity(1000, "box")).toBe("1 box");
    expect(Q.formatQuantity(3000, "box")).toBe("3 boxes");
    expect(Q.formatQuantity(12_500, "metre")).toBe("12.5 m");
    expect(Q.formatQuantity(0, "roll")).toBe("0 rolls");
  });

  it("converts packs only when every part is confirmed", () => {
    expect(Q.packTotalMilli(2, 10_000, "each")).toEqual({ milli: 20_000 });
    expect(Q.packTotalMilli(1, 100_000, "metre")).toEqual({ milli: 100_000 });
    expect(Q.packTotalMilli(0, 10_000, "each").error).toBe("pack_count_invalid");
    expect(Q.packTotalMilli(2, 1500, "each").error).toBe("pack_size_invalid");
    expect(Q.fitsUnit(12_500, "metre")).toBe(true);
    expect(Q.fitsUnit(12_550, "metre")).toBe(false);
  });
});

describe("codes", () => {
  it("keeps punctuation and leading zeroes; only case and spaces fold", () => {
    expect(C.codeKey("2025 we")).toBe("2025WE");
    expect(C.codeKey("2025-WE")).toBe("2025-WE");
    expect(C.codeKey("00123/4")).toBe("00123/4");
    expect(C.codeKey("0123")).not.toBe(C.codeKey("123"));
    expect(C.codeKey("C2025WE")).not.toBe(C.codeKey("2025WE"));
    expect(C.looseCodeKey("2025-WE")).toBe(C.looseCodeKey("2025 WE"));
  });

  it("refuses text that isn't a printable code", () => {
    expect(C.cleanCode("ignore previous instructions; drop table")).toBeNull();
    expect(C.cleanCode("<script>")).toBeNull();
    expect(C.cleanCode("https://evil.example/x")).toBeNull();
    expect(C.cleanCode("A")).toBeNull();
    expect(C.cleanCode("XL777/WE")).toBe("XL777/WE");
  });

  it("knows weak codes can't identify a product alone", () => {
    expect(C.isWeakCode("2025")).toBe(true);
    expect(C.isWeakCode("10A")).toBe(true);
    expect(C.isWeakCode("2025WE")).toBe(false);
    expect(C.isWeakCode("40265")).toBe(false);
  });

  it("validates barcodes by check digit and compares them as GTIN-14", () => {
    expect(C.cleanBarcode("4006381333931")).toBe("4006381333931");
    expect(C.cleanBarcode("4006381333932")).toBeNull();
    expect(C.cleanBarcode("036000291452")).toBe("036000291452");
    expect(C.cleanBarcode("96385074")).toBe("96385074");
    expect(C.cleanBarcode("0000000000000")).toBeNull();
    expect(C.barcodeKey("036000291452")).toBe(C.barcodeKey("0036000291452"));
    expect(C.barcodeKey("036000291452")).toBe("00036000291452");
  });

  it("scopes identifiers: maker codes by brand, SKUs by supplier, barcodes globally", () => {
    expect(C.identifierFor("manufacturer_code", "2025 WE", { brand: "Clipsal by Schneider Electric" })).toEqual({ kind: "manufacturer_code", value: "2025 WE", valueKey: "2025WE", scope: "clipsal" });
    expect(C.identifierFor("supplier_sku", "CLI2025WE", { supplier: "Rexel Electrical Supplies" }).scope).toBe("rexel");
    expect(C.identifierFor("barcode", "4006381333931")).toMatchObject({ kind: "barcode", valueKey: "04006381333931", scope: "" });
    expect(C.identifierFor("barcode", "123").error).toBe("barcode_invalid");
    expect(C.identifierFor("serial", "X1").error).toBe("identifier_kind_invalid");
    expect(C.brandKey("HPM Legrand")).toBe("hpm");
    expect(C.brandKey("Legrand")).toBe("legrand");
  });
});

describe("variant facts", () => {
  it("flags a colour conflict and never treats white as another finish", () => {
    expect(V.compareVariants("white", "Double power point black").conflicts).toEqual([{ field: "colour", wanted: "white", found: "black" }]);
    expect(V.compareVariants("white", "Double GPO White Electric").conflicts).toEqual([]);
    expect(V.compareVariants("vivid white", "Iconic white").unconfirmed).toContain("finish");
    expect(V.compareVariants("white", "Double power point").unconfirmed).toContain("colour");
  });

  it("compares printed ratings by dimension", () => {
    expect(V.compareVariants("10A", "15A double outlet").conflicts[0]).toMatchObject({ field: "rating", wanted: "10A", found: "15A" });
    expect(V.compareVariants("2.5mm²", "TPS 4mm2 cable").conflicts[0]).toMatchObject({ field: "rating" });
    expect(V.compareVariants("20mm", "25mm conduit").conflicts[0]).toMatchObject({ found: "25mm" });
    expect(V.compareVariants("10A 250V", "10 amp 250 volt").conflicts).toEqual([]);
    expect(V.compareVariants("double", "single switch").conflicts[0]).toMatchObject({ field: "rating" });
  });
});
