'use strict';

// PDF text-layer extraction for supplier invoices, over `unpdf` (a repo
// dependency; pdf.js under the hood, no native binaries). Text items are
// re-assembled into LINES by their y position and ordered by x, so a printed
// "Job Number:   IV0041" comes out as one line even when the PDF drew the
// label and value as separate runs — the property the rule parser relies on.
//
// Scanned (image-only) PDFs have no text layer: hasTextLayer is false and the
// caller routes the document to manual entry. No OCR is attempted — the repo
// has no PDF OCR and this feature adds no new paid dependency.
//
// unpdf is loaded lazily (dynamic import) so requiring this module costs
// nothing on paths that never touch a PDF.

const { withTimeout } = require('../with-timeout');

const MAX_PAGES = 40;
const DEFAULT_TIMEOUT_MS = 25_000;
const Y_TOLERANCE = 2.5;
const COLUMN_GAP = 12; // horizontal gap (PDF units) that reads as a column break

let _unpdf = null;
async function unpdf() {
  if (!_unpdf) _unpdf = await import('unpdf');
  return _unpdf;
}

/** Group text items into lines. Exported for tests. Pure. */
function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    const str = typeof it.str === 'string' ? it.str : '';
    if (!str.trim()) continue;
    const x = Array.isArray(it.transform) ? it.transform[4] : 0;
    const y = Array.isArray(it.transform) ? it.transform[5] : 0;
    const w = typeof it.width === 'number' ? it.width : 0;
    let row = rows.find((r) => Math.abs(r.y - y) <= Y_TOLERANCE);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, w, str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    let line = '';
    let cursor = null;
    for (const it of row.items) {
      if (cursor != null) line += it.x - cursor > COLUMN_GAP ? '   ' : ' ';
      line += it.str;
      cursor = it.x + it.w;
    }
    return line.replace(/[ \t]+$/g, '');
  });
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ text: string, pageCount: number, pagesRead: number, hasTextLayer: boolean }>}
 */
async function extractPdfText(bytes, opts = {}) {
  const run = async () => {
    const { getDocumentProxy } = await unpdf();
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const pageCount = pdf.numPages;
    const pagesRead = Math.min(pageCount, MAX_PAGES);
    const pages = [];
    for (let n = 1; n <= pagesRead; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(itemsToLines(content.items || []).join('\n'));
    }
    const text = pages.join('\n\f\n');
    const glyphs = text.replace(/\s+/g, '').length;
    return { text, pageCount, pagesRead, hasTextLayer: glyphs >= 40 };
  };
  return withTimeout(run(), opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'pdf text extraction');
}

module.exports = { extractPdfText, itemsToLines, MAX_PAGES };
