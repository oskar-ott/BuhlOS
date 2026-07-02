#!/usr/bin/env node
// Part of #197 — the shared text layer; the drawings page-understanding
// foundation is NOT this.
//
// Generates the committed PDF fixtures the pdf-text tests run against:
//
//   src/domains/platform/__fixtures__/contract-sow-sample.pdf
//     A synthetic (clearly fake — "100 Example St") builder scope-of-works,
//     3 pages, with the marquee obligations the golden text-layer test
//     asserts page-by-page (fire-proofing certs, engineer sign-off, CAD
//     as-builts, SWMS/Sign-on-Site, Payapps, lookahead programme, dockets,
//     variations-in-writing, six-day week, out-of-hours, AMPC induction).
//
//   src/domains/platform/__fixtures__/no-text-scanned.pdf
//     One page with a drawn rectangle and NO text objects — stands in for a
//     scanned/image-only contract, the honest-failure case (no OCR, #197).
//
// Deterministic: fixed creation/modification dates and metadata so a re-run
// produces identical bytes (review-diffable). Uses the pdf-lib devDependency
// ONLY here — production text extraction is unpdf (api/_lib/pdf-text.js).
//
// Regenerate with: node scripts/generate-pdf-fixtures.js

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const OUT_DIR = path.join(__dirname, '..', 'src', 'domains', 'platform', '__fixtures__');
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

// Page copy. Every string is ASCII (pdf-lib WinAnsi) and every marquee
// obligation phrase below is asserted verbatim by pdf-text.test.ts — keep
// them in sync if you edit.
const PAGES = [
  [
    'SCOPE OF WORKS - ELECTRICAL SUBCONTRACT',
    'Project: 100 Example St, Exampleville (SYNTHETIC TEST FIXTURE)',
    'Builder: Example Constructions Pty Ltd',
    '',
    '1. SITE ACCESS AND CONDUCT',
    '1.1 The AMPC site induction is mandatory for all subcontractor',
    'personnel prior to first access to site.',
    '1.2 SWMS must be uploaded to Sign-on-Site before commencement of',
    'any works on site.',
    '1.3 The site operates a six-day working week (Monday to Saturday).',
    '1.4 Out-of-hours works are by arrangement only and require 48 hours',
    'written notice to the site manager.',
  ],
  [
    '2. COMMERCIAL AND PROGRAMME',
    '2.1 Progress claims are to be submitted via Payapps by the 25th of',
    'each month.',
    '2.2 Variations must be approved in writing before work proceeds;',
    'unapproved variation work is at the subcontractor\'s risk.',
    '2.3 Day-labour dockets are to be signed daily by the site foreman.',
    '2.4 The subcontractor shall maintain a 2-week lookahead and submit a',
    '4-week programme, updated weekly.',
  ],
  [
    '3. QUALITY AND CLOSEOUT',
    '3.1 Fire-proofing penetration certificates are required for all',
    'service penetrations through fire-rated elements.',
    '3.2 Structural engineer sign-off is required for core holes through',
    'structural slabs and beams prior to coring.',
    '3.3 CAD as-builts are required if CADs are not supplied by the',
    'builder; marked-up PDFs are not accepted.',
    '',
    'END OF SCOPE - 100 Example St (SYNTHETIC TEST FIXTURE)',
  ],
];

function setDeterministicMeta(doc, title) {
  doc.setTitle(title);
  doc.setProducer('scripts/generate-pdf-fixtures.js');
  doc.setCreator('BuhlOS test fixtures');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
}

async function buildSowFixture() {
  const doc = await PDFDocument.create();
  setDeterministicMeta(doc, 'Synthetic SOW fixture - 100 Example St');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of PAGES) {
    const page = doc.addPage([595, 842]); // A4
    let y = 800;
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 11, font });
      y -= 18;
    }
  }
  return doc.save();
}

async function buildNoTextFixture() {
  const doc = await PDFDocument.create();
  setDeterministicMeta(doc, 'No-text fixture (image-only stand-in)');
  const page = doc.addPage([595, 842]);
  // A drawn shape, no text objects — extractable text is empty.
  page.drawRectangle({ x: 100, y: 400, width: 395, height: 200, color: rgb(0.85, 0.85, 0.85) });
  return doc.save();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sow = await buildSowFixture();
  const noText = await buildNoTextFixture();
  const sowPath = path.join(OUT_DIR, 'contract-sow-sample.pdf');
  const noTextPath = path.join(OUT_DIR, 'no-text-scanned.pdf');
  fs.writeFileSync(sowPath, sow);
  fs.writeFileSync(noTextPath, noText);
  console.log(`wrote ${sowPath} (${sow.length} bytes)`);
  console.log(`wrote ${noTextPath} (${noText.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
