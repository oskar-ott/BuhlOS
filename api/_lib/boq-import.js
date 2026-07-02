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

/** Excel error literals a cell can evaluate to (t="e") or carry as text. */
const ERROR_TOKENS = new Set(['#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#N/A', '#NUM!', '#NULL!']);

/** 0-based column index → "A"/"B"/…/"AA" (inverse of colToIndex). */
function colName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * One worksheet → rows of CELL OBJECTS `{ ref, v, f, err }` keeping the sheet
 * coordinates (`ref`, e.g. "E10"), whether the cell holds a formula (`f`,
 * `<f>` element present) and any Excel error token it evaluated to (`err`,
 * e.g. "#REF!"). The provenance/health layer (#365) needs all three; the
 * plain string grid below is a projection of this.
 */
function parseSheetCells(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rAttr = /\br="(\d+)"/.exec(rm[1] || '');
    const rowNum = rAttr ? parseInt(rAttr[1], 10) : rows.length + 1;
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[2]))) {
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
      const trimmed = String(val).trim();
      cells[col] = {
        ref: rMatch ? rMatch[1] : colName(col) + rowNum,
        v: val,
        f: /<f[\s>/]/.test(inner),
        err: t === 'e' || ERROR_TOKENS.has(trimmed) ? trimmed || '#ERROR' : null,
      };
    }
    rows.push({ rowNum, cells });
  }
  return rows;
}

/** One worksheet → array of rows, each a column-indexed array of cell strings.
 *  Cells keep embedded newlines (a multi-line description cell stays one cell). */
function parseSheet(xml, shared) {
  return parseSheetCells(xml, shared).map((row) =>
    Array.from(row.cells, (c) => (c ? c.v : ''))
  );
}

function readWorkbookEntries(buf) {
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
  return { entries, shared, names, sheetFiles };
}

/** Buffer/Uint8Array of an .xlsx → { sheets: [{ name, rows }] }. */
function extractXlsxGrid(buf) {
  const { entries, shared, names, sheetFiles } = readWorkbookEntries(buf);
  const sheets = sheetFiles.map((f, i) => ({
    name: names[i] || 'Sheet' + (i + 1),
    rows: parseSheet(entries[f].toString('utf8'), shared),
  }));
  return { sheets };
}

/** Buffer/Uint8Array of an .xlsx → { sheets: [{ name, rows: [{ rowNum,
 *  cells: [{ ref, v, f, err }] }] }] } — the cell-level grid keeping sheet/cell
 *  provenance, formula presence and error tokens (#365 health checks). */
function extractXlsxCells(buf) {
  const { entries, shared, names, sheetFiles } = readWorkbookEntries(buf);
  const sheets = sheetFiles.map((f, i) => ({
    name: names[i] || 'Sheet' + (i + 1),
    rows: parseSheetCells(entries[f].toString('utf8'), shared),
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

// ─────────────────── Quote workbook import + health checks (#365) ───────────────────
//
// The generic, layout-tolerant parse used when a quote workbook is imported
// AGAINST A QUOTE (the parseBoq above is the Sansara-shaped preview). It keeps
// {sheet, cell} provenance per line, runs the named health checks the issue
// pins (formula errors, qty×rate ≠ subtotal, subtotal with missing inputs,
// hardcoded numbers among formula siblings, section totals ≠ stated total),
// and defaults a per-line classification (base / alternate / exclusion /
// pc_sum / by_others) from detection text — every default human-confirmable.
// PURE: extracts and flags; persists nothing.

const QUOTE_LINE_CLASSIFICATIONS = ['base', 'alternate', 'exclusion', 'pc_sum', 'by_others'];

/** Detection defaults ("Alternative", "by others", "PC"/"provisional"), most
 *  specific first. qty === 0 is an excluded option (never priced in). */
function detectClassification(description, qty) {
  const d = ' ' + String(description || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  if (qty === 0 || /\bexcluded\b|\bexclusion\b|\bnot included\b/.test(d)) {
    return {
      classification: 'exclusion',
      reason: qty === 0 ? 'quantity is zero' : 'matched "excluded"',
    };
  }
  if (/\balternative\b|\balternate\b|\balt\.\s/.test(d)) {
    return { classification: 'alternate', reason: 'matched "Alternative"' };
  }
  if (/by others\b|supplied by (the )?(curator|joiner|builder|others|sauna)|connection only/.test(d)) {
    return { classification: 'by_others', reason: 'matched "by others"' };
  }
  if (/\bpc sum\b|\bpc\b|provisional|\ballowance\b/.test(d)) {
    return { classification: 'pc_sum', reason: 'matched "PC/provisional"' };
  }
  return { classification: 'base', reason: null };
}

/** Is this row a column-header row? Returns the column map or null. A BOQ
 *  table needs a description + quantity column and at least one money column. */
function detectColumns(cells) {
  let desc = null;
  let qty = null;
  let unit = null;
  let rate = null;
  let subtotal = null;
  let firstText = null;
  cells.forEach((c, i) => {
    if (!c) return;
    const t = String(c.v).trim().toLowerCase();
    if (!t) return;
    if (firstText === null) firstText = i;
    if (desc === null && /desc|^item\b|particular/.test(t)) desc = i;
    if (qty === null && /^(qty|quantity|no\.?|nr)\b|quantity/.test(t)) qty = i;
    if (unit === null && /^unit\b|^uom\b/.test(t)) unit = i;
    if (rate === null && /rate|unit price|^price\b/.test(t) && !/total/.test(t)) rate = i;
    if (subtotal === null && /amount|sub.?total/.test(t)) subtotal = i;
  });
  if (subtotal === null) {
    cells.forEach((c, i) => {
      if (subtotal !== null || !c) return;
      if (/^total\b/.test(String(c.v).trim().toLowerCase()) && i !== rate) subtotal = i;
    });
  }
  if (desc === null) desc = firstText;
  if (desc === null || qty === null || (rate === null && subtotal === null)) return null;
  return { desc, qty, unit, rate, subtotal };
}

const STATED_TOTAL_RE =
  /\b(?:boq|tender|contract|quote|project)\s+(?:value|total|sum)\b|\bgrand\s+total\b|\bstated\s+total\b/i;

function cellNum(cell) {
  if (!cell || cell.err) return null;
  return num(cell.v);
}

function cellRefOf(sheetName, cell, colIdx, rowNum) {
  return sheetName + '!' + (cell ? cell.ref : colName(colIdx == null ? 0 : colIdx) + rowNum);
}

/**
 * Parse the cell-level grid of a quote workbook into structured BOQ lines with
 * provenance, per-line classification defaults and the named health findings.
 * Pure — no I/O.
 */
function parseQuoteWorkbook(cellGrid) {
  const sheets = (cellGrid && cellGrid.sheets) || [];
  const lines = [];
  const findings = [];
  const sectionOrder = [];
  const sectionStated = new Map(); // section name → { value, cellRef }
  let statedTotal = null;

  const seenFindingIds = new Set();
  const pushFinding = (kind, severity, cellRef, message) => {
    let id = kind + ':' + cellRef;
    let n = 2;
    while (seenFindingIds.has(id)) id = kind + ':' + cellRef + '#' + n++;
    seenFindingIds.add(id);
    findings.push({ id, kind, severity, cellRef, message });
  };

  // Pass 1 — formula error tokens, anywhere in the workbook (#REF!/#VALUE!/#DIV/0!…).
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        if (cell && cell.err) {
          pushFinding(
            'formula_error',
            'error',
            sheet.name + '!' + cell.ref,
            `Formula error ${cell.err} in ${cell.ref} — the workbook is computing on a broken reference.`
          );
        }
      }
    }
  }

  // Pass 2 — table extraction with provenance + line-level checks.
  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s];
    let section = null;
    let cols = null;

    for (const row of sheet.rows) {
      const cells = row.cells;
      const textParts = [];
      let hasNumeric = false;
      for (const c of cells) {
        if (!c) continue;
        const t = String(c.v).trim();
        if (t) textParts.push(t);
        if (cellNum(c) != null) hasNumeric = true;
      }
      const text = textParts.join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const headerCols = detectColumns(cells);
      if (headerCols) {
        cols = headerCols;
        continue;
      }

      // A stated workbook total ("BOQ value $46,034", "Grand total") — the
      // number the section totals must reconcile to. First one wins (headers
      // state the headline; a bottom grand-total only fills a gap).
      if (STATED_TOTAL_RE.test(text) && hasNumeric) {
        if (!statedTotal) {
          let value = null;
          let ref = null;
          for (const c of cells) {
            const n = cellNum(c);
            if (n != null && n > 0) {
              value = n;
              ref = sheet.name + '!' + c.ref;
            }
          }
          if (value != null) statedTotal = { value, cellRef: ref };
        }
        continue;
      }

      if (cols) {
        const descCell = cells[cols.desc];
        const qtyCell = cols.qty != null ? cells[cols.qty] : undefined;
        const rateCell = cols.rate != null ? cells[cols.rate] : undefined;
        const subCell = cols.subtotal != null ? cells[cols.subtotal] : undefined;
        const description = descCell ? String(descCell.v).replace(/\s+/g, ' ').trim() : '';
        const qty = cellNum(qtyCell);
        const rate = cellNum(rateCell);
        const subtotal = cellNum(subCell);
        const rowErr = [qtyCell, rateCell, subCell].some((c) => c && c.err);

        // A section-total row ("East Gym total") — capture the stated figure.
        if (description && /\btotal\b/i.test(description) && qty == null) {
          let value = subtotal;
          let ref = subCell ? sheet.name + '!' + subCell.ref : null;
          if (value == null) {
            for (const c of cells) {
              const n = cellNum(c);
              if (n != null) {
                value = n;
                ref = sheet.name + '!' + c.ref;
              }
            }
          }
          const key = section || '(no section)';
          if (value != null && !sectionStated.has(key)) {
            sectionStated.set(key, { value, cellRef: ref });
          }
          cols = null; // the total closes this table
          continue;
        }

        const isLine = description && (qty != null || subtotal != null || rowErr);
        if (!isLine) {
          // Text-only row inside/around a table = a section banner.
          if (description && !hasNumeric && !/\btotal\b/i.test(description)) {
            section = description.slice(0, 80);
          }
          continue;
        }

        const lineTotal =
          subtotal != null ? subtotal : qty != null && rate != null ? round2(qty * rate) : null;
        const det = detectClassification(description, qty);
        const line = {
          id: 'wl_' + (s + 1) + '_' + row.rowNum,
          sheet: sheet.name,
          row: row.rowNum,
          section,
          description,
          qty,
          unit: cols.unit != null && cells[cols.unit] ? String(cells[cols.unit].v).trim() : '',
          rate,
          subtotal,
          lineTotal,
          classification: det.classification,
          classificationReason: det.reason,
          subtotalHasFormula: Boolean(subCell && subCell.f),
          cells: {
            description: cellRefOf(sheet.name, descCell, cols.desc, row.rowNum),
            qty: cols.qty != null ? cellRefOf(sheet.name, qtyCell, cols.qty, row.rowNum) : null,
            unit:
              cols.unit != null
                ? cellRefOf(sheet.name, cells[cols.unit], cols.unit, row.rowNum)
                : null,
            rate: cols.rate != null ? cellRefOf(sheet.name, rateCell, cols.rate, row.rowNum) : null,
            subtotal:
              cols.subtotal != null ? cellRefOf(sheet.name, subCell, cols.subtotal, row.rowNum) : null,
          },
        };
        if (section && !sectionOrder.includes(section)) sectionOrder.push(section);
        lines.push(line);

        // qty×rate ≠ subtotal beyond rounding (the mispriced-circuit trap).
        if (qty != null && rate != null && subtotal != null) {
          const expected = round2(qty * rate);
          const tolerance = 0.015 + 0.005 * Math.abs(qty);
          if (Math.abs(expected - subtotal) > tolerance) {
            pushFinding(
              'qty_rate_mismatch',
              'error',
              line.cells.subtotal,
              `"${description.slice(0, 60)}": ${qty} × ${rate} = ${expected}, but the subtotal says ${subtotal} (off by ${round2(subtotal - expected)}).`
            );
          }
        }

        // A subtotal with no qty or no rate behind it — unauditable money.
        if (subtotal != null && (qty == null || rate == null)) {
          pushFinding(
            'subtotal_missing_inputs',
            'warning',
            line.cells.subtotal,
            `"${description.slice(0, 60)}" has a subtotal of ${subtotal} but no ${qty == null ? 'quantity' : 'rate'} — the number can't be checked.`
          );
        }
      } else if (!hasNumeric && text.length <= 80) {
        // Outside any table: a short text-only row is a section banner.
        section = text.slice(0, 80);
      }
    }
  }

  // Pass 3 — hardcoded subtotal among formula siblings (per section).
  const bySection = new Map();
  for (const line of lines) {
    const key = line.section || '(no section)';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(line);
  }
  for (const [, sectionLines] of bySection) {
    // Only lines that COULD compute (qty + rate present) are hardcode-checkable;
    // a qty/rate-less subtotal is already named by subtotal_missing_inputs.
    const withSubtotal = sectionLines.filter(
      (l) => l.subtotal != null && l.qty != null && l.rate != null
    );
    const formulas = withSubtotal.filter((l) => l.subtotalHasFormula);
    const hardcoded = withSubtotal.filter((l) => !l.subtotalHasFormula);
    if (formulas.length >= 2 && hardcoded.length >= 1 && formulas.length > hardcoded.length) {
      for (const l of hardcoded) {
        pushFinding(
          'hardcoded_value',
          'warning',
          l.cells.subtotal,
          `"${l.description.slice(0, 60)}" subtotal is a typed number while sibling rows compute theirs — a hand-edit that formulas won't update.`
        );
      }
    }
  }

  // Sections rollup (computed vs the workbook's stated section totals).
  const allSections = [...new Set([...sectionOrder, ...sectionStated.keys()])];
  const sections = allSections.map((name) => {
    const sectionLines = lines.filter((l) => (l.section || '(no section)') === name);
    const computed = round2(sectionLines.reduce((t, l) => t + (l.lineTotal || 0), 0));
    const base = round2(
      sectionLines
        .filter((l) => l.classification === 'base')
        .reduce((t, l) => t + (l.lineTotal || 0), 0)
    );
    const stated = sectionStated.get(name) || null;
    return {
      name,
      lineCount: sectionLines.length,
      computed,
      base,
      stated: stated ? stated.value : null,
      statedCellRef: stated ? stated.cellRef : null,
      reconciles: stated ? Math.abs(computed - stated.value) < 1 : null,
    };
  });

  // Sum of section totals ≠ the workbook's stated total (the $46,034 trap).
  if (statedTotal && sections.length > 0) {
    const sectionSum = round2(
      sections.reduce((t, s) => t + (s.stated != null ? s.stated : s.computed), 0)
    );
    if (Math.abs(sectionSum - statedTotal.value) >= 1) {
      pushFinding(
        'total_mismatch',
        'error',
        statedTotal.cellRef,
        `Section totals sum to ${sectionSum} but the workbook states ${statedTotal.value} (off by ${round2(statedTotal.value - sectionSum)}) — the headline number does not reconcile.`
      );
    }
  }

  // Alternative-marked lines counted in a base total: the stated figure only
  // reconciles WITH the alternates included → each alternate is double-counted
  // until a human confirms it in or out.
  const flagAlternatesInBase = (scopedLines, statedValue) => {
    const alternates = scopedLines.filter(
      (l) => l.classification === 'alternate' && (l.lineTotal || 0) > 0
    );
    if (!alternates.length || statedValue == null) return;
    const all = round2(scopedLines.reduce((t, l) => t + (l.lineTotal || 0), 0));
    const altSum = round2(alternates.reduce((t, l) => t + (l.lineTotal || 0), 0));
    if (Math.abs(all - statedValue) < 1 && Math.abs(all - altSum - statedValue) >= 1) {
      for (const l of alternates) {
        pushFinding(
          'alternate_counted_in_base',
          'error',
          l.cells.subtotal || l.cells.description,
          `"${l.description.slice(0, 60)}" is marked Alternative but its ${l.lineTotal} is counted in the base total — confirm it in or out before relying on the number.`
        );
      }
    }
  };
  let anySectionStated = false;
  for (const s of sections) {
    if (s.stated != null) {
      anySectionStated = true;
      flagAlternatesInBase(
        lines.filter((l) => (l.section || '(no section)') === s.name),
        s.stated
      );
    }
  }
  if (!anySectionStated && statedTotal) flagAlternatesInBase(lines, statedTotal.value);

  // Totals by classification. Base NEVER includes alternates (or exclusions /
  // PC sums / by-others money) — the AC's hard rule.
  const byClassification = {};
  for (const c of QUOTE_LINE_CLASSIFICATIONS) byClassification[c] = 0;
  for (const l of lines) {
    byClassification[l.classification] = round2(
      byClassification[l.classification] + (l.lineTotal || 0)
    );
  }
  const all = round2(lines.reduce((t, l) => t + (l.lineTotal || 0), 0));

  const bySeverity = { error: 0, warning: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  return {
    source: { sheetCount: sheets.length, sheetNames: sheets.map((sh) => sh.name) },
    lines: lines.map(({ subtotalHasFormula, ...wire }) => wire),
    sections,
    statedTotal,
    totals: {
      all,
      base: byClassification.base,
      byClassification,
      stated: statedTotal ? statedTotal.value : null,
      delta: statedTotal ? round2(all - statedTotal.value) : null,
      reconciles: statedTotal ? Math.abs(all - statedTotal.value) < 1 : null,
    },
    findings,
    counts: { lines: lines.length, findings: findings.length, bySeverity },
  };
}

/** Convenience: .xlsx buffer → quote-workbook parse with health findings. */
function parseQuoteWorkbookFromXlsx(buf) {
  return parseQuoteWorkbook(extractXlsxCells(buf));
}

module.exports = {
  extractXlsxGrid,
  extractXlsxCells,
  parseBoq,
  parseBoqFromXlsx,
  parseQuoteWorkbook,
  parseQuoteWorkbookFromXlsx,
  QUOTE_LINE_CLASSIFICATIONS,
};
