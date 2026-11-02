'use strict';

// ITP PDF email (handoff 2026-11-02) — pure render module, no I/O.
//
// Subject: "{PDF name} — {job address}". Body: the optional note, then
// "{n} areas · {n} photos · made {date}", and the PDF attached — or, above
// the mail size cap, a download link and a line saying so. Same shell rules
// as the other templates: inline styles only, plain text first-class with
// the same words. Never claims "delivered".

const BRAND_NAVY = '#0d1f35';
const INK = '#0f172a';
const MUTED = '#475569';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * @param {{
 *   pdfName: string, jobAddress: string, note?: string,
 *   areaCount: number, photoCount: number, madeLabel: string,
 *   attached: boolean, downloadUrl?: string, senderName?: string,
 * }} input
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderItpEmail(input) {
  const subject = `${input.pdfName} — ${input.jobAddress}`.trim();
  const note = String(input.note || '').trim();
  const facts = `${plural(input.areaCount, 'area', 'areas')} · ${plural(input.photoCount, 'photo', 'photos')} · made ${input.madeLabel}`;
  const from = input.senderName ? `Sent by ${input.senderName} from BuhlOS.` : 'Sent from BuhlOS.';
  const attachLine = input.attached
    ? 'The PDF is attached.'
    : "The PDF's too big to attach, so here's a link to download it instead:";

  const textLines = [];
  if (note) textLines.push(note, '');
  textLines.push(input.pdfName, input.jobAddress, facts, '', attachLine);
  if (!input.attached && input.downloadUrl) textLines.push(input.downloadUrl);
  textLines.push('', from);
  const text = textLines.join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
${note ? `<p style="margin:0 0 16px;font-size:16px;line-height:24px;white-space:pre-wrap">${esc(note)}</p>` : ''}
<p style="margin:0;font-size:18px;font-weight:700;color:${BRAND_NAVY}">${esc(input.pdfName)}</p>
<p style="margin:4px 0 0;font-size:15px;color:${MUTED}">${esc(input.jobAddress)}</p>
<p style="margin:12px 0 0;font-size:15px;color:${MUTED}">${esc(facts)}</p>
<p style="margin:16px 0 0;font-size:15px">${esc(attachLine)}</p>
${!input.attached && input.downloadUrl ? `<p style="margin:8px 0 0"><a href="${esc(input.downloadUrl)}" style="color:#1d4ed8;font-weight:700">Download the PDF</a></p>` : ''}
<p style="margin:20px 0 0;font-size:13px;color:${MUTED}">${esc(from)}</p>
</div>
</body></html>`;

  return { subject, html, text };
}

module.exports = { renderItpEmail };
