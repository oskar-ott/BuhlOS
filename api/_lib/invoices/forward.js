'use strict';

// Stray replies (owner direction 2026-09-23). Resend receiving takes EVERY
// email for the inbound domain, so a reply to timesheets@buhlos.com (or any
// other address the app sends from) would otherwise be recorded `ignored` and
// never seen by a person. This forwards such emails — body, attachments, the
// original sender as reply-to — to the accounts recipient list (the same list
// the pay-run and the Monday digest go to).
//
// Scope is deliberately narrow: only the app's own sender local parts
// (INBOUND_FORWARD_LOCAL_PARTS, default below) on the inbound domain. Anything
// else addressed to the domain stays `ignored` — nobody has a mailbox there, so
// that is spam or a typo. Never a loop: the forward goes OUT via the API from
// a sender that is not a forwardable address, to addresses on other domains.

const DEFAULT_LOCAL_PARTS = ['timesheets', 'office', 'pay', 'onboarding', 'noreply', 'no-reply'];
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_BODY = 200_000;

/** Which local parts are forwarded — env-overridable, lower-cased, bounded. Pure. */
function forwardLocalParts(env = process.env) {
  const raw = env.INBOUND_FORWARD_LOCAL_PARTS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LOCAL_PARTS.slice();
  return String(raw).split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9._+-]{1,64}$/.test(s)).slice(0, 20);
}

/** The first recipient that is a forwardable app address on the inbound domain, or null. Pure. */
function matchStrayAddress(addresses, { domain, localParts }) {
  if (!domain) return null;
  const parts = new Set((localParts || []).map((s) => s.toLowerCase()));
  for (const raw of Array.isArray(addresses) ? addresses : []) {
    const m = /<([^>]+)>/.exec(String(raw || ''));
    const addr = (m ? m[1] : String(raw || '')).trim().toLowerCase();
    const at = addr.lastIndexOf('@');
    if (at <= 0) continue;
    const local = addr.slice(0, at).replace(/\+.*$/, '');
    if (addr.slice(at + 1) === String(domain).toLowerCase() && parts.has(local)) return addr;
  }
  return null;
}

/** "Name <a@b>" → "a@b" when it looks like an address, else null. Pure. */
function bareAddress(from) {
  const m = /<([^>]+)>/.exec(String(from || ''));
  const addr = (m ? m[1] : String(from || '')).trim();
  return /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/.test(addr) ? addr : null;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Build the outgoing message from the received one. Pure. */
function buildForward({ email, address, from, recipients, attachments }) {
  const sender = String(email.from || 'an unknown sender').slice(0, 320);
  const subject = `[${address}] ${String(email.subject || '(no subject)').slice(0, 200)}`;
  // eslint-disable-next-line no-control-regex
  const text = String(email.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').slice(0, MAX_BODY);
  const html = String(email.html || '').slice(0, MAX_BODY);
  const intro = `Sent to ${address} by ${sender}. BuhlOS forwarded it because nothing reads that mailbox — reply and it goes to the sender.`;
  const bodyText = text || html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return {
    to: recipients,
    from,
    replyTo: bareAddress(email.from),
    subject,
    text: `${intro}\n\n----------\n\n${bodyText}`,
    html: `<p style="color:#555">${esc(intro)}</p><hr>${html || `<pre style="white-space:pre-wrap">${esc(text)}</pre>`}`,
    attachments,
  };
}

/**
 * Fetch the received email + its attachments from the provider and send it on.
 * @returns {Promise<{ ok: boolean, reason?: string, attachments: number }>}
 */
async function forwardStrayEmail({ emailId, address, deps }) {
  const { resend, apiKey, sendEmail, recipients, from } = deps;
  if (!Array.isArray(recipients) || !recipients.length) return { ok: false, reason: 'no_recipients', attachments: 0 };
  if (!from) return { ok: false, reason: 'no_sender', attachments: 0 };
  const email = await resend.fetchReceivedEmail(emailId, { apiKey });
  const attachments = [];
  let total = 0;
  for (const a of (Array.isArray(email.attachments) ? email.attachments : []).slice(0, MAX_ATTACHMENTS)) {
    if (!a || !a.id || a.content_disposition === 'inline') continue;
    try {
      const meta = await resend.fetchAttachmentMeta(emailId, a.id, { apiKey });
      if (!meta || typeof meta.download_url !== 'string') continue;
      const bytes = await resend.downloadAttachment(meta.download_url, { maxBytes: MAX_ATTACHMENT_BYTES });
      if (total + bytes.length > MAX_TOTAL_BYTES) break;
      total += bytes.length;
      attachments.push({ filename: String(a.filename || 'attachment').replace(/[^\w.\- ()]/g, '_').slice(0, 120), content: Buffer.from(bytes).toString('base64') });
    } catch {
      // a failed attachment never blocks the forward; the body still carries the message
    }
  }
  const sent = await sendEmail(buildForward({ email, address, from, recipients, attachments }));
  return { ok: !!(sent && sent.ok), reason: sent && sent.ok ? undefined : (sent && sent.reason) || 'send_failed', attachments: attachments.length };
}

module.exports = { forwardLocalParts, matchStrayAddress, bareAddress, buildForward, forwardStrayEmail, DEFAULT_LOCAL_PARTS };
