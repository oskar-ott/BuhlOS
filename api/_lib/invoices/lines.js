'use strict';

// Line items from a supplier invoice's text (owner pull 2026-09-24: "when an
// invoice comes in a lot of detail is pulled, not just invoice number and
// total"). Pure. The PDF text layer arrives one visual row per line with
// columns separated by three-plus spaces (pdf-text.js), so an item row is:
//   [qty] [unit] [code] description … [unit price] line-total
// Rules, not guesses: a row is a line item only when it ends in money and sits
// between the column header (or the document heading) and the totals block.
// Lines that run over are continuation rows (no money) and are folded into the
// item above. The sum of line totals is checked against the printed ex-GST
// subtotal; when it does not add up the lines are still kept, and the caller
// records `linesConsistent: false` so the review screen says so.

const { parseMoneyToCents } = require('./money');

const MAX_LINES = 200;
const MONEY = /(-?\(?\s*(?:AUD|A\$|\$)?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})\s*\)?(?:\s*CR)?)/gi;
const MONEY_AT_END = /(-?\(?\s*(?:AUD|A\$|\$)?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})\s*\)?(?:\s*CR)?)\s*$/i;
const HEADER_ROW = /\b(?:qty|quantity|description|item|product|part\s*no|code)\b/i;
const HEADER_ROW_STRONG = /\b(?:qty|quantity)\b.*\b(?:description|item|product)\b|\b(?:description|item|product)\b.*\b(?:total|amount|price|ext)\b/i;
const TOTALS_ROW = /\b(?:sub[\s-]?total|total\s*\(?\s*(?:ex|excl|inc|incl)|gst|goods\s*(?:value|total)|net\s*(?:value|total|amount)|invoice\s*total|amount\s*due|balance\s*due|total\s*amount|grand\s*total|taxable|rounding)\b/i;
const NOT_ITEM = /\b(?:abn|acn|page\s*\d|phone|fax|email|www\.|http|po\s*box|bill\s*to|ship\s*to|deliver\s*to|sold\s*to|account\s*(?:no|number|:)|invoice\s*(?:no|number|date)|due\s*date|terms|customer|order\s*(?:no|number)|reference|your\s*ref|job\s*(?:no|number))\b/i;
const QTY = /^\s*(-?\d{1,6}(?:\.\d{1,3})?)\s*(m|mtr|mtrs|metre|metres|meter|meters|ea|each|pk|pkt|pack|box|bx|roll|rl|rolls|lt|ltr|kg|pr|pair|set|ctn|carton|len|length|lengths|bag|tube|unit|units|pcs|pc|pce)?\.?\b/i;
const UNIT_WORD = /^(m|mtr|mtrs|metre|metres|meter|meters|ea|each|pk|pkt|pack|box|bx|roll|rl|rolls|lt|ltr|kg|pr|pair|set|ctn|carton|len|length|lengths|bag|tube|unit|units|pcs|pc|pce)\.?$/i;
const CODE = /^[A-Z0-9][A-Z0-9\-\/.]{2,}$/;

function cents(tok) {
  return parseMoneyToCents(String(tok).replace(/\s+/g, ''));
}

function splitCells(line) {
  return line.trim().split(/\s{3,}|\t+/).map((c) => c.trim()).filter(Boolean);
}

/**
 * @param {string[]} lines  the non-empty text lines (as extractInvoiceFromText sees them)
 * @param {{ subtotalCents?: number|null, totalCents?: number|null }} [ctx]
 * @returns {{ lines: Array<{ lineNo: number, description: string, quantity: number|null, unit: string|null, unitPriceCents: number|null, lineTotalCents: number|null, confidence: string, textLine: number }>,
 *            totalCents: number, consistent: boolean|null, reason: string|null }}
 */
function extractLineItems(lines, ctx = {}) {
  const src = Array.isArray(lines) ? lines : [];
  // region: after the column header when there is one, before the totals block
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (HEADER_ROW_STRONG.test(src[i]) && !MONEY_AT_END.test(src[i])) { start = i + 1; break; }
  }
  let end = src.length;
  for (let i = start; i < src.length; i++) {
    if (TOTALS_ROW.test(src[i]) && MONEY_AT_END.test(src[i])) { end = i; break; }
  }
  const out = [];
  for (let i = start; i < end && out.length < MAX_LINES; i++) {
    const line = src[i];
    if (!line || !line.trim()) continue;
    const endMoney = MONEY_AT_END.exec(line);
    if (!endMoney) {
      // continuation of the previous item (a description that wrapped)
      const prev = out[out.length - 1];
      if (prev && prev.textLine === i && !HEADER_ROW.test(line) && !NOT_ITEM.test(line) && !/\d{2,}[\/\-]\d{2,}/.test(line) && line.trim().length <= 80) {
        prev.description = `${prev.description} ${line.trim()}`.slice(0, 200);
        prev.textLine = i + 1;
      }
      continue;
    }
    if (NOT_ITEM.test(line) && !HEADER_ROW.test(line)) continue;
    const lineTotalCents = cents(endMoney[1]);
    if (lineTotalCents == null) continue;
    const cells = splitCells(line.slice(0, line.length - endMoney[0].length));
    if (!cells.length) continue;
    // trailing money cells before the total: unit price (and sometimes a GST column)
    let unitPriceCents = null;
    while (cells.length && MONEY_AT_END.test(cells[cells.length - 1]) && /^\S+$/.test(cells[cells.length - 1].replace(/\s+/g, ''))) {
      const v = cents(cells.pop());
      if (unitPriceCents == null) unitPriceCents = v;
    }
    // quantity (+ unit): the first cell ("10", "3 roll"), a middle cell pair
    // ("3", "roll") after a product code, or the last cell ("… 10 ea")
    let quantity = null;
    let unit = null;
    const takeQty = (idx) => {
      const q = QTY.exec(cells[idx]);
      if (!q || cells[idx].trim().length !== q[0].trim().length) return false;
      quantity = Number(q[1]);
      unit = q[2] ? q[2].toLowerCase() : null;
      cells.splice(idx, 1);
      if (!unit && idx < cells.length && UNIT_WORD.test(cells[idx])) unit = cells.splice(idx, 1)[0].toLowerCase().replace(/\.$/, '');
      return true;
    };
    if (cells.length && !takeQty(0)) {
      for (let j = 1; j < cells.length; j++) {
        if (takeQty(j)) break;
      }
    }
    // a bare product code as its own cell is kept in the description, but not alone
    const description = cells.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!description || !/[A-Za-z]{2,}/.test(description)) continue;
    if (unitPriceCents == null && quantity != null && quantity !== 0 && lineTotalCents != null) {
      const per = Math.round(lineTotalCents / quantity);
      if (Number.isFinite(per)) unitPriceCents = per;
    }
    const codeOnly = cells.length === 1 && CODE.test(cells[0]) && !/[a-z]/.test(cells[0]);
    out.push({
      lineNo: out.length + 1,
      description,
      quantity,
      unit,
      unitPriceCents,
      lineTotalCents,
      confidence: quantity != null && unitPriceCents != null && Math.abs(Math.round(quantity * unitPriceCents) - lineTotalCents) <= Math.max(2, Math.ceil(quantity)) ? 'high' : codeOnly ? 'low' : 'medium',
      textLine: i + 1,
    });
  }
  const totalCents = out.reduce((s, l) => s + (l.lineTotalCents || 0), 0);
  let consistent = null;
  let reason = null;
  const sub = ctx.subtotalCents;
  const tot = ctx.totalCents;
  if (out.length && sub != null) {
    const tol = Math.max(5, out.length, Math.round(Math.abs(sub) * 0.005));
    if (Math.abs(totalCents - sub) <= tol) consistent = true;
    else if (tot != null && Math.abs(totalCents - tot) <= tol) { consistent = false; reason = 'lines_include_gst'; }
    else { consistent = false; reason = 'lines_do_not_add_up'; }
  } else if (!out.length) {
    reason = 'no_lines_read';
  }
  return { lines: out, totalCents, consistent, reason };
}

module.exports = { extractLineItems, splitCells };
