// BuhlOS — BOQ / pricing-workbook import (read-only preview).  (#365 first increment)
//
// A real electrical job arrives as a hand-built pricing spreadsheet (the
// Sansara "Pricing … REV 5.xlsx" is the worked example): the WHOLE scope,
// quantities, supply/install split, value-engineering notes and commercial
// totals in one messy sheet. Today the only way into BuhlOS is to retype it.
//
// This module turns that workbook into a STRUCTURED, REVIEWABLE preview:
//   - a dependency-free .xlsx reader (ZIP + OOXML, Node `zlib` only — the repo
//     ships no spreadsheet lib and prefers it that way), and
//   - a tolerant BOQ parser that classifies lines into packages, pulls the
//     L-codes / quantities / rates, runs commercial health-checks (does the sum
//     reconcile to the stated total?) and flags every ambiguity a human must
//     resolve before it becomes job data (supplied-by-others, VE, PC-sums,
//     "please confirm", excluded options, long-lead).
//
// HARD CONTRACT: this is PURE and READ-ONLY. It extracts and structures; it
// NEVER writes a job, quote, material or blob. The handler (api/job-doc-import.js)
// only ever returns this preview. Turning a reviewed preview INTO job/quote data
// is a separate, later slice gated on the canonical task model (#479) — do not
// add a write path here.
//
// Tested by src/domains/job-doc-import/boq-import.test.ts (vitest imports this
// CJS module, the api/_lib convention). Types: ./boq-import.d.ts.

const zlib = require('zlib');

// ───────────────────────── .xlsx (ZIP + OOXML) reader ─────────────────────────

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/** Decompress every entry of a ZIP buffer → { '<name>': Buffer }. Reads the
 *  central directory (authoritative sizes/offsets), so it is robust to data
 *  descriptors. ZIP64 is not handled (job workbooks are well under 4 GB). */
function unzip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  // Locate the End Of Central Directory record (scan back over the optional comment).
  let p = buf.length - 22;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (; p >= min; p--) {
    if (buf.readUInt32LE(p) === SIG_EOCD) break;
  }
  if (p < min) throw new Error('not a zip/xlsx (no EOCD record)');
  const count = buf.readUInt16LE(p + 10);
  let o = buf.readUInt32LE(p + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(o) !== SIG_CEN) break;
    const method = buf.readUInt16LE(o + 10);
    const compSize = buf.readUInt32LE(o + 20);
    const nameLen = buf.readUInt16LE(o + 28);
    const extraLen = buf.readUInt16LE(o + 30);
    const commentLen = buf.readUInt16LE(o + 32);
    const localOffset = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nameLen);
    out[name] = readLocalEntry(buf, localOffset, method, compSize);
    o += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readLocalEntry(buf, localOffset, method, compSize) {
  if (buf.readUInt32LE(localOffset) !== SIG_LOC) throw new Error('bad local file header');
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return Buffer.from(data); // stored
  if (method === 8) return zlib.inflateRawSync(data); // deflate
  throw new Error('unsupported zip compression method ' + method);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so we never double-decode
}
function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/** Shared string table: concat every <t> run inside each <si>. */
function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(m[1]))) text += decodeEntities(tm[1]);
    out.push(text);
  }
  return out;
}

/** Sheet names in workbook (document) order. */
function parseSheetNames(xml) {
  const names = [];
  const re = /<sheet\b[^>]*\bname="([^"]*)"[^>]*?>/g;
  let m;
  while ((m = re.exec(xml))) names.push(decodeEntities(m[1]));
  return names;
}

function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** One worksheet → array of rows, each a column-indexed array of cell strings.
 *  Cells keep embedded newlines (a multi-line description cell stays one cell). */
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const rMatch = /\br="([^"]+)"/.exec(attrs);
      const tMatch = /\bt="([^"]+)"/.exec(attrs);
      const col = rMatch ? colToIndex(rMatch[1]) : cells.length;
      const t = tMatch ? tMatch[1] : null;
      let val = '';
      if (t === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (v) val = shared[parseInt(v[1], 10)] || '';
      } else if (t === 'inlineStr') {
        const isRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let im;
        while ((im = isRe.exec(inner))) val += decodeEntities(im[1]);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (v) val = decodeEntities(v[1]);
      }
      cells[col] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/** Buffer/Uint8Array of an .xlsx → { sheets: [{ name, rows }] }. */
function extractXlsxGrid(buf) {
  const entries = unzip(buf);
  const shared = entries['xl/sharedStrings.xml']
    ? parseSharedStrings(entries['xl/sharedStrings.xml'].toString('utf8'))
    : [];
  const names = entries['xl/workbook.xml']
    ? parseSheetNames(entries['xl/workbook.xml'].toString('utf8'))
    : [];
  const sheetFiles = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/sheet(\d+)\.xml/.exec(a)[1]) - Number(/sheet(\d+)\.xml/.exec(b)[1]));
  const sheets = sheetFiles.map((f, i) => ({
    name: names[i] || 'Sheet' + (i + 1),
    rows: parseSheet(entries[f].toString('utf8'), shared),
  }));
  return { sheets };
}

// ───────────────────────────── BOQ parsing ─────────────────────────────

function txt(s) { return s == null ? '' : String(s).trim(); }
function rowText(row) { return (row || []).map(txt).join(' ').replace(/\s+/g, ' ').trim(); }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/** Tolerant money/quantity cell → number|null. Handles "$1,200", " 16 ", "". */
function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/[$,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "Supply and install L1.1 - …" / "…7.2 -" / "…47 Opt. 3" → "L1.1" | "L7.2" | "L47 Opt 3" | null. */
function extractCode(desc) {
  const m = /supply\s+(?:and|&)\s+install\s+(L?\s*\d+(?:\.\d+)?(?:\s*opt\.?\s*\d+)?)/i.exec(desc || '');
  if (!m) return null;
  let c = m[1].replace(/\s+/g, ' ').trim().replace(/opt\.?/i, 'Opt');
  if (!/^l/i.test(c)) c = 'L' + c.replace(/^\s+/, '');
  return c.replace(/^l/, 'L').replace(/\s*opt/i, ' Opt');
}

const FLAG_RULES = [
  ['supplied_by_others', /supplied by curator|by joiner|supplied by joiner|by others|by builder|by sauna contractor|connection only/i],
  ['value_engineered', /\bve\b|value eng|reduced quantity as per ve/i],
  ['provisional_sum', /pc sum|provisional/i],
  ['needs_clarification', /please confirm|no proper info|to be confirmed|\btbc\b|subject to change|may change|confirm suitability|still to be confirmed|need.* confirmed/i],
  ['long_lead', /lead time|sea freight|air freight/i],
];

function detectFlags(desc, notes, qty) {
  const hay = (desc + ' ' + notes);
  const flags = [];
  for (const [kind, re] of FLAG_RULES) if (re.test(hay)) flags.push(kind);
  if (qty === 0) flags.push('excluded');
  return flags;
}

const FLAG_MESSAGE = {
  supplied_by_others: 'Supply responsibility is not ours (curator/joiner/builder) — confirm the boundary before ordering.',
  value_engineered: 'Value-engineered / quantity changed at a VE meeting — confirm the agreed option and count.',
  provisional_sum: 'Provisional (PC) sum — scope/price to be confirmed.',
  needs_clarification: 'Insufficient or changing information — raise an RFI before it becomes firm scope.',
  long_lead: 'Long-lead item — flag for early procurement.',
  excluded: 'Quantity is zero — excluded option, do not order without instruction.',
};

// Section banners and the table header row.
function classifyBanner(line) {
  const l = line.toLowerCase();
  if (/^electrical\b/.test(l) && l.length < 40) return 'electrical';
  if (/lighting (tender|supply|total)|lighting & electrical|lighting tender a/.test(l)) return 'lighting';
  return null;
}
function isHeaderRow(row) {
  const a = txt(row[0]).toLowerCase();
  const joined = rowText(row).toLowerCase();
  return a === 'item' && /quantity/.test(joined);
}
function isTotalsRow(row) {
  return /total ex gst|lighting total|grand total/i.test(rowText(row));
}

/**
 * Parse the extracted grid into a structured, reviewable BOQ preview with
 * commercial health-checks and an ambiguities list. Pure.
 */
function parseBoq(grid) {
  const sheets = (grid && grid.sheets) || [];
  const lines = [];
  const ambiguities = [];
  const stated = {}; // { lighting, electrical, grand }

  let section = null;
  let inTable = false;

  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const a = txt(row[0]);
      const whole = rowText(row);
      if (!whole) continue;

      const banner = classifyBanner(whole);
      if (banner && !isHeaderRow(row)) {
        section = banner;
        inTable = false;
      }

      if (isHeaderRow(row)) { inTable = true; continue; }

      if (isTotalsRow(row)) {
        const amounts = row.map(num).filter((n) => n != null && n > 0);
        const value = amounts.length ? amounts[amounts.length - 1] : null;
        if (/grand total/i.test(whole)) stated.grand = value;
        else if (/lighting total/i.test(whole)) stated.lighting = value;
        else if (/electrical total/i.test(whole)) stated.electrical = value;
        continue;
      }

      if (!inTable || !a) continue;

      const qty = num(row[1]);
      // A row with no item text or no numeric in the qty column is a note /
      // spacer / continuation — skip it (we do not invent lines).
      if (qty == null) continue;

      // Lighting layout: item|qty|supplyRate|supplySub|installRate|installSub|notes
      // Electrical layout: item|qty|rate|subtotal|notes
      const isLighting = section !== 'electrical';
      const notes = isLighting ? txt(row[6]) : txt(row[4]);
      const supplyRate = isLighting ? num(row[2]) : num(row[2]);
      const supplyAmt = isLighting ? num(row[3]) : num(row[3]);
      const installRate = isLighting ? num(row[4]) : null;
      const installAmt = isLighting ? num(row[5]) : null;
      const lineTotal = round2((supplyAmt || 0) + (installAmt || 0));

      const description = a.replace(/\s+/g, ' ').trim();
      const flags = detectFlags(a, notes, qty);
      const code = extractCode(a);

      const line = {
        section: isLighting ? 'lighting' : 'electrical',
        code,
        description,
        qty,
        supplyRate,
        supplyAmount: supplyAmt,
        installRate,
        installAmount: installAmt,
        lineTotal,
        notes,
        flags,
      };
      lines.push(line);

      for (const kind of flags) {
        ambiguities.push({
          kind,
          ref: code || description.slice(0, 60),
          message: FLAG_MESSAGE[kind] || kind,
        });
      }
    }
  }

  const sum = (key, sec) =>
    round2(lines.filter((l) => l.section === sec).reduce((t, l) => t + (l[key] || 0), 0));
  const computedLighting = sum('lineTotal', 'lighting');
  const computedElectrical = sum('lineTotal', 'electrical');
  const computedGrand = round2(computedLighting + computedElectrical);

  const recon = (computed, statedVal) => {
    if (statedVal == null) return { computed, stated: null, delta: null, reconciles: null };
    const delta = round2(computed - statedVal);
    return { computed, stated: statedVal, delta, reconciles: Math.abs(delta) < 1 };
  };

  const byFlag = {};
  for (const a of ambiguities) byFlag[a.kind] = (byFlag[a.kind] || 0) + 1;

  return {
    source: { sheetCount: sheets.length, sheetNames: sheets.map((s) => s.name) },
    sections: [
      { key: 'lighting', lineCount: lines.filter((l) => l.section === 'lighting').length, ...recon(computedLighting, stated.lighting ?? null) },
      { key: 'electrical', lineCount: lines.filter((l) => l.section === 'electrical').length, ...recon(computedElectrical, stated.electrical ?? null) },
    ],
    totals: recon(computedGrand, stated.grand ?? null),
    lines,
    ambiguities,
    counts: { lines: lines.length, byFlag },
  };
}

/** Convenience: .xlsx buffer → preview. */
function parseBoqFromXlsx(buf) {
  return parseBoq(extractXlsxGrid(buf));
}

module.exports = { extractXlsxGrid, parseBoq, parseBoqFromXlsx };
