'use strict';

// Ingest ONE received email into invoice rows. Shared by the webhook (fresh
// delivery) and the sweep (re-ingesting deliveries that were quarantined
// while the flag was off, or whose inline ingest died).
//
// What arrives, and what happens (docs/invoice-capture.md "What arrives that
// is not a PDF invoice"):
//   PDF attachment          → captured, read, matched (the normal case)
//   image attachment        → captured as a document of kind image → review
//                             ("photo or scan — enter the details by hand")
//   .eml (forward-as-attachment) → unpacked (eml.js): every PDF / photo inside
//                             is captured as its own document, keyed
//                             <attachment id>#<n> so a replay is still a no-op
//   zip, no attachment at all
//                           → ONE review item for the email carrying the links
//                             and an excerpt, with the reason spelled out,
//                             but only when the email looks like it is about
//                             an invoice — auto-replies and chatter are ignored
//
// Idempotent: the (email id, attachment id) unique index makes a second run a
// no-op per attachment; the no-attachment review item is keyed on the email id
// through invoiceIdsForEmail. Extraction is NOT done here.

const { sanitiseFilenameFor, sniffDocument } = require('./safe-file');
const { classifyAttachments } = require('./resend-inbound');
const { parseEml } = require('./eml');

const MAX_EMLS = 10;
const MAX_PARTS_PER_EML = 10;

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_LINKS = 5;
const MAX_EXCERPT = 1500;
const INVOICE_WORDS = /\b(?:tax\s*invoice|invoice|inv\b|credit\s*note|statement|remittance|docket|purchase\s*order|account|amount\s*due|payment)\b/i;

/** https links from the text (and html hrefs), de-duplicated and bounded. Pure. */
function extractLinks(text, html) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const clean = String(u).replace(/[)\]>"'.,;]+$/, '');
    if (!/^https:\/\/[^\s<>"']{4,500}$/i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    if (out.length < MAX_LINKS) out.push(clean);
  };
  for (const m of String(text || '').matchAll(/https:\/\/[^\s<>"']+/gi)) push(m[0]);
  for (const m of String(html || '').matchAll(/href\s*=\s*["'](https:\/\/[^"']+)["']/gi)) push(m[1]);
  return out;
}

/** Plain-text excerpt of the email body (html tags stripped), bounded. Pure. */
function textExcerpt(text, html) {
  let t = String(text || '');
  if (!t.trim() && html) t = String(html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  // eslint-disable-next-line no-control-regex
  return t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_EXCERPT) || null;
}

/** Does this email plausibly carry an invoice we failed to get a document from? Pure. */
function looksLikeInvoiceEmail(subject, text, links) {
  return INVOICE_WORDS.test(String(subject || '')) || INVOICE_WORDS.test(String(text || '').slice(0, 4000)) || (links && links.length > 0);
}

/**
 * @param {{ sql: any, tenant: { id: string, slug: string }, emailId: string,
 *           deps: { store: any, resend: { fetchReceivedEmail: Function, fetchAttachmentMeta: Function, downloadAttachment: Function },
 *                   storePdf: Function, sha256: Function, apiKey: string } }} input
 * @returns {Promise<{ created: string[], skipped: Array<{ attachmentId: string, reason: string }>, subject: string|null, reviewItem: string|null }>}
 */
async function ingestReceivedEmail({ sql, tenant, emailId, deps }) {
  const { store, resend, storePdf, sha256, apiKey } = deps;
  const email = await resend.fetchReceivedEmail(emailId, { apiKey });
  // eslint-disable-next-line no-control-regex
  const subject = typeof email.subject === 'string' ? email.subject.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 200) : null;
  const from = typeof email.from === 'string' ? email.from.slice(0, 320) : null;
  const messageId = typeof email.message_id === 'string' ? email.message_id.slice(0, 320) : null;
  const groups = classifyAttachments(
    (Array.isArray(email.attachments) ? email.attachments : []).map((a) => ({
      id: a && a.id,
      filename: (a && a.filename) || '',
      contentType: String((a && a.content_type) || '').toLowerCase(),
      disposition: a && a.content_disposition,
      size: a && typeof a.size === 'number' ? a.size : null,
    })),
  );
  const created = [];
  const skipped = [];
  const meta = { source: 'email', sourceEmailId: emailId, sourceMessageId: messageId, sourceSubject: subject, sourceFrom: from, createdBy: null };

  for (const att of [...groups.pdfs, ...groups.images]) {
    try {
      const already = await store.findDocumentByProvider(sql, tenant.id, emailId, att.id);
      if (already) { skipped.push({ attachmentId: att.id, reason: 'already_captured' }); continue; }
      const attMeta = await resend.fetchAttachmentMeta(emailId, att.id, { apiKey });
      if (!attMeta || typeof attMeta.download_url !== 'string') { skipped.push({ attachmentId: att.id, reason: 'no_download_url' }); continue; }
      const bytes = await resend.downloadAttachment(attMeta.download_url, { maxBytes: MAX_ATTACHMENT_BYTES });
      const sniff = sniffDocument(bytes);
      if (!sniff) { skipped.push({ attachmentId: att.id, reason: 'not_pdf_or_image' }); continue; }
      const filename = sanitiseFilenameFor(att.filename, sniff.contentType);
      const digest = sha256(bytes);
      // The row id is minted by PG, so the blob path uses the provider attachment id (unguessable, provider-issued).
      const stored = await storePdf({ tenantSlug: tenant.slug, invoiceId: `email-${att.id}`, filename, bytes, contentType: sniff.contentType });
      const result = await store.createInvoiceWithDocument(
        sql, tenant.id, meta,
        { source: 'email', kind: sniff.kind, providerEmailId: emailId, providerAttachmentId: att.id, filename, contentType: sniff.contentType,
          byteSize: bytes.length, sha256: digest, blobPathname: stored.pathname, blobUrl: stored.url, uploadedBy: null },
      );
      if (!result) { skipped.push({ attachmentId: att.id, reason: 'already_captured' }); continue; }
      created.push(result.invoice.id);
    } catch (e) {
      skipped.push({ attachmentId: att.id, reason: String((e && e.code) || 'attachment_failed').slice(0, 40) });
    }
  }

  // Forwarded-as-attachment emails (Outlook, and "forward several at once"):
  // unpack each .eml and capture the documents inside it.
  for (const att of groups.emls.slice(0, MAX_EMLS)) {
    try {
      const already = await store.findDocumentByProvider(sql, tenant.id, emailId, `${att.id}#1`);
      if (already) { skipped.push({ attachmentId: att.id, reason: 'already_captured' }); continue; }
      const attMeta = await resend.fetchAttachmentMeta(emailId, att.id, { apiKey });
      if (!attMeta || typeof attMeta.download_url !== 'string') { skipped.push({ attachmentId: att.id, reason: 'no_download_url' }); continue; }
      const raw = await resend.downloadAttachment(attMeta.download_url, { maxBytes: MAX_ATTACHMENT_BYTES });
      const inner = parseEml(raw);
      // the same rule as top-level attachments: inline / tiny images are logos and signatures, not documents
      const parts = inner.parts.filter((p) => !(/^image\//.test(p.contentType) && (p.inline || p.bytes.length < 40 * 1024))).slice(0, MAX_PARTS_PER_EML);
      if (!parts.length) { skipped.push({ attachmentId: att.id, reason: 'eml_no_documents' }); continue; }
      let n = 0;
      for (const part of parts) {
        n += 1;
        const sniff = sniffDocument(part.bytes);
        if (!sniff) { skipped.push({ attachmentId: `${att.id}#${n}`, reason: 'not_pdf_or_image' }); continue; }
        const filename = sanitiseFilenameFor(part.filename, sniff.contentType);
        const digest = sha256(part.bytes);
        const stored = await storePdf({ tenantSlug: tenant.slug, invoiceId: `email-${att.id}-${n}`, filename, bytes: part.bytes, contentType: sniff.contentType });
        const result = await store.createInvoiceWithDocument(
          sql, tenant.id, { ...meta, sourceSubject: inner.subject || subject, sourceFrom: inner.from || from },
          { source: 'email', kind: sniff.kind, providerEmailId: emailId, providerAttachmentId: `${att.id}#${n}`, filename, contentType: sniff.contentType,
            byteSize: part.bytes.length, sha256: digest, blobPathname: stored.pathname, blobUrl: stored.url, uploadedBy: null },
        );
        if (!result) { skipped.push({ attachmentId: `${att.id}#${n}`, reason: 'already_captured' }); continue; }
        created.push(result.invoice.id);
      }
    } catch (e) {
      skipped.push({ attachmentId: att.id, reason: String((e && e.code) || 'attachment_failed').slice(0, 40) });
    }
  }

  // Nothing usable arrived: one review item for the email, if it looks like an invoice.
  let reviewItem = null;
  if (created.length === 0 && !skipped.some((s) => s.reason === 'already_captured')) {
    const links = extractLinks(email.text, email.html);
    const reasons = [];
    if (groups.pdfs.length + groups.images.length > 0) reasons.push('attachment_unreadable');
    if (groups.emls.length) reasons.push('forwarded_as_attachment'); // unpacked, but nothing usable was inside
    if (groups.zips.length) reasons.push('zip_attachment');
    if (!reasons.length && groups.others.length) reasons.push('unsupported_attachment');
    if (!reasons.length) reasons.push('no_attachment');
    if (looksLikeInvoiceEmail(subject, email.text, links) || reasons[0] !== 'no_attachment') {
      // (an unreadable PDF is always worth a person's eyes: the sender meant to send an invoice)
      const existing = await store.invoiceIdsForEmail(sql, tenant.id, emailId);
      if (existing.length) {
        skipped.push({ attachmentId: null, reason: 'already_captured' });
      } else {
        const row = await store.createInvoice(sql, tenant.id, {
          ...meta, status: 'needs_review', reviewReasons: reasons, sourceLinks: links, sourceTextExcerpt: textExcerpt(email.text, email.html),
        });
        await store.insertEvent(sql, tenant.id, row.id, { event: 'received', detail: { attachments: 0, reasons, links: links.length } });
        await store.insertEvent(sql, tenant.id, row.id, { event: 'review_required', detail: { reasons } });
        reviewItem = row.id;
      }
    } else {
      skipped.push({ attachmentId: null, reason: 'not_invoice_like' });
    }
  }
  return { created, skipped, subject, reviewItem, attachmentCount: groups.pdfs.length + groups.images.length + groups.emls.length };
}

module.exports = { ingestReceivedEmail, extractLinks, textExcerpt, looksLikeInvoiceEmail, MAX_ATTACHMENT_BYTES };
