'use strict';

// Job cost report — pure render module, no I/O (owner pull 2026-09-28: "a full
// overview document that includes all hours and materials spent on a job").
//
// The printable face of the job hub's Money card: the SAME figures, read by the
// SAME endpoint (api/job-profitability.js ?format=pdf), so the document and the
// screen can never disagree. pdf-lib, standard-14 fonts, A4 portrait — the
// payroll-pdf precedent.
//
// Contents: header (job, site, status, generated), a summary band (contract,
// labour, materials, margin) with the completeness notes the card shows; then
// LABOUR — hours and cost by worker, and every approved day; then MATERIALS —
// by category (with measured quantities), every confirmed supplier invoice and
// receipt with its lines, and the typed materials ledger. Every figure is
// summed from the caller's rows; nothing is invented, and an uncosted worker
// or an unitemised invoice is named rather than hidden.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { longDate, dayDate } = require('./payroll-pdf');

const GENERATOR_VERSION = 'job-report-pdf/1';
const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 42;
const FOOT = 30;
const INK = rgb(0.05, 0.11, 0.2);
const GREY = rgb(0.42, 0.46, 0.57);
const RULE = rgb(0.85, 0.87, 0.9);
const BAND = rgb(0.96, 0.96, 0.94);
const YELLOW = rgb(1, 0.8, 0);
const RED = rgb(0.72, 0.12, 0.12);

function safeText(s) {
  return String(s === 0 ? '0' : s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/×/g, 'x').replace(/[^\x20-\x7E -ÿ]/g, '').trim();
}

/** Integer cents → "$1,234.56" / "-$154.00"; null → "-". */
function money(cents) {
  if (cents == null || !Number.isFinite(cents)) return '-';
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

function hrs(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `${v}h`;
}

function qty(q, unit) {
  if (q == null) return '';
  const n = Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100);
  return unit ? `${n} ${unit}` : n;
}

function measureText(m) {
  return Object.entries(m || {}).filter(([, v]) => v).map(([u, v]) => `${Math.round(v * 10) / 10} ${u}`).join(' + ');
}

/**
 * @param {object} input
 * @param {{ id: string, name: string, code?: string|null, siteAddress?: string|null, status?: string|null, clientName?: string|null }} input.job
 * @param {string} input.generatedAt ISO date (YYYY-MM-DD)
 * @param {{ contractValueCents: number|null, labourCostCents: number, materialCostCents: number, marginCents: number|null, marginPct: number|null }} input.money
 * @param {{ hoursTotal: number, pendingHours: number, unratedWorkers: string[], workers: Array<{ name: string, days: number, hours: number, costCents: number|null }>, days: Array<{ date: string, name: string, hours: number, costCents: number|null }> }} input.labour
 * @param {{ categories: Array<{ label: string, cents: number, measure?: object }>, invoices: Array<{ date: string|null, supplier: string, number: string|null, source: string, documentType: string, purchaser: string|null, amountCents: number, lines: Array<{ quantity: number|null, unit: string|null, description: string, category: string, signedCents: number }> }>, ledger: Array<{ date: string, supplier: string, description: string|null, amountCents: number }>, awaitingCount: number, invoicesShown: boolean, ledgerShown: boolean }} input.materials
 */
async function composeJobReportPdf(input) {
  const { job, labour, materials } = input;
  const m = input.money;
  const doc = await PDFDocument.create();
  const title = `${job.code ? job.code + ' ' : ''}${job.name}`;
  doc.setTitle(`Job cost report - ${safeText(title)}`);
  doc.setProducer(GENERATOR_VERSION);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = A4.width - MARGIN * 2;
  const right = A4.width - MARGIN;

  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;
  let continued = null; // repeats a section/table header on a new page

  function newPage() {
    page = doc.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
    if (continued) continued();
  }
  function ensure(h) {
    if (y - h < MARGIN + FOOT) { newPage(); return true; }
    return false;
  }
  function fit(s, f, size, maxW) {
    let t = safeText(s);
    if (f.widthOfTextAtSize(t, size) <= maxW) return t;
    while (t && f.widthOfTextAtSize(t + '...', size) > maxW) t = t.slice(0, -1);
    return t + '...';
  }
  function text(s, x, size, o = {}) {
    const f = o.bold ? bold : font;
    const t = o.maxW ? fit(s, f, size, o.maxW) : safeText(s);
    page.drawText(t, { x, y: y - size, size, font: f, color: o.color || INK });
  }
  function textR(s, xr, size, o = {}) {
    const f = o.bold ? bold : font;
    const t = safeText(s);
    page.drawText(t, { x: xr - f.widthOfTextAtSize(t, size), y: y - size, size, font: f, color: o.color || INK });
  }
  function rule(color = RULE) {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 1, color });
  }
  function heading(s) {
    ensure(44);
    y -= 8;
    text(s, MARGIN, 14, { bold: true });
    y -= 22;
    page.drawRectangle({ x: MARGIN, y: y + 4, width: 26, height: 2.5, color: YELLOW });
    y -= 8;
  }
  function sub(s) {
    ensure(30);
    text(s, MARGIN, 11, { bold: true });
    y -= 17;
  }
  function note(s) {
    // wrap a grey note across lines
    const words = safeText(s).split(' ');
    let line = '';
    for (const w of words) {
      const next = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(next, 8.5) > W) { ensure(12); text(line, MARGIN, 8.5, { color: GREY }); y -= 12; line = w; } else line = next;
    }
    if (line) { ensure(12); text(line, MARGIN, 8.5, { color: GREY }); y -= 12; }
  }

  // ── Header ──────────────────────────────────────────────────────────────
  text('BuhlOS', MARGIN, 10, { color: GREY, bold: true });
  textR(`Generated ${longDate(input.generatedAt)}`, right, 9, { color: GREY });
  y -= 14;
  text('Job cost report', MARGIN, 22, { bold: true });
  y -= 40;
  page.drawRectangle({ x: MARGIN, y: y + 6, width: 34, height: 3, color: YELLOW });
  y -= 12;
  text(title, MARGIN, 14, { bold: true, maxW: W });
  y -= 19;
  const meta = [job.siteAddress, job.clientName ? `Client: ${job.clientName}` : null, job.status ? `Status: ${job.status}` : null].filter(Boolean).join('   |   ');
  if (meta) { text(meta, MARGIN, 9.5, { color: GREY, maxW: W }); y -= 14; }
  note('All figures exclude GST. Labour is approved hours at internal cost rates. Materials are confirmed supplier invoices, receipts and typed dockets.');
  y -= 6;

  // ── Summary band ─────────────────────────────────────────────────────────
  page.drawRectangle({ x: MARGIN, y: y - 56, width: W, height: 60, color: BAND });
  const cell = W / 4;
  const band = [
    ['Contract', m.contractValueCents == null ? '-' : money(m.contractValueCents), m.contractValueCents == null ? 'not set' : ''],
    // hours with no cost rate at all are "not costed", never a $0.00 labour bill
    ['Labour', labour.hoursTotal && m.labourCostCents ? money(m.labourCostCents) : '-', labour.hoursTotal && !m.labourCostCents ? `${hrs(labour.hoursTotal)} approved - not costed` : `${hrs(labour.hoursTotal)} approved`],
    ['Materials', m.materialCostCents ? money(m.materialCostCents) : '-', ''],
    [m.marginPct == null ? 'Margin' : `Margin ${m.marginPct}%`, m.marginCents == null ? '-' : money(m.marginCents), m.marginCents == null ? 'needs a contract value' : ''],
  ];
  y -= 10;
  band.forEach(([label, value, cap], i) => {
    const x = MARGIN + cell * i + 12;
    page.drawText(safeText(label), { x, y: y - 8, size: 8, font, color: GREY });
    page.drawText(safeText(value), { x, y: y - 27, size: 15, font: bold, color: i === 3 && m.marginCents != null && m.marginCents < 0 ? RED : INK });
    if (cap) page.drawText(safeText(cap), { x, y: y - 41, size: 7.5, font, color: GREY });
  });
  y -= 60;
  if (labour.unratedWorkers.length) note(`Labour is understated: no cost rate is set for ${labour.unratedWorkers.join(', ')} - their hours are counted but not costed.`);
  if (labour.pendingHours > 0) note(`${hrs(labour.pendingHours)} more have been submitted but not approved yet - not included.`);
  if (materials.awaitingCount > 0) note(`${materials.awaitingCount} supplier invoice${materials.awaitingCount === 1 ? ' is' : 's are'} awaiting review and not included.`);

  // ── Labour ───────────────────────────────────────────────────────────────
  heading('Labour');
  if (!labour.workers.length) {
    note('No approved hours on this job yet.');
  } else {
    const cDays = MARGIN + 300, cHrs = MARGIN + 380, cCost = right;
    const hdr = () => {
      text('Worker', MARGIN, 8, { color: GREY, bold: true }); textR('Days', cDays, 8, { color: GREY, bold: true }); textR('Hours', cHrs, 8, { color: GREY, bold: true }); textR('Cost', cCost, 8, { color: GREY, bold: true });
      y -= 12; rule(); y -= 10;
    };
    sub('By worker');
    hdr();
    continued = () => { text('Labour by worker (continued)', MARGIN, 10, { bold: true }); y -= 16; hdr(); };
    for (const w of labour.workers) {
      ensure(15);
      text(w.name, MARGIN, 10, { maxW: 250 });
      textR(String(w.days), cDays, 10); textR(hrs(w.hours), cHrs, 10);
      textR(w.costCents == null ? 'no rate' : money(w.costCents), cCost, 10, { color: w.costCents == null ? GREY : INK });
      y -= 14;
    }
    ensure(20); rule(); y -= 13;
    text('Total', MARGIN, 10, { bold: true }); textR(hrs(labour.hoursTotal), cHrs, 10, { bold: true });
    textR(m.labourCostCents ? money(m.labourCostCents) : 'no rates set', cCost, 10, { bold: !!m.labourCostCents, color: m.labourCostCents ? INK : GREY });
    y -= 22;
    continued = null;

    sub('Day by day');
    const dW = MARGIN + 100, dH = MARGIN + 380;
    const dhdr = () => {
      text('Date', MARGIN, 8, { color: GREY, bold: true }); text('Worker', dW, 8, { color: GREY, bold: true }); textR('Hours', dH, 8, { color: GREY, bold: true }); textR('Cost', right, 8, { color: GREY, bold: true });
      y -= 12; rule(); y -= 10;
    };
    dhdr();
    continued = () => { text('Labour day by day (continued)', MARGIN, 10, { bold: true }); y -= 16; dhdr(); };
    for (const d of labour.days) {
      ensure(14);
      text(dayDate(d.date), MARGIN, 9); text(d.name, dW, 9, { maxW: 250 }); textR(hrs(d.hours), dH, 9);
      textR(d.costCents == null ? '-' : money(d.costCents), right, 9, { color: d.costCents == null ? GREY : INK });
      y -= 13;
    }
    continued = null;
  }

  // ── Materials ────────────────────────────────────────────────────────────
  heading('Materials');
  if (materials.source === 'received_proxy') {
    note(`The materials figure (${money(m.materialCostCents || 0)}) comes from the older received-materials rollup for this job - there is no line-by-line detail behind it.`);
  }
  if (!materials.invoicesShown && !materials.ledgerShown) {
    if (materials.source !== 'received_proxy') note('Materials are not tracked on this job yet.');
  } else {
    if (materials.categories.length) {
      sub('By category');
      const cAmt = MARGIN + 330, cShare = MARGIN + 380;
      const total = materials.categories.reduce((s, c) => s + c.cents, 0);
      text('Category', MARGIN, 8, { color: GREY, bold: true }); textR('Amount', cAmt, 8, { color: GREY, bold: true }); textR('Share', cShare, 8, { color: GREY, bold: true }); textR('Quantity', right, 8, { color: GREY, bold: true });
      y -= 12; rule(); y -= 10;
      for (const c of materials.categories) {
        ensure(14);
        text(c.label, MARGIN, 10); textR(money(c.cents), cAmt, 10);
        textR(total ? `${Math.round((c.cents / total) * 100)}%` : '', cShare, 9, { color: GREY });
        textR(measureText(c.measure), right, 9, { color: GREY });
        y -= 14;
      }
      y -= 8;
    }

    if (materials.invoicesShown) {
      sub(`Supplier invoices and receipts (${materials.invoices.length})`);
      if (!materials.invoices.length) note('No supplier invoices have been confirmed against this job yet.');
      const lQ = MARGIN + 12, lD = MARGIN + 70, lC = MARGIN + 380, lT = right;
      for (const inv of materials.invoices) {
        ensure(34);
        const head = [inv.date ? dayDate(inv.date) : 'no date', inv.supplier, inv.number || 'no number'].join('   ');
        text(head, MARGIN, 9.5, { bold: true, maxW: W - 90 });
        textR(money(inv.amountCents), right, 9.5, { bold: true, color: inv.amountCents < 0 ? RED : INK });
        y -= 13;
        const tags = [inv.documentType === 'credit_note' ? 'credit note' : null, inv.source === 'receipt' ? 'receipt' : null, inv.purchaser ? `picked up by ${inv.purchaser}` : null, inv.lines.length ? null : 'lines not itemised'].filter(Boolean).join(' | ');
        if (tags) { text(tags, MARGIN, 8, { color: GREY }); y -= 11; }
        for (const l of inv.lines) {
          ensure(12);
          text(qty(l.quantity, l.unit), lQ, 8.5, { color: GREY, maxW: 54 });
          text(l.description, lD, 8.5, { maxW: lC - lD - 8 });
          text(l.category, lC, 8, { color: GREY, maxW: lT - lC - 60 });
          textR(money(l.signedCents), lT, 8.5);
          y -= 11;
        }
        y -= 4; rule(); y -= 8;
      }
    }

    if (materials.ledgerShown && materials.ledger.length) {
      sub(`Typed materials (${materials.ledger.length})`);
      const cS = MARGIN + 100, cF = MARGIN + 260;
      text('Date', MARGIN, 8, { color: GREY, bold: true }); text('Supplier', cS, 8, { color: GREY, bold: true }); text('What for', cF, 8, { color: GREY, bold: true }); textR('Amount', right, 8, { color: GREY, bold: true });
      y -= 12; rule(); y -= 10;
      for (const l of materials.ledger) {
        ensure(13);
        text(dayDate(l.date), MARGIN, 9); text(l.supplier, cS, 9, { maxW: cF - cS - 8 }); text(l.description || '-', cF, 9, { maxW: right - cF - 70, color: l.description ? INK : GREY }); textR(money(l.amountCents), right, 9);
        y -= 13;
      }
    }

    ensure(26); y -= 4; rule(INK); y -= 14;
    text('Materials total', MARGIN, 11, { bold: true }); textR(money(m.materialCostCents || 0), right, 11, { bold: true });
    y -= 20;
  }

  // ── Footer on every page ────────────────────────────────────────────────
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const s = safeText(`Job cost report  |  ${title}  |  page ${i + 1} of ${pages.length}`);
    p.drawText(s, { x: MARGIN, y: MARGIN - 12, size: 7.5, font, color: GREY });
    const v = GENERATOR_VERSION;
    p.drawText(v, { x: right - font.widthOfTextAtSize(v, 7.5), y: MARGIN - 12, size: 7.5, font, color: GREY });
  });
  return doc.save();
}

module.exports = { composeJobReportPdf, money, GENERATOR_VERSION };
