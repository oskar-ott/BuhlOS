'use strict';

// Timesheets → accounts email (owner pull 2026-08-15) — pure render module.
//
// While the Xero push is out of action, the pay run leaves the building as an
// email instead: the approved-hours PDF attached, this message around it. Same
// voice + shell rules as the invite templates (api/_lib/email-templates.js):
// inline styles only (email clients strip <style>), plain text first-class —
// same words, same figures. PURE — no I/O, no env; the endpoint
// (api/time-entries-email.js) resolves addresses and composes the PDF.
//
// The figures here are the rollup the PDF itself prints (payroll-pdf
// rollupRows) — the body can never disagree with the attachment.

const BRAND_NAVY = '#0d1f35';
const BRAND_YELLOW = '#ffcc00';
const INK = '#2a3958';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/**
 * Human pay-period label, Australian day-first order:
 *   same month → "11 – 17 Aug 2026"
 *   same year  → "28 Jul – 3 Aug 2026"
 *   cross-year → "29 Dec 2025 – 4 Jan 2026"
 * Anything that isn't YYYY-MM-DD passes through untouched, never mangled.
 */
function periodLabel(fromISO, toISO) {
  const f = parseISO(fromISO);
  const t = parseISO(toISO);
  if (!f || !t) return `${fromISO} – ${toISO}`;
  const fm = MONTHS[f.mo - 1];
  const tm = MONTHS[t.mo - 1];
  if (f.y !== t.y) return `${f.d} ${fm} ${f.y} – ${t.d} ${tm} ${t.y}`;
  if (f.mo !== t.mo) return `${f.d} ${fm} – ${t.d} ${tm} ${t.y}`;
  return `${f.d} – ${t.d} ${fm} ${f.y}`;
}

/** "7.6h", "38h" — trailing-zero-free, unit always attached. */
function hoursLabel(n) {
  return `${Math.round((Number(n) || 0) * 100) / 100}h`;
}

/**
 * Render the send-to-accounts message.
 *
 * ctx: {
 *   fromDate, toDate,          ISO period bounds (label built here)
 *   recipientName,             e.g. "Tia" — greeting only
 *   workers,                   [{ workerName, hours, overtimeHours }] (rollup order)
 *   totalHours, overtimeHours, period totals off the same rollup
 *   attachmentName,            the PDF filename, named so it can't get lost
 *   sentByName?                who closed the week off (signature line)
 * }
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderTimesheetsEmail(ctx) {
  const label = periodLabel(ctx.fromDate, ctx.toDate);
  const workers = Array.isArray(ctx.workers) ? ctx.workers : [];
  const total = hoursLabel(ctx.totalHours);
  const ot = Math.round((Number(ctx.overtimeHours) || 0) * 100) / 100;
  const who = String(ctx.recipientName || 'there');
  const count = workers.length;
  const workerWord = count === 1 ? 'worker' : 'workers';

  const subject = `Timesheets ${label} · ${count} ${workerWord} · ${total}`;

  const rowsHtml = workers
    .map(
      (w) => `<tr>
<td style="padding:9px 8px 9px 0;font-size:14px;color:${INK};border-bottom:1px solid #eef0f4">${esc(w.workerName)}${
        (Number(w.overtimeHours) || 0) > 0
          ? `<span style="color:#8a6d1a;font-size:12px"> · incl. ${hoursLabel(w.overtimeHours)} OT</span>`
          : ''
      }</td>
<td align="right" style="padding:9px 0;font-size:14px;font-weight:700;color:${BRAND_NAVY};border-bottom:1px solid #eef0f4;white-space:nowrap">${hoursLabel(w.hours)}</td>
</tr>`,
    )
    .join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f3efe7;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0">
<tr><td style="padding:32px 32px 8px">
<div style="font-weight:800;font-size:26px;letter-spacing:-.03em;color:${BRAND_NAVY};margin-bottom:20px">b<span style="border-bottom:6px solid ${BRAND_YELLOW};line-height:.8">ü</span>hl</div>
<h1 style="font-size:22px;line-height:1.2;color:${BRAND_NAVY};margin:0 0 14px;font-weight:700">Timesheets — ${esc(label)}</h1>
<p style="font-size:15px;line-height:1.5;color:${INK};margin:0 0 14px">Hi ${esc(who)} — the approved timesheets for <b>${esc(label)}</b> are attached as a PDF (<span style="font-family:ui-monospace,monospace;font-size:13px">${esc(ctx.attachmentName)}</span>). Totals below; the PDF has the day-by-day breakdown per worker.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 6px;border-top:1px solid #e2e8f0">
${rowsHtml}
<tr>
<td style="padding:10px 8px 10px 0;font-size:14px;font-weight:700;color:${BRAND_NAVY}">Total · ${count} ${workerWord}</td>
<td align="right" style="padding:10px 0;font-size:15px;font-weight:800;color:${BRAND_NAVY};white-space:nowrap">${esc(total)}</td>
</tr>
</table>
${ot > 0 ? `<p style="font-size:13px;color:#8a6d1a;margin:0 0 14px">Includes ${hoursLabel(ot)} overtime across the period — split out per worker in the PDF.</p>` : ''}
<p style="font-size:13px;line-height:1.5;color:#6a7591;margin:10px 0 0">Sent from BuhlOS when the pay week was closed off${ctx.sentByName ? ` by ${esc(ctx.sentByName)}` : ''}. If anything looks off, reply to this email or call the office.</p>
</td></tr>
<tr><td style="padding:14px 32px;background:#f6f7f9;border-top:1px solid #e2e8f0;font-size:11px;color:#6a7591">BuhlOS · approved hours only — figures match the attached PDF.</td></tr>
</table></body></html>`;

  const textRows = workers.map(
    (w) =>
      `  ${w.workerName} — ${hoursLabel(w.hours)}${(Number(w.overtimeHours) || 0) > 0 ? ` (incl. ${hoursLabel(w.overtimeHours)} OT)` : ''}`,
  );
  const text = [
    `Hi ${who},`,
    '',
    `The approved timesheets for ${label} are attached as a PDF (${ctx.attachmentName}).`,
    'Totals below; the PDF has the day-by-day breakdown per worker.',
    '',
    ...textRows,
    '',
    `  Total (${count} ${workerWord}) — ${total}${ot > 0 ? ` incl. ${hoursLabel(ot)} overtime` : ''}`,
    '',
    `Sent from BuhlOS when the pay week was closed off${ctx.sentByName ? ` by ${ctx.sentByName}` : ''}.`,
    'If anything looks off, reply to this email or call the office.',
  ].join('\n');

  return { subject, html, text };
}

module.exports = { renderTimesheetsEmail, periodLabel, hoursLabel };
