// Invite email templates (Pass O2).
//
// Source of truth for copy/voice: "BuhlOS Phil Onboarding Interface Bible.html"
// §07 (email design) + §12 (copy lexicon). Four templates, each returning a
// paired { subject, html, text } — plain text is first-class (bible §07: same
// words, same CTA URL), not an afterthought.
//
//   E1 invite              — first send
//   E2 resend              — "quick reminder", new link, old one dead
//   E3 expiredReplacement  — previous link expired, fresh one
//   E4 acceptedNotification — to the admin when a worker finishes setup (O3)
//
// PURE — no I/O, no requires, no globals. Unit-tested from src so the gates
// cover it (the test imports this CommonJS module). The plaintext token only
// ever appears inside ctx.ctaUrl (the CTA + raw fallback link), per bible
// §10 S02; nothing here logs or stores it.

const BRAND_NAVY = '#0d1f35';
const BRAND_YELLOW = '#ffcc00';
const INK = '#2a3958';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// "a" / "an" for a role label ("an apprentice", "a labourer").
function article(word) {
  return /^[aeiou]/i.test(String(word || '').trim()) ? 'an' : 'a';
}

// Shared HTML shell — inline styles only (email clients strip <style>).
function shell({ heading, bodyHtml, ctaLabel, ctaUrl, expiresText, adminName, companyName, adminPhone }) {
  const sig = [esc(adminName), esc(companyName)].filter(Boolean).join('<br>');
  const phone = adminPhone ? ` · ${esc(adminPhone)}` : '';
  return `<!doctype html><html><body style="margin:0;background:#f3efe7;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0">
<tr><td style="padding:32px 32px 8px">
<div style="font-weight:800;font-size:26px;letter-spacing:-.03em;color:${BRAND_NAVY};margin-bottom:20px">b<span style="border-bottom:6px solid ${BRAND_YELLOW};line-height:.8">ü</span>hl</div>
<h1 style="font-size:22px;line-height:1.2;color:${BRAND_NAVY};margin:0 0 14px;font-weight:700">${heading}</h1>
${bodyHtml}
<a href="${esc(ctaUrl)}" style="display:inline-block;background:${BRAND_YELLOW};color:${BRAND_NAVY};font-weight:700;font-size:15px;text-decoration:none;padding:13px 22px;border-radius:4px;margin:8px 0 14px">${esc(ctaLabel)} &rarr;</a>
<p style="font-size:13px;color:#6a7591;margin:0 0 14px">If the button doesn't work, paste this into your browser:<br><span style="font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;color:#6a7591">${esc(ctaUrl)}</span></p>
<p style="font-size:14px;color:${INK};margin:14px 0 0">&mdash; ${sig}${phone}</p>
</td></tr>
<tr><td style="padding:14px 32px;background:#f6f7f9;border-top:1px solid #e2e8f0;font-size:11px;color:#6a7591">${esc(expiresText)} · single-use. Not expecting this? Reply to this email.</td></tr>
</table></body></html>`;
}

function plainShell({ greeting, lines, ctaLabel, ctaUrl, expiresText, adminName, companyName, adminPhone }) {
  const phone = adminPhone ? ` · ${adminPhone}` : '';
  return [
    greeting,
    '',
    ...lines,
    '',
    `${ctaLabel}:`,
    '',
    `  ${ctaUrl}`,
    '',
    `This link is for you only. ${expiresText}.`,
    '',
    "If you weren't expecting this, reply or call me.",
    '',
    `— ${adminName}`,
    `${companyName}${phone}`,
  ].join('\n');
}

/**
 * E1 · original invite. ctx: { firstName, companyName, roleLabel, ctaUrl,
 * expiresText, adminName, adminPhone?, optionalNote? }
 */
function inviteEmail(ctx) {
  const role = String(ctx.roleLabel || 'worker').toLowerCase();
  const note = ctx.optionalNote
    ? `<p style="font-size:15px;line-height:1.5;color:${INK};margin:0 0 14px">${esc(ctx.optionalNote)}</p>`
    : '';
  const bodyHtml = `<p style="font-size:15px;line-height:1.5;color:${INK};margin:0 0 14px">${esc(ctx.adminName)} at <b>${esc(ctx.companyName)}</b> has added you as ${article(role)} ${esc(role)}. Phil is the app you'll use on your phone every day.</p>${note}
<table role="presentation" width="100%" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;margin:4px 0 16px"><tr>
<td style="padding:12px 8px 12px 0;font-size:13px;color:${INK};vertical-align:top"><b style="color:${BRAND_NAVY}">My Day</b><br>Log your hours.</td>
<td style="padding:12px 8px;font-size:13px;color:${INK};vertical-align:top"><b style="color:${BRAND_NAVY}">My Gear</b><br>See your tools.</td>
<td style="padding:12px 0 12px 8px;font-size:13px;color:${INK};vertical-align:top"><b style="color:${BRAND_NAVY}">Jobs</b><br>Site info, photos.</td>
</tr></table>`;
  return {
    subject: `You're invited to Phil — ${ctx.companyName}`,
    html: shell({
      heading: `G'day ${esc(ctx.firstName)}.<br>You've been invited to Phil.`,
      bodyHtml,
      ctaLabel: 'Set up Phil',
      ctaUrl: ctx.ctaUrl,
      expiresText: ctx.expiresText,
      adminName: ctx.adminName,
      companyName: ctx.companyName,
      adminPhone: ctx.adminPhone,
    }),
    text: plainShell({
      greeting: `G'day ${ctx.firstName},`,
      lines: [
        `${ctx.adminName} at ${ctx.companyName} has added you as ${article(role)} ${role}.`,
        `Phil is the app you'll use on your phone every day to:`,
        '',
        '  · log your hours at knock-off',
        "  · see what gear you've got",
        '  · open your jobs and site info',
        ...(ctx.optionalNote ? ['', ctx.optionalNote] : []),
      ],
      ctaLabel: 'Set up Phil here',
      ctaUrl: ctx.ctaUrl,
      expiresText: ctx.expiresText,
      adminName: ctx.adminName,
      companyName: ctx.companyName,
      adminPhone: ctx.adminPhone,
    }),
  };
}

/** E2 · resend. Same context as E1. Makes clear it's a fresh link. */
function resendEmail(ctx) {
  const bodyHtml = `<p style="font-size:15px;line-height:1.5;color:${INK};margin:0 0 14px">${esc(ctx.adminName)} sent this last week. Take 2 minutes to set up Phil so you can log your hours. <b>This is a fresh link — any earlier one no longer works.</b></p>`;
  return {
    subject: `Reminder: set up Phil — ${ctx.companyName}`,
    html: shell({
      heading: `G'day ${esc(ctx.firstName)} — quick reminder.`,
      bodyHtml,
      ctaLabel: 'Set up Phil',
      ctaUrl: ctx.ctaUrl,
      expiresText: ctx.expiresText,
      adminName: ctx.adminName,
      companyName: ctx.companyName,
      adminPhone: ctx.adminPhone,
    }),
    text: plainShell({
      greeting: `G'day ${ctx.firstName} — quick reminder.`,
      lines: [
        `${ctx.adminName} sent this last week. Take 2 minutes to set up Phil so you can log your hours.`,
        'This is a fresh link — any earlier one no longer works.',
      ],
      ctaLabel: 'Set up Phil here',
      ctaUrl: ctx.ctaUrl,
      expiresText: ctx.expiresText,
      adminName: ctx.adminName,
      companyName: ctx.companyName,
      adminPhone: ctx.adminPhone,
    }),
  };
}

/** E3 · expired replacement. Slightly apologetic; new link + new expiry. */
function expiredReplacementEmail(ctx) {
  const bodyHtml = `<p style="font-size:15px;line-height:1.5;color:${INK};margin:0 0 14px">Your previous link expired. Here's a fresh one — same setup, new link. Sorry about that.</p>`;
  return {
    subject: `New invite for Phil — ${ctx.companyName}`,
    html: shell({
      heading: `G'day ${esc(ctx.firstName)} — your previous link expired.`,
      bodyHtml,
      ctaLabel: 'Set up Phil',
      ctaUrl: ctx.ctaUrl,
      expiresText: ctx.expiresText,
      adminName: ctx.adminName,
      companyName: ctx.companyName,
      adminPhone: ctx.adminPhone,
    }),
    text: plainShell({
      greeting: `G'day ${ctx.firstName} — your previous link expired.`,
      lines: ["Here's a fresh one — same setup, new link. Sorry about that."],
      ctaLabel: 'Set up Phil here',
      ctaUrl: ctx.ctaUrl,
      expiresText: ctx.expiresText,
      adminName: ctx.adminName,
      companyName: ctx.companyName,
      adminPhone: ctx.adminPhone,
    }),
  };
}

/**
 * E4 · admin notification — built + tested in O2, but NOT triggered until the
 * O3 acceptance event exists. ctx: { firstName, lastName, timeText, jobText?,
 * buhlosUrl, companyName }
 */
function acceptedNotificationEmail(ctx) {
  const job = ctx.jobText ? ` He's on ${esc(ctx.jobText)} today.` : '';
  return {
    subject: `${ctx.firstName} ${ctx.lastName} is in Phil`,
    html: `<!doctype html><html><body style="margin:0;background:#f3efe7;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0">
<tr><td style="padding:28px 32px">
<h1 style="font-size:20px;color:${BRAND_NAVY};margin:0 0 12px;font-weight:700">${esc(ctx.firstName)} ${esc(ctx.lastName)} is in Phil.</h1>
<p style="font-size:15px;line-height:1.5;color:${INK};margin:0 0 16px">${esc(ctx.firstName)} set up Phil at ${esc(ctx.timeText)}.${job}</p>
<a href="${esc(ctx.buhlosUrl)}" style="font-size:14px;color:${BRAND_NAVY};text-decoration:underline">View in BuhlOS &rarr;</a>
</td></tr></table></body></html>`,
    text: `${ctx.firstName} ${ctx.lastName} is in Phil.\n\n${ctx.firstName} set up Phil at ${ctx.timeText}.${ctx.jobText ? ` He's on ${ctx.jobText} today.` : ''}\n\nView in BuhlOS: ${ctx.buhlosUrl}`,
  };
}

// Map an invite "kind" to its template renderer (used by api/_lib/email.js).
const TEMPLATES = {
  invite: inviteEmail,
  resend: resendEmail,
  expiredReplacement: expiredReplacementEmail,
  accepted: acceptedNotificationEmail,
};

module.exports = {
  inviteEmail,
  resendEmail,
  expiredReplacementEmail,
  acceptedNotificationEmail,
  TEMPLATES,
  article,
};
