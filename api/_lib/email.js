// Transactional email sender (Pass O2).
//
// Thin provider abstraction over Resend's REST API using fetch — no SDK, same
// style as api/_lib/blob.js. When no provider is configured, the onboarding
// flow falls back to the copy-invite-link path (bible §07 build note); this
// module NEVER fakes a send.
//
// Env:
//   RESEND_API_KEY   provider key (required to send)
//   EMAIL_FROM       e.g. "bühl electrical <noreply@phil.buhl.com.au>" (required to send)
//   APP_BASE_URL     canonical base for CTA links (optional; caller falls back to request host)
//
// SECURITY: the rendered message body contains the plaintext invite token in
// its CTA URL (that IS the invite, bible §10 S02) — so this module must never
// log the html/text it sends. We log only metadata (to-domain, subject length,
// result category) and return a sanitised failure category, never the raw
// provider body.

const TEMPLATES = require('./email-templates');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

const COMPANY_NAME = process.env.EMAIL_COMPANY_NAME || 'bühl electrical';

function companyName() {
  return COMPANY_NAME;
}

// Low-level send. Returns { ok:true, id } or { ok:false, reason } where reason
// is a stable category — never the provider's raw error body.
async function sendEmail({ to, subject, html, text }) {
  if (!isEmailConfigured()) return { ok: false, reason: 'not_configured' };
  if (!to || !subject || !(html || text)) return { ok: false, reason: 'invalid_message' };
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      const reason =
        res.status === 429 ? 'provider_rate_limited'
        : res.status >= 500 ? 'provider_error'
        : 'provider_rejected';
      // Metadata only — never the response body (could echo the message).
      console.error('email send failed', { status: res.status, reason });
      return { ok: false, reason, status: res.status };
    }
    let id = null;
    try { const data = await res.json(); id = data && data.id; } catch { /* ignore */ }
    return { ok: true, id: id || null };
  } catch (e) {
    console.error('email send error', { reason: 'network_error', message: e && e.message });
    return { ok: false, reason: 'network_error' };
  }
}

/**
 * Render + send one of the invite templates.
 *
 * @param {'invite'|'resend'|'expiredReplacement'|'accepted'} kind
 * @param {object} ctx  template context (includes ctaUrl with the token)
 */
async function sendTemplate(kind, ctx) {
  const render = TEMPLATES[kind];
  if (!render) return { ok: false, reason: 'unknown_template' };
  const msg = render(ctx);
  return sendEmail({ to: ctx.to, subject: msg.subject, html: msg.html, text: msg.text });
}

module.exports = { isEmailConfigured, sendEmail, sendTemplate, companyName };
