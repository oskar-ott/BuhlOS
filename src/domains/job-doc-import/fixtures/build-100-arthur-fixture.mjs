#!/usr/bin/env node
// Builds the committed 100-Arthur-shaped fixture workbook (#365):
//
//   node src/domains/job-doc-import/fixtures/build-100-arthur-fixture.mjs
//
// → 100-arthur-boq.xlsx (next to this script). Commit the regenerated binary
// whenever this script changes — the parser tests read the committed file.
//
// The fixture reproduces the real 100 Arthur St failure modes with sanitised
// numbers (same failure shapes as the issue pins):
//   - E6  Dedicated 20A ZIP circuit: 2 × $450 stated as $1,400 (qty×rate ≠ subtotal),
//         and the subtotal is a typed number while siblings are formulas (hardcoded).
//   - E10 Switchboard modifications: a live formula evaluating to #REF!.
//   - E2  Header states a $46,034 BOQ value; the section totals are
//         $28,820 (East Gym) + $12,730 (Upper Ground) = $41,550 — no reconcile.
//   - E9  PL3 pendants marked "Alternative" yet counted in the East Gym total.
//   - E18 A subtotal ($500 allowance) with no qty and no rate behind it.
//   - A17 A "by others" data-cabling line (classification detection).
//
// The zip is written with real CRC-32s and stored (uncompressed) entries, plus
// the minimal OOXML parts, so the file opens in Excel — it is a genuine .xlsx,
// not just something our reader tolerates.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Minimal zip writer (stored entries, real CRC-32) ─────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ── Sheet content ─────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const str = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${esc(text)}</t></is></c>`;
const numc = (ref, v) => `<c r="${ref}"><v>${v}</v></c>`;
const fnum = (ref, formula, v) => `<c r="${ref}"><f>${esc(formula)}</f><v>${v}</v></c>`;
const errc = (ref, formula, token) =>
  `<c r="${ref}" t="e"><f>${esc(formula)}</f><v>${esc(token)}</v></c>`;

const rows = [
  `<row r="1">${str("A1", "100 Arthur St — Electrical services")}</row>`,
  `<row r="2">${str("A2", "BOQ value")}${numc("E2", 46034)}</row>`,
  `<row r="4">${str("A4", "East Gym")}</row>`,
  `<row r="5">${str("A5", "Description")}${str("B5", "Qty")}${str("C5", "Unit")}${str("D5", "Rate")}${str("E5", "Amount")}</row>`,
  // The ZIP-circuit trap: 2 × 450 = 900, stated 1400, typed (no formula).
  `<row r="6">${str("A6", "Dedicated 20A ZIP circuit — boiling water unit")}${numc("B6", 2)}${str("C6", "ea")}${numc("D6", 450)}${numc("E6", 1400)}</row>`,
  `<row r="7">${str("A7", "LED highbay luminaires — supply and install")}${numc("B7", 20)}${str("C7", "ea")}${numc("D7", 300)}${fnum("E7", "B7*D7", 6000)}</row>`,
  `<row r="8">${str("A8", "Sub-mains cabling from MSB")}${numc("B8", 1)}${str("C8", "lot")}${numc("D8", 8000)}${fnum("E8", "B8*D8", 8000)}</row>`,
  // Marked Alternative, yet its 2,920 is inside the 28,820 section total.
  `<row r="9">${str("A9", "PL3 pendants over reception — Alternative")}${numc("B9", 8)}${str("C9", "ea")}${numc("D9", 365)}${fnum("E9", "B9*D9", 2920)}</row>`,
  // A live formula computing on a broken reference.
  `<row r="10">${str("A10", "Switchboard modifications — MSB")}${numc("B10", 1)}${str("C10", "lot")}${numc("D10", 10500)}${errc("E10", "B10*#REF!", "#REF!")}</row>`,
  `<row r="11">${str("A11", "East Gym total")}${fnum("E11", "SUM(E6:E10)", 28820)}</row>`,
  `<row r="13">${str("A13", "Upper Ground")}</row>`,
  `<row r="14">${str("A14", "Description")}${str("B14", "Qty")}${str("C14", "Unit")}${str("D14", "Rate")}${str("E14", "Amount")}</row>`,
  `<row r="15">${str("A15", "Distribution board DB-UG")}${numc("B15", 1)}${str("C15", "ea")}${numc("D15", 4200)}${fnum("E15", "B15*D15", 4200)}</row>`,
  `<row r="16">${str("A16", "Lighting circuits — final subcircuits")}${numc("B16", 14)}${str("C16", "ea")}${numc("D16", 450)}${fnum("E16", "B16*D16", 6300)}</row>`,
  `<row r="17">${str("A17", "Data cabling — by others (connection only)")}${numc("B17", 1)}${str("C17", "lot")}${numc("D17", 1730)}${fnum("E17", "B17*D17", 1730)}</row>`,
  // A subtotal with no qty and no rate — unauditable money.
  `<row r="18">${str("A18", "Temporary power allowance")}${str("C18", "lot")}${numc("E18", 500)}</row>`,
  `<row r="19">${str("A19", "Upper Ground total")}${fnum("E19", "SUM(E15:E18)", 12730)}</row>`,
];

const sheetXml =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
  rows.join("") +
  `</sheetData></worksheet>`;

const files = {
  "[Content_Types].xml":
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`,
  "_rels/.rels":
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`,
  "xl/workbook.xml":
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="BOQ" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels":
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`,
  "xl/worksheets/sheet1.xml": sheetXml,
};

const out = join(dirname(fileURLToPath(import.meta.url)), "100-arthur-boq.xlsx");
writeFileSync(out, makeZip(files));
console.log(`wrote ${out}`);
