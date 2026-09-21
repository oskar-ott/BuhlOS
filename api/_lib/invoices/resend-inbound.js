'use strict';

// Resend Inbound for supplier invoices — webhook verification + provider API.
//
// Resend signs webhooks with the Svix standard: headers `svix-id`,
// `svix-timestamp`, `svix-signature`; secret `whsec_<base64>`; signature =
// base64(HMAC-SHA256(secret, `${id}.${timestamp}.${rawBody}`)); the header
// carries one or more space-separated `v1,<sig>` entries. Verification needs
// the EXACT raw request body — which is why the webhook is a Next route
// handler (request.text()) rather than an api/*.js function (whose body
// arrives pre-parsed).
//
// The `email.received` payload carries METADATA ONLY (no body, no attachment
// bytes): the email and each attachment are then fetched from the Resend API
// (GET /emails/receiving/{id}, GET /emails/receiving/{id}/attachments/{aid} →
// a short-lived download_url). Nothing in the webhook body is trusted as a URL.
//
// Env:
//   RESEND_INBOUND_WEBHOOK_SECRET  the signing secret of the receiving webhook
//   RESEND_API_KEY                 (already used by api/_lib/email.js)
//   INVOICE_INBOUND_DOMAIN         the receiving domain (required)
//   INVOICE_INBOUND_LOCAL_PART     optional — defaults to "invoices"
//   INVOICE_INBOUND_TOKEN          optional — when set the address is
//                                  invoices+<token>@domain (unguessable);
//                                  when unset the plain invoices@domain is
//                                  accepted (owner choice 2026-09-16). Either
//                                  way the Svix signature is the authentication;
//                                  the address only scopes which mail counts,
//                                  and a human confirms every document.
//
// No secret, address, subject or attachment content is ever logged here.

const crypto = require('crypto');
const { withTimeout } = require('../with-timeout');

const RESEND_API = 'https://api.resend.com';
const TOLERANCE_SEC = 5 * 60;
const API_TIMEOUT_MS = 15_000;
const MAX_ATTACHMENTS = 10;

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify a Svix-signed request. Pure given `nowSec`.
 * @param {{ secret: string|undefined, headers: Record<string, string|undefined>, rawBody: string, nowSec?: number, toleranceSec?: number }} input
 * @returns {{ ok: true, id: string } | { ok: false, reason: 'no_secret'|'missing_headers'|'bad_timestamp'|'stale_timestamp'|'bad_signature'|'bad_secret' }}
 */
function verifySvixSignature(input) {
  const secret = input.secret;
  if (!secret || typeof secret !== 'string') return { ok: false, reason: 'no_secret' };
  const h = input.headers || {};
  const id = h['svix-id'];
  const ts = h['svix-timestamp'];
  const sigHeader = h['svix-signature'];
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing_headers' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || !/^\d+$/.test(String(ts))) return { ok: false, reason: 'bad_timestamp' };
  const now = input.nowSec == null ? Math.floor(Date.now() / 1000) : input.nowSec;
  const tol = input.toleranceSec == null ? TOLERANCE_SEC : input.toleranceSec;
  if (Math.abs(now - tsNum) > tol) return { ok: false, reason: 'stale_timestamp' };
  let key;
  try {
    key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
    if (!key.length) return { ok: false, reason: 'bad_secret' };
  } catch {
    return { ok: false, reason: 'bad_secret' };
  }
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${input.rawBody}`).digest('base64');
  const candidates = String(sigHeader).split(/\s+/).map((s) => s.trim()).filter(Boolean);
  for (const c of candidates) {
    const [version, sig] = c.split(',');
    if (version !== 'v1' || !sig) continue;
    if (timingSafeEqualStr(sig, expected)) return { ok: true, id: String(id) };
  }
  return { ok: false, reason: 'bad_signature' };
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

/**
 * Shape-check an `email.received` event. Returns null for anything else.
 * Only metadata is kept; nothing here is trusted beyond its shape.
 */
function parseReceivedEvent(json) {
  if (!json || typeof json !== 'object' || json.type !== 'email.received') return null;
  const d = json.data;
  if (!d || typeof d !== 'object' || typeof d.email_id !== 'string' || !d.email_id) return null;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 320)) : []);
  const attachments = (Array.isArray(d.attachments) ? d.attachments : [])
    .filter((a) => a && typeof a === 'object' && typeof a.id === 'string')
    .slice(0, 50)
    .map((a) => ({
      id: a.id,
      filename: str(a.filename, 255) || '',
      contentType: (str(a.content_type, 120) || '').toLowerCase(),
      disposition: str(a.content_disposition, 40),
    }));
  return {
    emailId: d.email_id,
    from: str(d.from, 320),
    to: list(d.to),
    receivedFor: list(d.received_for),
    subject: str(d.subject, 500),
    messageId: str(d.message_id, 320),
    attachments,
  };
}

function addressOf(entry) {
  const s = String(entry || '').trim();
  const m = /<([^>]+)>\s*$/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
}

/**
 * Does any recipient equal the configured inbound address?
 *   token set   → `<localPart>+<token>@<domain>` (token compared in constant
 *                 time; domain required when configured)
 *   token unset → exactly `<localPart>@<domain>` — the domain MUST be
 *                 configured, otherwise nothing matches (fail closed)
 * Pure.
 * @param {string[]} addresses
 * @param {{ token?: string|null, localPart?: string, domain?: string|null }} expected
 */
function matchInboundAddress(addresses, expected) {
  const token = expected && expected.token ? String(expected.token) : null;
  const localPart = ((expected && expected.localPart) || 'invoices').toLowerCase();
  const domain = expected && expected.domain ? String(expected.domain).toLowerCase() : null;
  if (!token && !domain) return false;
  for (const entry of Array.isArray(addresses) ? addresses : []) {
    const addr = addressOf(entry);
    const at = addr.lastIndexOf('@');
    if (at <= 0) continue;
    const local = addr.slice(0, at);
    const dom = addr.slice(at + 1);
    if (domain && dom !== domain) continue;
    const plus = local.indexOf('+');
    if (token) {
      if (plus <= 0) continue;
      if (local.slice(0, plus) !== localPart) continue;
      if (timingSafeEqualStr(local.slice(plus + 1), token.toLowerCase())) return true;
    } else if (plus < 0 && local === localPart) {
      return true;
    }
  }
  return false;
}

/** Attachments worth fetching: PDFs by declared type OR .pdf name (the bytes are
 *  sniffed after download); inline images / logos / signatures are skipped. */
function selectPdfAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && a.id)
    .filter((a) => !(a.disposition === 'inline' && /^image\//.test(a.contentType || '')))
    .filter((a) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename || ''))
    .slice(0, MAX_ATTACHMENTS);
}

function apiHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

async function apiGet(path, { apiKey, fetchImpl }) {
  const f = fetchImpl || fetch;
  const res = await withTimeout(f(`${RESEND_API}${path}`, { headers: apiHeaders(apiKey) }), API_TIMEOUT_MS, 'resend api');
  if (!res.ok) {
    const err = new Error(`resend api ${res.status}`);
    err.code = res.status === 404 ? 'provider_not_found' : res.status === 401 || res.status === 403 ? 'provider_auth' : 'provider_error';
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** GET /emails/receiving/{id} — the full received email (metadata + text). */
function fetchReceivedEmail(emailId, deps) {
  return apiGet(`/emails/receiving/${encodeURIComponent(emailId)}`, deps);
}

/** GET /emails/receiving/{id}/attachments/{aid} → { download_url, expires_at, … } */
function fetchAttachmentMeta(emailId, attachmentId, deps) {
  return apiGet(`/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`, deps);
}

/**
 * Download an attachment from the provider-issued download_url (https only,
 * byte-capped while streaming). The URL comes from the authenticated API
 * response above — never from the webhook body.
 */
async function downloadAttachment(downloadUrl, { maxBytes, fetchImpl }) {
  let u;
  try { u = new URL(String(downloadUrl)); } catch { const e = new Error('bad download url'); e.code = 'provider_error'; throw e; }
  if (u.protocol !== 'https:') { const e = new Error('download url must be https'); e.code = 'provider_error'; throw e; }
  const f = fetchImpl || fetch;
  const res = await withTimeout(f(u.toString()), API_TIMEOUT_MS, 'attachment download');
  if (!res.ok) { const e = new Error(`attachment download ${res.status}`); e.code = 'provider_error'; throw e; }
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  if (declared && declared > maxBytes) { const e = new Error('attachment too large'); e.code = 'attachment_too_large'; throw e; }
  const chunks = [];
  let total = 0;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } const e = new Error('attachment too large'); e.code = 'attachment_too_large'; throw e; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) { const e = new Error('attachment too large'); e.code = 'attachment_too_large'; throw e; }
  return buf;
}

/** The inbound address the office forwards to, or null when not configured. */
function inboundAddress(env = process.env) {
  const domain = env.INVOICE_INBOUND_DOMAIN;
  if (!domain) return null;
  const local = env.INVOICE_INBOUND_LOCAL_PART || 'invoices';
  const token = env.INVOICE_INBOUND_TOKEN;
  return token ? `${local}+${token}@${domain}` : `${local}@${domain}`;
}

function inboundConfigured(env = process.env) {
  return Boolean(env.RESEND_INBOUND_WEBHOOK_SECRET && env.RESEND_API_KEY && env.INVOICE_INBOUND_DOMAIN);
}

module.exports = {
  verifySvixSignature,
  parseReceivedEvent,
  matchInboundAddress,
  selectPdfAttachments,
  fetchReceivedEmail,
  fetchAttachmentMeta,
  downloadAttachment,
  inboundAddress,
  inboundConfigured,
  TOLERANCE_SEC,
  MAX_ATTACHMENTS,
};
