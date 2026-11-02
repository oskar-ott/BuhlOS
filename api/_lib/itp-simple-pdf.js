'use strict';

// Simple ITP report PDF (#912; layout per the 2026-11-02 handoff, board 13)
// — pure render module, no I/O.
//
// Input is fully materialised (photo BYTES, not URLs): the handler fetches
// binaries from Blob and formats the date labels, so this module stays pure
// and unit-testable offline. pdf-lib per the quote-pdf precedent (pure JS,
// no chromium, standard-14 fonts); JPEG/PNG sniffed by magic bytes, anything
// else renders as an honest "couldn't embed" note rather than being silently
// dropped (P7).
//
// Layout: A4 portrait.
//   Header, page 1 only: the PDF's name, then "{ITP title} · {job}", when it
//   was made and by whom, which areas ("Switchboard, Kitchen (2 of 4)") and
//   the photo count. No logo today (none is stored).
//   Areas in capture order: heading "{name} · {n} photos", photos two to a
//   row (4:3 cells), caption underneath. An area starts a new page when its
//   heading and first row won't fit, so a heading is never left alone.
//   Footer on every page: "{name} · {job} · Made with BuhlOS · Page x of y".
// Plain by design: no pass/fail, hold points or signatures.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/** Bump when the layout/content changes materially (quote-pdf precedent). */
const GENERATOR_VERSION = 'itp-simple-pdf/2';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const FOOTER_H = 28;
const GUTTER = 12;
const INK = rgb(0.06, 0.09, 0.16);
const NAVY = rgb(0.05, 0.12, 0.21);
const GREY = rgb(0.28, 0.33, 0.41);
const RULE = rgb(0.89, 0.91, 0.94);

function sniffImageKind(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

// WinAnsi-only fonts: strip characters pdf-lib can't encode (emoji etc.)
// rather than throwing mid-render. Site text survives; decoration degrades.
function safeText(s) {
  return String(s || '').replace(/[^\x20-\x7E -ÿ‘’“”–—·]/g, '').trim();
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

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Compose the report PDF.
 * @param {{
 *   name?: string, title: string, jobName: string, jobLegacyId: string,
 *   authorName: string, generatedAtLabel: string, areaSummary?: string,
 *   areas: Array<{ name: string, photos: Array<{ bytes: Uint8Array|null, caption?: string }> }>,
 * }} input
 * @returns {Promise<Uint8Array>}
 */
async function composeItpPdf(input) {
  const doc = await PDFDocument.create();
  const name = safeText(input.name) || safeText(input.title) || 'ITP';
  doc.setTitle(name);
  doc.setProducer(GENERATOR_VERSION);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const contentWidth = A4.width - MARGIN * 2;
  const bottom = MARGIN + FOOTER_H;
  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  function newPage() {
    page = doc.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  }
  function ensure(height) {
    if (y - height < bottom) newPage();
  }
  function drawLines(lines, { size, useBold = false, color = INK, gap = 4 }) {
    const f = useBold ? bold : font;
    for (const line of lines) {
      ensure(size + gap);
      page.drawText(line, { x: MARGIN, y: y - size, size, font: f, color });
      y -= size + gap;
    }
  }

  // ── Header (page 1 only) ────────────────────────────────────────────
  drawLines(wrapText(name, bold, 22, contentWidth), { size: 22, useBold: true, gap: 6, color: NAVY });
  const itpLine = [safeText(input.title), safeText(input.jobName)].filter(Boolean).join(' · ');
  if (itpLine && itpLine !== name) drawLines(wrapText(itpLine, font, 12, contentWidth), { size: 12, color: GREY });
  const madeLine = ['Made ' + safeText(input.generatedAtLabel), input.authorName ? 'By ' + safeText(input.authorName) : '']
    .filter(Boolean).join(' · ');
  drawLines([madeLine], { size: 10, color: GREY });
  const totalPhotos = input.areas.reduce((n, a) => n + a.photos.length, 0);
  const summary = [
    input.areaSummary ? 'Areas ' + safeText(input.areaSummary) : '',
    'Photos ' + totalPhotos,
  ].filter(Boolean).join(' · ');
  drawLines(wrapText(summary, font, 10, contentWidth), { size: 10, color: GREY, gap: 8 });
  ensure(10);
  page.drawLine({
    start: { x: MARGIN, y }, end: { x: A4.width - MARGIN, y },
    thickness: 1, color: RULE,
  });
  y -= 16;

  // ── Areas ───────────────────────────────────────────────────────────
  const cellWidth = (contentWidth - GUTTER) / 2;
  const cellHeight = cellWidth * 0.75; // 4:3 cells
  const headingHeight = 14 + 8;
  const firstRowHeight = cellHeight + 14;

  for (let i = 0; i < input.areas.length; i++) {
    const area = input.areas[i];
    // Keep the heading with its first row.
    ensure(headingHeight + (area.photos.length ? firstRowHeight : 14));
    const heading = `${area.name || 'Area'} · ${plural(area.photos.length, 'photo', 'photos')}`;
    drawLines(wrapText(heading, bold, 14, contentWidth), { size: 14, useBold: true, gap: 8, color: NAVY });

    if (!area.photos.length) {
      drawLines(['No photos in this area.'], { size: 10, color: GREY, gap: 12 });
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
        let h = cellHeight;
        if (img) {
          const scale = Math.min(cellWidth / img.width, cellHeight / img.height);
          w = img.width * scale;
          h = img.height * scale;
        }
        const captionLines = photo.caption ? wrapText(photo.caption, font, 9, cellWidth) : [];
        cells.push({ img, w, h, captionLines });
      }
      const rowCaptionHeight = Math.max(...cells.map((c) => c.captionLines.length)) * 12;
      ensure(cellHeight + rowCaptionHeight + 14);

      cells.forEach((cell, idx) => {
        const x = MARGIN + idx * (cellWidth + GUTTER);
        const top = y;
        if (cell.img) {
          // Centre the picture inside its 4:3 cell.
          const dx = (cellWidth - cell.w) / 2;
          const dy = (cellHeight - cell.h) / 2;
          page.drawImage(cell.img, { x: x + dx, y: top - cellHeight + dy, width: cell.w, height: cell.h });
        } else {
          page.drawRectangle({
            x, y: top - cellHeight, width: cellWidth, height: cellHeight,
            borderColor: RULE, borderWidth: 1,
          });
          page.drawText("Photo couldn't be embedded", {
            x: x + 10, y: top - cellHeight / 2, size: 9, font, color: GREY,
          });
        }
        cell.captionLines.forEach((line, li) => {
          page.drawText(line, {
            x, y: top - cellHeight - 12 - li * 12, size: 9, font, color: GREY,
          });
        });
      });
      y -= cellHeight + rowCaptionHeight + 14;
    }
    y -= 6;
  }

  if (!input.areas.length) {
    drawLines(['No areas in this PDF.'], { size: 11, color: GREY });
  }

  // ── Footer, every page ──────────────────────────────────────────────
  const pages = doc.getPages();
  const footerLeft = [name, safeText(input.jobName)].filter(Boolean).join(' · ') + ' · Made with BuhlOS';
  pages.forEach((pg, idx) => {
    const label = `Page ${idx + 1} of ${pages.length}`;
    const labelWidth = font.widthOfTextAtSize(label, 9);
    const leftMax = contentWidth - labelWidth - 12;
    let left = footerLeft;
    while (left.length > 4 && font.widthOfTextAtSize(left, 9) > leftMax) left = left.slice(0, -2) + '…';
    pg.drawLine({
      start: { x: MARGIN, y: MARGIN + 14 }, end: { x: A4.width - MARGIN, y: MARGIN + 14 },
      thickness: 0.5, color: RULE,
    });
    pg.drawText(left, { x: MARGIN, y: MARGIN, size: 9, font, color: GREY });
    pg.drawText(label, { x: A4.width - MARGIN - labelWidth, y: MARGIN, size: 9, font, color: GREY });
  });

  return doc.save();
}

module.exports = { composeItpPdf, sniffImageKind, GENERATOR_VERSION };
