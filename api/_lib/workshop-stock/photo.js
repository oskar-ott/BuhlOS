'use strict';

// Workshop Stock photos — validate, store privately, serve through the proxy.
//
//   • the phone downscales to ≤1600 px JPEG before sending (orientation applied
//     by the browser's decoder, metadata incl. GPS dropped by the re-encode)
//   • the server trusts neither the filename nor the declared type: the bytes
//     must be JPEG / PNG / WebP by magic number AND carry a parseable image
//     header with sane dimensions — a renamed PDF, a HEIC the phone couldn't
//     convert, or a truncated upload is refused with a plain reason
//   • binaries go to Vercel Blob with a random suffix; the URL stays on the
//     server and the only read path is GET /api/workshop-stock?action=photo
//     (authenticated, flag-gated, tenant-checked). @vercel/blob 0.24 has no
//     private stores — when it does, this module is the one place to flip.
//   • retention: take-stock recognition photos are never stored; an add-stock
//     photo is 'pending' for 24 h until an item claims it, then lives as long as
//     the item uses it; replaced/abandoned photos are deleted after expiry.

const crypto = require('crypto');
const { put, del } = require('@vercel/blob');
const { decodeDataUrl, imageTypeOf } = require('../invoices/safe-file');
const { withTimeout } = require('../with-timeout');

const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // the ~4.5 MB serverless body cap minus base64 overhead
const MIN_SIDE = 64;
const MAX_SIDE = 10000;
const FETCH_TIMEOUT_MS = 15_000;

function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32be(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
function u24le(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }

/** { width, height } from a JPEG/PNG/WebP header, or null. Pure. */
function imageDimensions(buf, type) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (type === 'image/png') {
    if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (type === 'image/webp') {
    if (b.length < 30) return null;
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    return null;
  }
  if (type === 'image/jpeg') {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return null;
      const marker = b[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      if (marker === 0xff) { o += 1; continue; }
      const len = u16be(b, o + 2);
      if (len < 2) return null;
      const isSof = (marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { width: u16be(b, o + 7), height: u16be(b, o + 5) };
      o += 2 + len;
    }
    return null;
  }
  return null;
}

/**
 * Decode + validate an uploaded photo. Returns
 *   { bytes, contentType, width, height, sha256 } or { error, status }.
 */
function readPhotoUpload(dataUrl) {
  const decoded = decodeDataUrl(dataUrl, MAX_PHOTO_BYTES);
  if (!decoded) return { error: 'photo_required', status: 400 };
  if (decoded.tooLarge) return { error: 'photo_too_large', status: 413, maxBytes: MAX_PHOTO_BYTES };
  const contentType = imageTypeOf(decoded.bytes);
  if (!contentType) return { error: 'photo_not_supported', status: 415 };
  const dims = imageDimensions(decoded.bytes, contentType);
  if (!dims || dims.width < MIN_SIDE || dims.height < MIN_SIDE || dims.width > MAX_SIDE || dims.height > MAX_SIDE) {
    return { error: 'photo_unreadable', status: 400 };
  }
  return {
    bytes: decoded.bytes,
    contentType,
    width: dims.width,
    height: dims.height,
    sha256: crypto.createHash('sha256').update(decoded.bytes).digest('hex'),
  };
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function storePhoto({ tenantSlug, bytes, contentType }) {
  const stamp = Date.now().toString(36);
  const blob = await put(`workshop-stock/${tenantSlug}/photos/${stamp}.${EXT[contentType] || 'jpg'}`, bytes, {
    access: 'public',
    addRandomSuffix: true,
    contentType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return { url: blob.url, pathname: blob.pathname };
}

/** Server-side read for the proxy (byte-capped, time-boxed). */
async function fetchPhoto(url) {
  const res = await withTimeout(fetch(url), FETCH_TIMEOUT_MS, 'blob fetch');
  if (!res.ok) {
    const e = new Error(`blob fetch ${res.status}`);
    e.code = 'photo_unavailable';
    throw e;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PHOTO_BYTES + 1024) {
    const e = new Error('photo too large');
    e.code = 'photo_unavailable';
    throw e;
  }
  return buf;
}

async function deletePhoto(url) {
  await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
}

module.exports = { MAX_PHOTO_BYTES, imageDimensions, readPhotoUpload, storePhoto, fetchPhoto, deletePhoto };
