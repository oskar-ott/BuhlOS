'use strict';

// Payroll hours PDF — pure render module, no I/O.
//
// The printable sibling of the payroll CSV: same rows, same engine
// (api/_lib/payroll-inputs.js `collectRows`), a different container. CSV goes
// into a spreadsheet or Xero; this is the sheet you print, sign, file or email
// to an accountant. Composed with pdf-lib per the quote-pdf / itp-simple-pdf
// precedent (pure JS, no chromium, standard-14 fonts).
//
// A REPORT, never a commit: nothing here stamps entries or records a run — the
// only path that records a payroll run stays the immutable batch flow
// (payroll-boundary ADR #609).
//
// Layout: A4 portrait. Header (period + status + generated-at), a totals band,
// the per-worker summary table, then an optional per-worker day breakdown.
// Every figure is summed from the caller's rows — nothing is invented, and a
// worker with no Xero employee id says so rather than showing a blank cell.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/** Bump when the layout/content changes materially (quote-pdf precedent). */
const GENERATOR_VERSION = 'payroll-pdf/1';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 42;
const INK = rgb(0.05, 0.11, 0.2);
const GREY = rgb(0.42, 0.46, 0.57);
const RULE = rgb(0.85, 0.87, 0.9);
const BAND = rgb(0.96, 0.96, 0.94);
const YELLOW = rgb(1, 0.8, 0);

// WinAnsi-only fonts: strip characters pdf-lib can't encode (emoji etc.)
// rather than throwing mid-render.
function safeText(s) {
  return String(s === 0 ? '0' : s || '').replace(/[^\x20-\x7E -ÿ]/g, '').trim();
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Australian date order everywhere on the sheet — day before month
 * (owner-corrected 2026-08-10; the first cut printed raw ISO). Anything that
 * isn't a YYYY-MM-DD passes through untouched rather than being mangled.
 */
function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return { y: m[1], mo: Number(m[2]), d: Number(m[3]) };
}

/** "9 Aug 2026" — headers and the generated-at line. */
function longDate(iso) {
  const p = parseISO(iso);
  if (!p) return String(iso || '');
  return `${p.d} ${MONTHS[p.mo - 1]} ${p.y}`;
}

/** "Mon 03/08/2026" — the day-breakdown rows: sortable by eye, unambiguous. */
function dayDate(iso) {
  const p = parseISO(iso);
  if (!p) return String(iso || '');
  const dow = DAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
  return `${dow} ${String(p.d).padStart(2, '0')}/${String(p.mo).padStart(2, '0')}/${p.y}`;
}

/** "7.6" not "7.60"; "—" for nothing, never a misleading bare 0 in the OT column. */
function hours(n, opts) {
  const v = round2(n);
  if (!v && opts && opts.dashWhenZero) return '-';
  return String(v);
}

/**
 * Roll the flat export rows up per worker — the same arithmetic the on-screen
 * pay-period table does, kept here so the PDF never depends on a second engine.
 * Returns workers sorted by name plus the period totals.
 */
function rollupRows(rows) {
  const byWorker = new Map();
  for (const r of rows || []) {
    const id = String(r.workerId || '');
    if (!byWorker.has(id)) {
      byWorker.set(id, {
        workerId: id,
        workerName: String(r.workerName || id || 'Unknown worker'),
        xeroEmployeeId: String(r.xeroEmployeeId || ''),
        days: new Set(),
        ordinaryHours: 0,
        overtimeHours: 0,
        hours: 0,
        entries: [],
      });
    }
    const w = byWorker.get(id);
    if (!w.xeroEmployeeId && r.xeroEmployeeId) w.xeroEmployeeId = String(r.xeroEmployeeId);
    if (r.date) w.days.add(String(r.date));
    w.ordinaryHours += Number(r.ordinaryHours) || 0;
    w.overtimeHours += Number(r.overtimeHours) || 0;
    w.hours += Number(r.hours) || 0;
    w.entries.push({
      date: String(r.date || ''),
      jobName: String(r.jobName || ''),
      ordinaryHours: Number(r.ordinaryHours) || 0,
      overtimeHours: Number(r.overtimeHours) || 0,
      hours: Number(r.hours) || 0,
    });
  }

  const workers = [...byWorker.values()]
    .map((w) => ({
      ...w,
      dayCount: w.days.size,
      ordinaryHours: round2(w.ordinaryHours),
      overtimeHours: round2(w.overtimeHours),
      hours: round2(w.hours),
      entries: w.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    }))
    .sort((a, b) => a.workerName.localeCompare(b.workerName));

  const totals = workers.reduce(
    (acc, w) => ({
      workerCount: acc.workerCount + 1,
      dayCount: acc.dayCount + w.dayCount,
      ordinaryHours: round2(acc.ordinaryHours + w.ordinaryHours),
      overtimeHours: round2(acc.overtimeHours + w.overtimeHours),
      hours: round2(acc.hours + w.hours),
      unmappedWorkerCount: acc.unmappedWorkerCount + (w.xeroEmployeeId ? 0 : 1),
    }),
    { workerCount: 0, dayCount: 0, ordinaryHours: 0, overtimeHours: 0, hours: 0, unmappedWorkerCount: 0 },
  );

  return { workers, totals };
}

/**
 * Compose the payroll hours PDF.
 * @param {{
 *   rows: Array<object>,           // the export rows (collectRows output)
 *   fromDate: string, toDate: string,
 *   statusLabel?: string,          // e.g. 'approved'
 *   generatedAtLabel?: string,
 *   includeDetail?: boolean,       // per-worker day breakdown (default true)
 * }} input
 * @returns {Promise<Uint8Array>}
 */
async function composePayrollPdf(input) {
  const opts = input || {};
  const { workers, totals } = rollupRows(opts.rows);
  const fromDate = safeText(opts.fromDate);
  const toDate = safeText(opts.toDate);
  const includeDetail = opts.includeDetail !== false;

  const doc = await PDFDocument.create();
  doc.setTitle(`BuhlOS hours ${longDate(fromDate)} to ${longDate(toDate)}`);
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
    if (y - height < MARGIN) {
      newPage();
      return true;
    }
    return false;
  }
  function text(str, x, size, opt) {
    page.drawText(safeText(str), {
      x,
      y: y - size,
      size,
      font: (opt && opt.bold) ? bold : font,
      color: (opt && opt.color) || INK,
    });
  }
  /** Right-align within a column whose RIGHT edge is `xRight`. */
  function textRight(str, xRight, size, opt) {
    const s = safeText(str);
    const f = (opt && opt.bold) ? bold : font;
    page.drawText(s, {
      x: xRight - f.widthOfTextAtSize(s, size),
      y: y - size,
      size,
      font: f,
      color: (opt && opt.color) || INK,
    });
  }
  function rule() {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4.width - MARGIN, y },
      thickness: 1,
      color: RULE,
    });
  }

  // ── Header ──────────────────────────────────────────────────────────
  text('BuhlOS', MARGIN, 10, { color: GREY, bold: true });
  y -= 14;
  text('Hours for payroll', MARGIN, 22, { bold: true });
  // Clear the 22pt title's baseline AND descenders before the brand rule —
  // drawn any higher it strikes through the heading.
  y -= 40;
  page.drawRectangle({ x: MARGIN, y: y + 6, width: 34, height: 3, color: YELLOW });
  y -= 12;
  text(`Pay period ${longDate(fromDate)} to ${longDate(toDate)}`, MARGIN, 12);
  y -= 17;
  const meta = [
    opts.statusLabel ? `${safeText(opts.statusLabel)} hours only` : null,
    opts.generatedAtLabel ? `Generated ${longDate(opts.generatedAtLabel)}` : null,
  ].filter(Boolean).join('  |  ');
  if (meta) {
    text(meta, MARGIN, 9, { color: GREY });
    y -= 14;
  }
  text(
    'Report only - printing this does not send hours anywhere or mark them exported.',
    MARGIN, 9, { color: GREY },
  );
  y -= 18;

  // ── Totals band ─────────────────────────────────────────────────────
  page.drawRectangle({ x: MARGIN, y: y - 42, width: contentWidth, height: 48, color: BAND });
  const cellW = contentWidth / 4;
  const band = [
    ['Total hours', hours(totals.hours)],
    ['Ordinary', hours(totals.ordinaryHours)],
    ['Overtime', hours(totals.overtimeHours)],
    ['Workers', String(totals.workerCount)],
  ];
  y -= 12;
  band.forEach(([label, value], i) => {
    const x = MARGIN + cellW * i + 12;
    page.drawText(safeText(label), { x, y: y - 8, size: 8, font, color: GREY });
    page.drawText(safeText(value), { x, y: y - 26, size: 16, font: bold, color: INK });
  });
  y -= 48;

  if (totals.unmappedWorkerCount > 0) {
    text(
      `${totals.unmappedWorkerCount} worker(s) have no Xero employee id - they cannot be exported to Xero yet.`,
      MARGIN, 9, { color: GREY },
    );
    y -= 16;
  }

  // ── Per-worker summary table ────────────────────────────────────────
  y -= 6;
  if (workers.length === 0) {
    text('No hours in this period.', MARGIN, 11, { color: GREY });
    y -= 16;
    text(
      'Nothing has been approved for these dates yet - approve days on the weekly board and they appear here.',
      MARGIN, 9, { color: GREY },
    );
    return doc.save();
  }

  const colDays = MARGIN + 250;
  const colOrd = MARGIN + 330;
  const colOt = MARGIN + 400;
  const colTot = A4.width - MARGIN;

  function summaryHeader() {
    text('Worker', MARGIN, 8, { color: GREY, bold: true });
    textRight('Days', colDays, 8, { color: GREY, bold: true });
    textRight('Ordinary', colOrd, 8, { color: GREY, bold: true });
    textRight('Overtime', colOt, 8, { color: GREY, bold: true });
    textRight('Total', colTot, 8, { color: GREY, bold: true });
    y -= 12;
    rule();
    y -= 12;
  }

  text('Summary by worker', MARGIN, 12, { bold: true });
  y -= 20;
  summaryHeader();

  for (const w of workers) {
    if (ensure(30)) summaryHeader();
    text(w.workerName, MARGIN, 10);
    textRight(String(w.dayCount), colDays, 10);
    textRight(hours(w.ordinaryHours), colOrd, 10);
    textRight(hours(w.overtimeHours, { dashWhenZero: true }), colOt, 10, {
      color: w.overtimeHours > 0 ? INK : GREY,
    });
    textRight(hours(w.hours), colTot, 10, { bold: true });
    y -= 13;
    if (!w.xeroEmployeeId) {
      text('no Xero employee id', MARGIN + 8, 8, { color: GREY });
      y -= 11;
    }
    y -= 3;
  }

  ensure(24);
  rule();
  y -= 14;
  text('Period total', MARGIN, 10, { bold: true });
  textRight(String(totals.dayCount), colDays, 10, { bold: true });
  textRight(hours(totals.ordinaryHours), colOrd, 10, { bold: true });
  textRight(hours(totals.overtimeHours, { dashWhenZero: true }), colOt, 10, { bold: true });
  textRight(hours(totals.hours), colTot, 10, { bold: true });
  y -= 24;

  // ── Per-worker day breakdown ────────────────────────────────────────
  if (!includeDetail) return doc.save();

  // Wide enough for "Mon 03/08/2026" at 9pt before the job column starts.
  const dColDate = MARGIN + 95;
  const dColOrd = MARGIN + 330;
  const dColOt = MARGIN + 400;
  const dColTot = A4.width - MARGIN;

  ensure(40);
  text('Day breakdown', MARGIN, 12, { bold: true });
  y -= 20;

  for (const w of workers) {
    ensure(46);
    text(w.workerName, MARGIN, 10, { bold: true });
    textRight(`${hours(w.hours)} h total`, dColTot, 9, { color: GREY });
    y -= 13;
    rule();
    y -= 12;

    for (const e of w.entries) {
      if (ensure(16)) {
        text(`${w.workerName} (continued)`, MARGIN, 10, { bold: true });
        y -= 13;
        rule();
        y -= 12;
      }
      text(dayDate(e.date), MARGIN, 9);
      // Job is optional on an allocation — an internal/unallocated day says so
      // rather than rendering an empty cell.
      const jobLabel = e.jobName || 'No job on this entry';
      const maxJobWidth = dColOrd - dColDate - 24;
      let job = safeText(jobLabel);
      while (job && font.widthOfTextAtSize(job, 9) > maxJobWidth) job = job.slice(0, -1);
      text(job, dColDate, 9, { color: e.jobName ? INK : GREY });
      textRight(hours(e.ordinaryHours), dColOrd, 9);
      textRight(hours(e.overtimeHours, { dashWhenZero: true }), dColOt, 9, {
        color: e.overtimeHours > 0 ? INK : GREY,
      });
      textRight(hours(e.hours), dColTot, 9);
      y -= 13;
    }
    y -= 12;
  }

  return doc.save();
}

module.exports = { composePayrollPdf, rollupRows, longDate, dayDate, GENERATOR_VERSION };
