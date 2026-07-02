// Part of #197 — the SHARED PDF TEXT LAYER. The drawings page-understanding
// foundation (page classification, takeoff, rendering) is NOT this module;
// this is only the "get honest per-page text out of a PDF" slice that #197
// owes #373 (contract-obligation extraction). Grow #197's drawing work
// elsewhere; keep this dependency-thin.
//
// One production dependency: unpdf (pinned) — a serverless build of pdf.js
// with a real CJS entry, no worker file, no native binaries, per-page text.
// Lazy-required (the ai.js SDK pattern) so requiring this module costs
// nothing until a PDF is actually read.
//
// Honesty rules (house style — parseModelJson-shaped results, never throws
// for expected failure modes):
//   - not a PDF / encrypted / parser failure → { ok: false, reason, message }
//   - a scanned/image-only PDF parses FINE but yields ~no text; callers MUST
//     check isMeaningfulText() and refuse to pretend — there is no OCR here.

let _unpdf = null;
function unpdf() {
  if (!_unpdf) _unpdf = require('unpdf');
  return _unpdf;
}

/**
 * Below this many non-whitespace characters across the whole document we
 * call the text NOT meaningful. A real contract page carries hundreds of
 * characters; an image-only scan yields 0 (or a stray watermark/footer of a
 * few chars). 40 is deliberately low — we only want to catch "there is no
 * text layer", never to judge content.
 */
const MEANINGFUL_TEXT_MIN_CHARS = 40;

/** @typedef {{ page: number, text: string }} PdfPageText */
/**
 * @typedef {{ ok: true, pages: PdfPageText[], totalChars: number }} PdfTextOk
 * @typedef {{ ok: false, reason: 'not_a_pdf'|'encrypted'|'parse_failed', message: string }} PdfTextErr
 */

/**
 * Extract per-page text from a PDF buffer.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer raw PDF bytes
 * @returns {Promise<PdfTextOk|PdfTextErr>} pages are 1-based; totalChars is
 *   the sum of NON-WHITESPACE characters (what isMeaningfulText thresholds).
 *   Never a silent empty success: a failed parse is { ok: false }, an
 *   image-only PDF is { ok: true } with totalChars ~0 for the caller to
 *   judge via isMeaningfulText.
 */
async function extractPdfText(buffer) {
  let bytes;
  if (buffer instanceof Uint8Array) bytes = new Uint8Array(buffer);
  else if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
  else {
    return { ok: false, reason: 'not_a_pdf', message: 'no PDF bytes provided' };
  }
  if (bytes.length === 0) {
    return { ok: false, reason: 'not_a_pdf', message: 'the file is empty' };
  }

  let text, totalPages;
  try {
    const { getDocumentProxy, extractText } = unpdf();
    const pdf = await getDocumentProxy(bytes);
    ({ totalPages, text } = await extractText(pdf, { mergePages: false }));
  } catch (e) {
    const name = (e && e.name) || '';
    if (name === 'PasswordException') {
      return { ok: false, reason: 'encrypted', message: 'the PDF is password-protected' };
    }
    if (name === 'InvalidPDFException') {
      return { ok: false, reason: 'not_a_pdf', message: 'the file is not a valid PDF' };
    }
    return {
      ok: false,
      reason: 'parse_failed',
      message: 'PDF parsing failed: ' + ((e && e.message) || 'unknown error'),
    };
  }

  const pages = [];
  let totalChars = 0;
  for (let i = 0; i < totalPages; i++) {
    const pageText = typeof text[i] === 'string' ? text[i] : '';
    totalChars += pageText.replace(/\s/g, '').length;
    pages.push({ page: i + 1, text: pageText });
  }
  return { ok: true, pages, totalChars };
}

/**
 * Can a caller honestly treat this extraction as "the document's text"?
 * False for scanned/image-only PDFs (no text layer — OCR is NOT built, #197);
 * the caller must say so rather than feed ~nothing to a model.
 *
 * @param {PdfTextOk|PdfTextErr} result an extractPdfText result
 */
function isMeaningfulText(result) {
  return Boolean(result && result.ok && result.totalChars >= MEANINGFUL_TEXT_MIN_CHARS);
}

module.exports = { extractPdfText, isMeaningfulText, MEANINGFUL_TEXT_MIN_CHARS };
