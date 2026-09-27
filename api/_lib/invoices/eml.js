'use strict';

// Minimal MIME reader for a forwarded-as-attachment email (.eml). Outlook's
// "Forward as attachment" — and selecting several emails and forwarding them
// at once — wraps each original email as a message/rfc822 part, with the
// supplier's PDF inside it. For the catch-up (owner, 2026-09-27: "send a bunch
// of past emails") that is the natural bulk path, so the ingest unpacks it.
//
// Scope, deliberately small: RFC 2045/2046 multipart nesting, base64 /
// quoted-printable / 7bit / 8bit transfer encodings, filename from
// Content-Disposition or Content-Type (plain, quoted, and the RFC 2231
// `filename*=UTF-8''…` form), one level of nested message/rfc822. It returns
// the document-like parts (PDF / image by type or name) and the inner
// subject; everything else is ignored. Pure; no dependency.

const MAX_PARTS = 40;
const MAX_DEPTH = 4;

function splitHeadersBody(text) {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return { headers: text, body: '' };
  return { headers: text.slice(0, m.index), body: text.slice(m.index + m[0].length) };
}

/** Folded headers → { lowercased name: value } (last wins). */
function parseHeaders(raw) {
  const out = {};
  const lines = raw.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) { out[cur] += ' ' + line.trim(); continue; }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    cur = line.slice(0, i).trim().toLowerCase();
    out[cur] = line.slice(i + 1).trim();
  }
  return out;
}

/** "text/plain; charset=utf-8; name=\"a.pdf\"" → { value, params }. */
function parseParam(header) {
  const parts = String(header || '').split(';');
  const value = (parts.shift() || '').trim().toLowerCase();
  const params = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    let k = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (k.endsWith('*')) {
      // RFC 2231: filename*=UTF-8''My%20Invoice.pdf
      k = k.slice(0, -1);
      const enc = /^([^']*)'[^']*'(.*)$/.exec(v);
      if (enc) { try { v = decodeURIComponent(enc[2]); } catch { v = enc[2]; } }
    } else if (v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1).replace(/\\"/g, '"');
    }
    if (params[k] === undefined || k === 'filename' || k === 'name') params[k] = v;
  }
  return { value, params };
}

function decodeQuotedPrintable(s) {
  const joined = s.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) { bytes.push(parseInt(joined.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBody(body, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return Buffer.from(body, 'latin1');
}

/** RFC 2047 encoded-words in a subject → plain text (UTF-8 / latin1, B and Q). */
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeQuotedPrintable(text.replace(/_/g, ' '));
      return buf.toString(/utf-?8/i.test(charset) ? 'utf8' : 'latin1');
    } catch { return text; }
  });
}

function isDocumentPart(contentType, filename) {
  return contentType === 'application/pdf' || /^image\/(jpeg|png|webp)$/.test(contentType) || /\.(pdf|jpe?g|png|webp)$/i.test(filename || '');
}

/**
 * @param {Buffer|string} raw the .eml bytes
 * @returns {{ subject: string|null, from: string|null, parts: Array<{ filename: string, contentType: string, bytes: Buffer, inline: boolean }> }}
 */
function parseEml(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw || '');
  const out = { subject: null, from: null, parts: [] };
  walk(text, 0, out);
  return out;
}

function walk(text, depth, out) {
  if (depth > MAX_DEPTH || out.parts.length >= MAX_PARTS) return;
  const { headers: rawHeaders, body } = splitHeadersBody(text);
  const h = parseHeaders(rawHeaders);
  if (depth === 0 || (out.subject == null && h.subject)) {
    if (h.subject && out.subject == null) out.subject = decodeWords(h.subject).trim().slice(0, 200) || null;
    if (h.from && out.from == null) out.from = decodeWords(h.from).trim().slice(0, 320) || null;
  }
  const ct = parseParam(h['content-type'] || 'text/plain');
  if (ct.value.startsWith('multipart/') && ct.params.boundary) {
    const boundary = ct.params.boundary;
    const segments = body.split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?=\\r?\\n|$)`));
    // segments[0] is the preamble; the last one after the closing boundary is the epilogue
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i].replace(/^\r?\n/, '');
      if (!seg.trim()) continue;
      walk(seg, depth + 1, out);
      if (out.parts.length >= MAX_PARTS) return;
    }
    return;
  }
  if (ct.value === 'message/rfc822') {
    const enc = String(h['content-transfer-encoding'] || '').toLowerCase().trim();
    const inner = enc === 'base64' || enc === 'quoted-printable' ? decodeBody(body, enc).toString('latin1') : body;
    walk(inner, depth + 1, out);
    return;
  }
  const cd = parseParam(h['content-disposition'] || '');
  const filename = decodeWords(cd.params.filename || ct.params.name || '').trim();
  if (!isDocumentPart(ct.value, filename)) return;
  const bytes = decodeBody(body, h['content-transfer-encoding']);
  if (!bytes.length) return;
  out.parts.push({ filename: filename || (ct.value === 'application/pdf' ? 'attachment.pdf' : 'attachment'), contentType: ct.value, bytes, inline: cd.value === 'inline' });
}

module.exports = { parseEml, parseHeaders, parseParam, decodeWords };
