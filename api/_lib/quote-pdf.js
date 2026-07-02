'use strict';

// Branded client quote PDF (#243) — pure render module, no I/O.
//
// Built per the #172 MIGRATE-BY-REBUILD ruling: this renders the V2 quote
// document (quotes-v2/<id>.json), never the legacy nine-section blobs. The
// legacy printClient popup died with the #376 cutover; the durable capability
// it hinted at lives here.
//
// LEAK-PROOFING (the issue's mandatory requirement): the renderer's ONLY input
// is the client projection — an EXPLICIT sell-side allowlist mirrored from
// src/domains/quoting/client-projection.ts (#186). Cost, margin, markup,
// unitCost, categories and preset stamps physically cannot reach the PDF
// because the projection never copies them. The parity + byte-level assertions
// live in src/domains/quoting/quote-pdf-api.test.ts.
//
// LIBRARY DECISION (issue requirement 2 — serverless honesty): pdf-lib (MIT).
// Pure JS, zero native deps, no font asset files (standard 14 fonts are
// metrics-only), no chromium — cold-start and bundle cost are negligible in a
// Vercel function. Limits accepted: no HTML/CSS input (we lay out with a
// cursor), WinAnsi text only (ü/é etc. fine — emoji degrade to "?").
//
// MIRROR LAW: CJS cannot import the TS domain. projectQuoteToClientView and
// the totals math below are hand-mirrors of src/domains/quoting/
// client-projection.ts + totals.ts — change them TOGETHER; the harness test
// pins parity on golden fixtures (house pattern, api/quotes-v2.js header).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/** Bump when the layout/content of the generated document changes materially —
 *  stored on every register entry so an artifact can be traced to its
 *  generator (issue AC). */
const GENERATOR_VERSION = 'quote-pdf/1';

/** v2 quotes carry no validity setting yet; the issue pins the default. */
const DEFAULT_VALIDITY_DAYS = 30;

// ── Mirrors of src/domains/quoting/totals.ts (change together) ────────────
const GST_RATE = 0.1;
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function lineTotal(line) {
  return roundMoney(Number(line.qty) * Number(line.rate));
}
function computeQuoteTotals(sections) {
  let subtotal = 0;
  let lineCount = 0;
  for (const section of sections) {
    for (const line of section.lines) {
      subtotal += lineTotal(line);
      lineCount += 1;
    }
  }
  const subtotalExGst = roundMoney(subtotal);
  const gst = roundMoney(subtotalExGst * GST_RATE);
  const totalIncGst = roundMoney(subtotalExGst + gst);
  return { subtotalExGst, gst, totalIncGst, lineCount };
}

// ── Mirror of src/domains/quoting/client-projection.ts (change together) ──
/**
 * Project a full v2 Quote document to its client-facing view. EXPLICIT
 * allowlist — every field is named, never spread — so passthrough'd internal
 * fields (unitCost/cost/margin/markupPct/category/ratePreset*…) cannot reach
 * the client document. Totals are recomputed from the sections so the printed
 * lines always foot to the printed subtotal.
 */
function projectQuoteToClientView(quote) {
  const sections = (quote.sections || [])
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({
      title: s.title,
      lines: (s.lines || []).map((l) => ({
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        rate: l.rate,
        lineTotalExGst: lineTotal({ qty: l.qty, rate: l.rate }),
      })),
    }));

  const totals = computeQuoteTotals(quote.sections || []);

  return {
    name: quote.name,
    clientName: quote.clientName || null,
    sections,
    totals,
    gstRate: GST_RATE,
    gstNote: `Prices exclude GST; GST charged at ${Math.round(GST_RATE * 100)}%.`,
  };
}

// ── Render-edge formatting ────────────────────────────────────────────────

/** Mirror of totals.ts formatMoney, EXCEPT the minus: WinAnsi has no U+2212,
 *  so the PDF uses an ASCII hyphen. Money stays a number until this edge. */
function formatMoney(value) {
  const abs = Math.abs(value).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}$${abs}`;
}

function formatQty(qty) {
  return String(Number(qty));
}

/** en-AU long date from an ISO string, stable (UTC) so a regenerated artifact
 *  for the same instant reads the same everywhere. */
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** pdf-lib's standard fonts are WinAnsi-encoded: Latin-1 plus the common
 *  typographic block (curly quotes, en/em dash, ellipsis, bullet). Anything
 *  else (emoji, CJK) would throw at draw time — degrade it to "?" honestly
 *  rather than fail the whole document. Control chars are dropped. */
const WINANSI_EXTRA = new Set('‘’‚“”„–—†‡•…‰‹›ˆ˜ŒœŠšŸŽžƒ€™'.split(''));
function toWinAnsi(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code === 0x09) { out += ' '; continue; }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
    if (code <= 0xff || WINANSI_EXTRA.has(ch)) out += ch;
    else out += '?';
  }
  return out;
}

/** Greedy word wrap by measured width; hard-splits a single over-long word. */
function wrapText(text, font, size, maxWidth) {
  const clean = toWinAnsi(text).trim();
  if (!clean) return [''];
  const words = clean.split(/\s+/);
  const lines = [];
  let current = '';
  const width = (s) => font.widthOfTextAtSize(s, size);
  const pushWord = (word) => {
    // Hard-split a word that alone exceeds the column.
    while (width(word) > maxWidth && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && width(word.slice(0, cut)) > maxWidth) cut -= 1;
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    return word;
  };
  for (let word of words) {
    word = pushWord(word);
    const candidate = current ? `${current} ${word}` : word;
    if (width(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// ── Layout constants ──────────────────────────────────────────────────────
const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const CONTENT_WIDTH = A4.width - MARGIN * 2;
// Line-item table columns (right-aligned numeric block, description flexes).
const COL = { qty: 42, unit: 40, rate: 78, total: 84, gap: 8 };
const NUMERIC_BLOCK = COL.qty + COL.unit + COL.rate + COL.total + COL.gap * 4;
const DESC_WIDTH = CONTENT_WIDTH - NUMERIC_BLOCK;

const INK = rgb(0.12, 0.16, 0.24);
const MUTED = rgb(0.42, 0.45, 0.52);
const RULE = rgb(0.85, 0.86, 0.89);

/**
 * Render the branded client quote PDF.
 *
 * @param {object} view      the client projection (projectQuoteToClientView)
 * @param {object} branding  { name, abn?, address?, phone?, email? } — only
 *                           set fields render; when nothing but the name is
 *                           known the header is an honest text-only block
 *                           (never a placeholder logo, repo law).
 * @param {object} meta      { quoteNumber, generatedAt (ISO), validityDays?,
 *                             issued: boolean, issueNumber?, documentId? }
 * @returns {Promise<Buffer>} the PDF bytes
 */
async function renderQuotePdf(view, branding, meta) {
  const doc = await PDFDocument.create();
  doc.setTitle(toWinAnsi(`Quote — ${view.name}`));
  doc.setAuthor(toWinAnsi(branding.name || ''));
  doc.setProducer(GENERATOR_VERSION);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  const draw = (text, x, size, opts = {}) => {
    page.drawText(toWinAnsi(String(text)), {
      x,
      y,
      size,
      font: opts.bold ? bold : font,
      color: opts.muted ? MUTED : INK,
    });
  };
  const drawRight = (text, rightEdge, size, opts = {}) => {
    const f = opts.bold ? bold : font;
    const w = f.widthOfTextAtSize(toWinAnsi(String(text)), size);
    draw(text, rightEdge - w, size, opts);
  };
  const rule = () => {
    page.drawLine({
      start: { x: MARGIN, y: y },
      end: { x: A4.width - MARGIN, y: y },
      thickness: 0.75,
      color: RULE,
    });
  };
  const newPage = () => {
    page = doc.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
    // Running header so a loose page is attributable.
    draw(`Quote ${meta.quoteNumber} — ${view.name}`, MARGIN, 8, { muted: true });
    y -= 20;
  };
  const ensure = (needed) => {
    if (y - needed < MARGIN + 24) newPage();
  };

  // ── Letterhead (honest text-only — no logo asset exists; render only what
  //    is actually configured, never a placeholder) ────────────────────────
  draw(branding.name || 'Quote', MARGIN, 18, { bold: true });
  drawRight('QUOTE', A4.width - MARGIN, 18, { bold: true });
  y -= 16;
  const brandLines = [
    branding.abn ? `ABN ${branding.abn}` : null,
    branding.address || null,
    [branding.phone, branding.email].filter(Boolean).join(' · ') || null,
  ].filter(Boolean);
  for (const line of brandLines) {
    draw(line, MARGIN, 9, { muted: true });
    y -= 12;
  }
  y -= 6;

  // ── Quote meta block ──────────────────────────────────────────────────
  rule();
  y -= 18;
  draw(view.name, MARGIN, 14, { bold: true });
  y -= 16;
  if (view.clientName) {
    draw(`Prepared for: ${view.clientName}`, MARGIN, 10);
    y -= 14;
  }
  const validityDays = Number.isFinite(meta.validityDays) ? meta.validityDays : DEFAULT_VALIDITY_DAYS;
  const metaPairs = [
    ['Quote no.', meta.quoteNumber],
    ['Date', formatDate(meta.generatedAt)],
    ['Valid for', `${validityDays} days from the date above`],
  ];
  for (const [label, value] of metaPairs) {
    draw(label, MARGIN, 9, { muted: true });
    draw(value, MARGIN + 70, 9);
    y -= 12;
  }
  y -= 8;

  // ── Sections ──────────────────────────────────────────────────────────
  const colX = {
    desc: MARGIN,
    qty: MARGIN + DESC_WIDTH + COL.gap + COL.qty,
    unit: MARGIN + DESC_WIDTH + COL.gap * 2 + COL.qty + COL.unit,
    rate: MARGIN + DESC_WIDTH + COL.gap * 3 + COL.qty + COL.unit + COL.rate,
    total: A4.width - MARGIN,
  };
  const drawColumnHeader = () => {
    draw('Description', colX.desc, 8, { muted: true });
    drawRight('Qty', colX.qty, 8, { muted: true });
    drawRight('Unit', colX.unit, 8, { muted: true });
    drawRight('Rate ex GST', colX.rate, 8, { muted: true });
    drawRight('Total ex GST', colX.total, 8, { muted: true });
    y -= 6;
    rule();
    y -= 14;
  };

  for (const section of view.sections) {
    ensure(64);
    draw(section.title, MARGIN, 11, { bold: true });
    y -= 16;
    if (section.lines.length === 0) {
      draw('No line items.', MARGIN, 9, { muted: true });
      y -= 16;
      continue;
    }
    drawColumnHeader();

    let sectionTotal = 0;
    for (const line of section.lines) {
      const descLines = wrapText(line.description || '—', font, 9, DESC_WIDTH);
      const rowHeight = descLines.length * 12 + 4;
      if (y - rowHeight < MARGIN + 24) {
        newPage();
        draw(section.title + ' (continued)', MARGIN, 11, { bold: true });
        y -= 16;
        drawColumnHeader();
      }
      // First description line carries the numbers.
      draw(descLines[0], colX.desc, 9);
      drawRight(formatQty(line.qty), colX.qty, 9);
      drawRight(line.unit || '', colX.unit, 9);
      drawRight(formatMoney(line.rate), colX.rate, 9);
      drawRight(formatMoney(line.lineTotalExGst), colX.total, 9);
      y -= 12;
      for (const extra of descLines.slice(1)) {
        draw(extra, colX.desc, 9);
        y -= 12;
      }
      y -= 4;
      sectionTotal = roundMoney(sectionTotal + line.lineTotalExGst);
    }
    ensure(20);
    drawRight(`Section total ex GST  ${formatMoney(sectionTotal)}`, colX.total, 9, { bold: true });
    y -= 22;
  }

  // ── Totals block (numbers come from the projection = totals.ts math) ──
  ensure(96);
  rule();
  y -= 16;
  const totalsRows = [
    ['Subtotal ex GST', formatMoney(view.totals.subtotalExGst), false],
    [`GST (${Math.round(view.gstRate * 100)}%)`, formatMoney(view.totals.gst), false],
    ['Total inc GST', formatMoney(view.totals.totalIncGst), true],
  ];
  for (const [label, value, strong] of totalsRows) {
    drawRight(label, colX.total - 110, strong ? 11 : 10, { bold: strong });
    drawRight(value, colX.total, strong ? 11 : 10, { bold: strong });
    y -= strong ? 18 : 15;
  }
  y -= 4;

  // ── Terms (only real statements — nothing invented) ───────────────────
  ensure(40);
  draw(view.gstNote, MARGIN, 8, { muted: true });
  y -= 11;
  draw(`This quote is valid for ${validityDays} days from the issue date shown above.`, MARGIN, 8, { muted: true });
  y -= 11;

  // ── Footer on every page: issuance honesty + page numbers ─────────────
  const issuedLine = meta.issued
    ? `Issued ${formatDate(meta.generatedAt)}${meta.issueNumber ? ` · Issue ${meta.issueNumber}` : ''}${meta.documentId ? ` · Document ${meta.documentId}` : ''}`
    : 'Preview — not yet issued';
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(toWinAnsi(issuedLine), {
      x: MARGIN,
      y: MARGIN - 18,
      size: 7.5,
      font,
      color: MUTED,
    });
    const pageLabel = `Page ${i + 1} of ${pages.length}`;
    const w = font.widthOfTextAtSize(pageLabel, 7.5);
    p.drawText(pageLabel, {
      x: A4.width - MARGIN - w,
      y: MARGIN - 18,
      size: 7.5,
      font,
      color: MUTED,
    });
  });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

module.exports = {
  GENERATOR_VERSION,
  DEFAULT_VALIDITY_DAYS,
  GST_RATE,
  projectQuoteToClientView,
  computeQuoteTotals,
  lineTotal,
  roundMoney,
  formatMoney,
  toWinAnsi,
  wrapText,
  renderQuotePdf,
};
