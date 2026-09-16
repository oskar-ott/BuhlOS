'use strict';

// Attachment hygiene: a filename is untrusted input (path traversal, control
// characters, absurd length) and an extension is not a file type. The PDF
// check reads the bytes.

const MAX_NAME = 120;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** Basename only, printable, bounded, always ends in .pdf. Pure. */
function sanitiseFilename(name) {
  let s = String(name == null ? '' : name);
  s = s.split(/[\\/]/).pop() || '';
  s = s.replace(CONTROL_CHARS, '').replace(/[<>:"|?*]/g, '_').trim();
  s = s.replace(/^\.+/, '');
  if (!s) s = 'invoice.pdf';
  if (!/\.pdf$/i.test(s)) s = s.replace(/\.[A-Za-z0-9]{0,8}$/, '') + '.pdf';
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME - 4).replace(/\.+$/, '') + '.pdf';
  return s;
}

/** True when the bytes are a PDF: the %PDF- header within the first 1 KB (the
 *  spec tolerates leading junk). Never trusts the filename or content type. */
function isPdfBuffer(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length < 8) return false;
  const head = Buffer.from(buf.subarray ? buf.subarray(0, 1024) : buf.slice(0, 1024));
  return head.indexOf('%PDF-') !== -1;
}

/**
 * Decode a data: URL or bare base64 into bytes. Returns { bytes } or
 * { tooLarge: true } (bounded BEFORE decoding so a huge payload never
 * allocates) or null when not decodable.
 */
function decodeDataUrl(input, maxBytes) {
  if (typeof input !== 'string' || !input) return null;
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') ? (comma >= 0 ? input.slice(comma + 1) : '') : input;
  if (!b64) return null;
  if (maxBytes && b64.length > Math.ceil((maxBytes * 4) / 3) + 4) return { tooLarge: true };
  try {
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return null;
    if (maxBytes && buf.length > maxBytes) return { tooLarge: true };
    return { bytes: buf };
  } catch {
    return null;
  }
}

module.exports = { sanitiseFilename, isPdfBuffer, decodeDataUrl, MAX_NAME };
