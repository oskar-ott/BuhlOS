'use strict';

// /api/quote-pdf — branded client quote PDFs for v2 quotes (#243).
//
//   GET  /api/quote-pdf?id=X              → { documents: [...] } issued-PDF register
//   GET  /api/quote-pdf?id=X&download=1   → application/pdf — FRESH render, NOT
//                                           filed (the PDF itself says
//                                           "Preview — not yet issued")
//   POST /api/quote-pdf?id=X              → generate + file: put() the PDF blob,
//                                           then append the register entry →
//                                           201 { document }
//
// Shaped per the #172 MIGRATE-BY-REBUILD ruling: reads ONLY the v2 store
// (quotes-v2/<id>.json) and files artifacts in a v2-homed register
// (quotes-v2/<id>/documents.json + quotes-v2/<id>/documents/<docId>.pdf —
// both under the quotes-v2/ backup-manifest prefix). The register model is
// the api/quote-documents.js pattern (typed entries, qdoc_ ids, index blob),
// deliberately NOT the legacy quotes/<id>/ tree, which retires at parity.
//
// LEAK-PROOFING: generation input is the client projection ONLY
// (api/_lib/quote-pdf.js — sell-side allowlist mirror of #186). Cost, margin,
// markup, unitCost and preset stamps never reach the renderer.
//
// IMMUTABILITY + failure honesty (issue ACs): every generation writes a NEW
// blob path (fresh qdoc_ id) — issued artifacts are never overwritten; the
// register entry is written only AFTER a successful put(), so a failed
// generation leaves no register entry ("PDF failed — nothing was issued").

const { put } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { companyName } = require('./_lib/email');
const {
  GENERATOR_VERSION,
  DEFAULT_VALIDITY_DAYS,
  projectQuoteToClientView,
  renderQuotePdf,
} = require('./_lib/quote-pdf');

const quoteDocKey = (id) => `quotes-v2/${id}.json`;
const registerKey = (id) => `quotes-v2/${id}/documents.json`;
const pdfBlobPath = (quoteId, docId) => `quotes-v2/${quoteId}/documents/${docId}.pdf`;

// v2 ids are server-minted [a-z0-9_]; hard-reject anything path-shaped.
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;

function newDocId() {
  return 'qdoc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Company identity for the letterhead — env-configured, honest: only fields
 *  that are actually set render; there is no logo asset, so the header is
 *  text-only (never a placeholder logo). */
function brandingFromEnv() {
  return {
    name: companyName(),
    abn: process.env.COMPANY_ABN || '',
    address: process.env.COMPANY_ADDRESS || '',
    phone: process.env.COMPANY_PHONE || '',
    email: process.env.COMPANY_EMAIL || '',
  };
}

async function readRegister(quoteId) {
  const data = await readBlob(registerKey(quoteId), { documents: [] });
  if (!data || !Array.isArray(data.documents)) return { documents: [] };
  return data;
}

function currentRevOf(doc) {
  return doc && Number.isFinite(doc.__rev) ? doc.__rev : 0;
}

/** Append-only register write, guarded with expectedRev + re-read retry (the
 *  api/quotes-v2.js upsertRegistryRow pattern, #511 lost-update class): two
 *  concurrent issues must both keep their entries. On a stale-revision
 *  conflict we re-read the fresh register and re-append THIS entry. (In that
 *  rare race the issueNumber stamped in the PDF may duplicate — cosmetic; the
 *  document id and blob path stay unique and no entry is ever lost.) */
async function appendRegisterEntry(quoteId, entry) {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const register = await readRegister(quoteId);
    register.documents.push(entry);
    try {
      await writeBlob(registerKey(quoteId), register, { expectedRev: currentRevOf(register) });
      return;
    } catch (e) {
      if (e && e.code === 'stale_write' && attempt < MAX_ATTEMPTS - 1) continue;
      throw e;
    }
  }
}

async function handleList(req, res, quoteId) {
  const data = await readRegister(quoteId);
  // Newest first — the top entry is "the current issued document".
  const documents = data.documents
    .slice()
    .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')));
  return res.status(200).json({ documents });
}

async function handleDownload(req, res, quote) {
  const view = projectQuoteToClientView(quote);
  const pdf = await renderQuotePdf(view, brandingFromEnv(), {
    quoteNumber: quote.id,
    generatedAt: new Date().toISOString(),
    validityDays: DEFAULT_VALIDITY_DAYS,
    issued: false,
  });
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="quote-${quote.id}-preview.pdf"`
  );
  return res.send(pdf);
}

async function handleIssue(req, res, quote, user) {
  const existing = await readRegister(quote.id);
  const issueNumber = existing.documents.length + 1;
  const docId = newDocId();
  const issuedAt = new Date().toISOString();

  const view = projectQuoteToClientView(quote);
  const pdf = await renderQuotePdf(view, brandingFromEnv(), {
    quoteNumber: quote.id,
    generatedAt: issuedAt,
    validityDays: DEFAULT_VALIDITY_DAYS,
    issued: true,
    issueNumber,
    documentId: docId,
  });

  // put() FIRST; the register entry is only written after the blob exists —
  // a failure here leaves no partial record (issue AC).
  const blobPath = pdfBlobPath(quote.id, docId);
  const uploaded = await put(blobPath, pdf, {
    access: 'public',
    contentType: 'application/pdf',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });

  const entry = {
    id: docId,
    quoteId: quote.id,
    documentType: 'Issued quote',
    fileName: `quote-${quote.id}-issue-${issueNumber}.pdf`,
    blobPath,
    url: uploaded.url,
    mimeType: 'application/pdf',
    sizeBytes: pdf.length,
    issueNumber,
    issuedAt,
    issuedBy: user.username || user.id,
    // Revision stamp: v2 quotes have no revision lineage yet, so the honest
    // content stamp is the document's updatedAt at generation time (plus the
    // sell total the artifact shows).
    quoteUpdatedAt: quote.updatedAt,
    quoteName: quote.name,
    totalIncGst: quote.totals && Number.isFinite(quote.totals.totalIncGst)
      ? quote.totals.totalIncGst
      : null,
    generatorVersion: GENERATOR_VERSION,
  };

  // Register append — expectedRev-guarded, entries are append-only and never
  // mutated. Only reached after a successful put(), so a failure anywhere
  // above leaves no register entry.
  await appendRegisterEntry(quote.id, entry);

  return res.status(201).json({ document: entry });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await isFlagEnabled('quotes', user))) return res.status(404).json({ error: 'not found' });
  // Quoting is commercial — admin TIER only (same gate as api/quotes-v2.js).
  if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin tier only' });

  const id = (req.query && req.query.id) || '';
  if (!id) return res.status(400).json({ error: 'id required' });
  if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'invalid id' });

  if (req.method === 'GET' && !(req.query && req.query.download)) {
    return handleList(req, res, id);
  }

  if (req.method === 'GET' || req.method === 'POST') {
    const quote = await readBlob(quoteDocKey(id), null);
    if (!quote) return res.status(404).json({ error: 'quote not found' });
    try {
      if (req.method === 'GET') return await handleDownload(req, res, quote);
      return await handleIssue(req, res, quote, user);
    } catch (err) {
      // Loud, honest failure — nothing was issued (no register entry exists
      // unless the blob write succeeded AND the register write succeeded).
      console.error('[quote-pdf] generation failed', err && err.message);
      return res.status(500).json({ error: 'PDF generation failed — nothing was issued' });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};
