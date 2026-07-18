'use strict';

// Simple ITP report PDF (#912) — pure render module, no I/O.
//
// Input is fully materialised (photo BYTES, not URLs): the handler fetches
// binaries from Blob and formats the date labels, so this module stays pure
// and unit-testable offline. pdf-lib per the quote-pdf precedent (pure JS,
// no chromium, standard-14 fonts); this is the repo's first image embedder —
// JPEG/PNG sniffed by magic bytes, anything else renders as an honest
// "couldn't embed" note rather than being silently dropped (P7).
//
// Layout: A4 portrait, one header block, then one section per area in the
// captured order — area name + photo grid (2-up) + optional captions. Plain
// by design: the lean-reset spec is "area name + photos per area", nothing
// invented on top.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/** Bump when the layout/content changes materially (quote-pdf precedent). */
const GENERATOR_VERSION = 'itp-simple-pdf/1';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const GUTTER = 12;
const INK = rgb(0.13, 0.15, 0.19);
const GREY = rgb(0.45, 0.48, 0.53);
const RULE = rgb(0.85, 0.87, 0.9);

function sniffImageKind(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

// WinAnsi-only fonts: strip characters pdf-lib can't encode (emoji etc.)
// rather than throwing mid-render. Site text survives; decoration degrades.
function safeText(s) {
  return String(s || '').replace(/[^\x20-\x7E -ÿ‘’“”–—]/g, '').trim();
}

function wrapText(text, font, size, maxWidth) {
  const words = safeText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const probe = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(probe, size) <= maxWidth || !line) line = probe;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Compose the report PDF.
 * @param {{
 *   title: string, jobName: string, jobLegacyId: string,
 *   authorName: string, generatedAtLabel: string,
 *   areas: Array<{ name: string, photos: Array<{ bytes: Uint8Array|null, caption?: string }> }>,
 * }} input
 * @returns {Promise<Uint8Array>}
 */
async function composeItpPdf(input) {
  const doc = await PDFDocument.create();
  doc.setTitle(safeText(input.title) || 'ITP report');
  doc.setProducer(GENERATOR_VERSION);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const contentWidth = A4.width - MARGIN * 2;
  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  function newPage() {
    page = doc.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  }
  function ensure(height) {
    if (y - height < MARGIN) newPage();
  }
  function drawLines(lines, { size, useBold = false, color = INK, gap = 4 }) {
    const f = useBold ? bold : font;
    for (const line of lines) {
      ensure(size + gap);
      page.drawText(line, { x: MARGIN, y: y - size, size, font: f, color });
      y -= size + gap;
    }
  }

  // ── Header ──────────────────────────────────────────────────────────
  drawLines(wrapText(input.title || 'ITP report', bold, 20, contentWidth), { size: 20, useBold: true, gap: 6 });
  const jobLine = [safeText(input.jobName), safeText(input.jobLegacyId)].filter(Boolean).join(' · ');
  if (jobLine) drawLines([jobLine], { size: 11, color: GREY });
  const byLine = ['Prepared by ' + (safeText(input.authorName) || 'the field crew'), safeText(input.generatedAtLabel)]
    .filter(Boolean).join(' · ');
  drawLines([byLine], { size: 10, color: GREY, gap: 8 });
  ensure(10);
  page.drawLine({
    start: { x: MARGIN, y }, end: { x: A4.width - MARGIN, y },
    thickness: 1, color: RULE,
  });
  y -= 16;

  // ── Areas ───────────────────────────────────────────────────────────
  const cellWidth = (contentWidth - GUTTER) / 2;
  const maxImgHeight = 250;

  for (let i = 0; i < input.areas.length; i++) {
    const area = input.areas[i];
    ensure(40);
    drawLines(wrapText(`${i + 1}. ${area.name || 'Area'}`, bold, 14, contentWidth), { size: 14, useBold: true, gap: 6 });

    if (!area.photos.length) {
      drawLines(['No photos captured for this area.'], { size: 10, color: GREY, gap: 10 });
      continue;
    }

    // 2-up grid: place photos into rows, page-breaking per row.
    for (let p = 0; p < area.photos.length; p += 2) {
      const row = area.photos.slice(p, p + 2);
      const cells = [];
      for (const photo of row) {
        const kind = sniffImageKind(photo.bytes);
        let img = null;
        try {
          if (kind === 'jpg') img = await doc.embedJpg(photo.bytes);
          else if (kind === 'png') img = await doc.embedPng(photo.bytes);
        } catch {
          img = null;
        }
        let w = cellWidth;
        let h = cellWidth * 0.75;
        if (img) {
          const scale = Math.min(cellWidth / img.width, maxImgHeight / img.height);
          w = img.width * scale;
          h = img.height * scale;
        }
        const captionLines = photo.caption ? wrapText(photo.caption, font, 9, cellWidth) : [];
        cells.push({ img, w, h, captionLines });
      }
      const rowImgHeight = Math.max(...cells.map((c) => c.h));
      const rowCaptionHeight = Math.max(...cells.map((c) => c.captionLines.length)) * 12;
      ensure(rowImgHeight + rowCaptionHeight + 14);

      cells.forEach((cell, idx) => {
        const x = MARGIN + idx * (cellWidth + GUTTER);
        const top = y;
        if (cell.img) {
          page.drawImage(cell.img, { x, y: top - cell.h, width: cell.w, height: cell.h });
        } else {
          page.drawRectangle({
            x, y: top - cell.h, width: cell.w, height: cell.h,
            borderColor: RULE, borderWidth: 1,
          });
          page.drawText("Photo couldn't be embedded", {
            x: x + 10, y: top - cell.h / 2, size: 9, font, color: GREY,
          });
        }
        cell.captionLines.forEach((line, li) => {
          page.drawText(line, {
            x, y: top - rowImgHeight - 12 - li * 12, size: 9, font, color: GREY,
          });
        });
      });
      y -= rowImgHeight + rowCaptionHeight + 14;
    }
    y -= 6;
  }

  if (!input.areas.length) {
    drawLines(['No areas in this report yet.'], { size: 11, color: GREY });
  }

  return doc.save();
}

module.exports = { composeItpPdf, sniffImageKind, GENERATOR_VERSION };
