import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

const requireFromHere = createRequire(import.meta.url);
const { extractPdfText, itemsToLines } = requireFromHere("../../../api/_lib/invoices/pdf-text.js");
const { extractInvoiceFromText } = requireFromHere("../../../api/_lib/invoices/extract.js");

/** A real (tiny) PDF built with pdf-lib, read back through unpdf/pdf.js. */
async function buildPdf(lines: Array<[string, number, number]>): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [text, x, y] of lines) page.drawText(text, { x, y, size: 11, font });
  return Buffer.from(await doc.save());
}

describe("pdf-text — real PDF round trip", () => {
  it("re-assembles label/value runs into one line and the rule parser reads it", async () => {
    const bytes = await buildPdf([
      ["Sparky Supplies Pty Ltd", 40, 800],
      ["TAX INVOICE", 40, 780],
      ["Tax Invoice No:", 40, 760], ["SS-88123", 200, 760],
      ["Invoice Date:", 40, 740], ["03/09/2026", 200, 740],
      ["Job Number:", 40, 720], ["IV 0041", 200, 720],
      ["Sub Total", 300, 300], ["1,080.00", 480, 300],
      ["GST", 300, 280], ["108.00", 480, 280],
      ["Total (inc GST)", 300, 260], ["1,188.00", 480, 260],
    ]);
    const r = await extractPdfText(bytes);
    expect(r.pageCount).toBe(1);
    expect(r.hasTextLayer).toBe(true);
    expect(r.text).toContain("Job Number:   IV 0041");
    const e = extractInvoiceFromText(r.text);
    expect(e).toMatchObject({ documentType: "tax_invoice", supplierInvoiceNumber: "SS-88123", invoiceDate: "2026-09-03", subtotalCents: 108000, gstCents: 10800, totalCents: 118800, totalsConsistent: true });
    expect(e.ivSelection).toMatchObject({ normalised: "IV0041", label: "Job Number" });
  }, 30_000);

  it("reports no text layer for an empty (image-only) PDF", async () => {
    const bytes = await buildPdf([]);
    const r = await extractPdfText(bytes);
    expect(r.hasTextLayer).toBe(false);
  }, 30_000);

  it("rejects a malformed PDF with an error rather than hanging", async () => {
    await expect(extractPdfText(Buffer.from("%PDF-1.4 but nothing else"))).rejects.toBeTruthy();
  }, 30_000);
});

describe("itemsToLines", () => {
  it("groups by y, orders by x and marks column gaps", () => {
    const lines = itemsToLines([
      { str: "IV0041", transform: [1, 0, 0, 1, 200, 700], width: 40 },
      { str: "Job Number:", transform: [1, 0, 0, 1, 40, 700.5], width: 70 },
      { str: "Sub Total", transform: [1, 0, 0, 1, 40, 600], width: 50 },
      { str: "   ", transform: [1, 0, 0, 1, 90, 600], width: 5 },
    ]);
    expect(lines).toEqual(["Job Number:   IV0041", "Sub Total"]);
  });
});
