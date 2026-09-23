'use strict';

// Original supplier-invoice PDFs live in Vercel Blob (the repo's binary store —
// photos, ITP PDFs, payroll PDFs all do), under
//   invoices/<tenantSlug>/<invoiceId>/<stamp>-<safe-name>.pdf
// with Blob's random suffix, so a pathname is unguessable. The URL is never
// handed to a browser: the ONLY read path is the authenticated, admin-gated,
// tenant-checked proxy in api/invoices.js (?action=document). When
// @vercel/blob is bumped to a version with private stores, this module is the
// one place to flip `access`.
//
// Bytes are hashed (sha256) before storage — the checksum is the second
// duplicate guard and is recorded on the document row.

const crypto = require('crypto');
const { put } = require('@vercel/blob');
const { withTimeout } = require('../with-timeout');

const FETCH_TIMEOUT_MS = 20_000;

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {{ tenantSlug: string, invoiceId: string, filename: string, bytes: Buffer }} input
 * @returns {Promise<{ url: string, pathname: string }>}
 */
async function storeInvoicePdf({ tenantSlug, invoiceId, filename, bytes, contentType }) {
  const stamp = Date.now().toString(36);
  const blob = await put(`invoices/${tenantSlug}/${invoiceId}/${stamp}-${filename}`, bytes, {
    access: 'public',
    addRandomSuffix: true,
    contentType: contentType || 'application/pdf',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return { url: blob.url, pathname: blob.pathname };
}

/** Fetch stored PDF bytes back (server-side only; byte-capped). */
async function fetchInvoicePdf(url, maxBytes) {
  const res = await withTimeout(fetch(url), FETCH_TIMEOUT_MS, 'blob fetch');
  if (!res.ok) {
    const e = new Error(`blob fetch ${res.status}`);
    e.code = 'document_unavailable';
    throw e;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) {
    const e = new Error('document too large');
    e.code = 'document_too_large';
    throw e;
  }
  return buf;
}

module.exports = { storeInvoicePdf, fetchInvoicePdf, sha256Hex };
