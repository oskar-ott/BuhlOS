// Send the pay period to accounts — the temporary export while Xero is out of
// action (owner pull 2026-08-15).
//
// POST { fromDate, toDate } → compose the SAME approved-hours PDF the
// Download PDF button serves (payroll-inputs collectRows → payroll-pdf) and
// email it to the accounts inbox from timesheets@buhlos.com. Emailing a report
// STAMPS NOTHING (payroll-boundary ADR #609: the locked batch stays the only
// thing that records a payroll run) — this is the sheet leaving the building,
// not a run commit. Re-sending is safe and produces a second identical email.
//
// TIMESHEETS_EMAIL_TO is the switch for the whole temporary process:
//   set   → the "Send to Tia" surfaces render (/hours/period card + the phone
//           closeout finale) and this endpoint sends;
//   unset → 503 here, the surfaces disappear, and the Xero finale gets its
//           slot back. No feature flag, no schema — one env var to turn the
//           interim process on and off.
//
// Env:
//   TIMESHEETS_EMAIL_TO        REQUIRED — the accounts inbox (Tia)
//   TIMESHEETS_EMAIL_FROM      optional sender override
//                              (default "BuhlOS Timesheets <timesheets@buhlos.com>")
//   TIMESHEETS_EMAIL_REPLY_TO  optional — where Tia's reply lands
//   TIMESHEETS_EMAIL_TO_NAME   optional greeting name (default "Tia")
//
// Admin only — payroll data leaves the system here.

const { setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { collectRows } = require('./_lib/payroll-inputs');
const { composePayrollPdf, rollupRows } = require('./_lib/payroll-pdf');
const { renderTimesheetsEmail } = require('./_lib/timesheets-email');
const { isEmailConfigured, sendEmail } = require('./_lib/email');
const auditLog = require('./_lib/audit-log');

const DEFAULT_FROM = 'BuhlOS Timesheets <timesheets@buhlos.com>';

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const to = String(process.env.TIMESHEETS_EMAIL_TO || '').trim();
  if (!to || !isEmailConfigured()) {
    // Honest 503, never a fake send: the UI hides its buttons off the same
    // env var, so landing here means the deployment is half-configured.
    return res.status(503).json({
      error:
        'Email to accounts is not configured — set TIMESHEETS_EMAIL_TO (and the Resend key) in the environment.',
      code: 'not_configured',
    });
  }

  // Explicit range only. The row engine would default to the current week,
  // but an EMAIL that guesses its period is how the wrong week reaches
  // accounts — refuse instead.
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fromDate = String(body.fromDate || '');
  const toDate = String(body.toDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return res.status(400).json({ error: 'fromDate and toDate are required (YYYY-MM-DD)' });
  }

  const ctx = await collectRows({ status: 'approved', fromDate, toDate });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const rows = ctx.rows;
  if (!rows.length) {
    return res.status(422).json({
      error: 'No approved hours in this period — nothing was sent.',
      code: 'empty_period',
    });
  }

  const generatedAtLabel = new Date().toISOString().slice(0, 10);
  const pdf = await composePayrollPdf({
    rows,
    fromDate: ctx.fromDate,
    toDate: ctx.toDate,
    statusLabel: 'approved',
    generatedAtLabel,
    includeDetail: true,
  });
  const attachmentName = `buhlos-hours-${ctx.fromDate}-to-${ctx.toDate}.pdf`;

  // The email body quotes the PDF's own rollup — one engine, no drift.
  const { workers, totals } = rollupRows(rows);
  const msg = renderTimesheetsEmail({
    fromDate: ctx.fromDate,
    toDate: ctx.toDate,
    recipientName: process.env.TIMESHEETS_EMAIL_TO_NAME || 'Tia',
    workers: workers.map((w) => ({
      workerName: w.workerName,
      hours: w.hours,
      overtimeHours: w.overtimeHours,
    })),
    totalHours: totals.hours,
    overtimeHours: totals.overtimeHours,
    attachmentName,
    sentByName: me.username || '',
  });

  const sent = await sendEmail({
    to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    from: process.env.TIMESHEETS_EMAIL_FROM || DEFAULT_FROM,
    replyTo: process.env.TIMESHEETS_EMAIL_REPLY_TO || undefined,
    attachments: [{ filename: attachmentName, content: Buffer.from(pdf).toString('base64') }],
  });
  if (!sent.ok) {
    return res.status(502).json({
      error: `The email provider refused the send (${sent.reason}) — nothing reached accounts. Try again, and check the Resend dashboard if it keeps failing.`,
      code: sent.reason || 'send_failed',
    });
  }

  // Journal AFTER the send lands; a journal failure never un-sends an email,
  // so it must never fail the response either. Awaited (not fire-and-forget)
  // so "who sent which period where" is durable before we ack.
  // Privacy line matches hours-audit: identity + hours, never a rate or $.
  await auditLog
    .append({
      action: 'hours.timesheets_emailed',
      actorId: me.id,
      actorName: me.username || '',
      actorRole: me.role || null,
      jobId: null,
      targetType: 'time_entry',
      targetId: `period:${ctx.fromDate}:${ctx.toDate}`,
      summary: `${me.username || 'someone'} emailed the ${ctx.fromDate} – ${ctx.toDate} timesheets PDF to accounts`.slice(0, 240),
      metadata: {
        fromDate: ctx.fromDate,
        toDate: ctx.toDate,
        to,
        workerCount: totals.workerCount,
        totalHours: totals.hours,
        overtimeHours: totals.overtimeHours,
        rowCount: rows.length,
      },
    })
    .catch(() => {});

  return res.status(200).json({
    sent: true,
    to,
    fromDate: ctx.fromDate,
    toDate: ctx.toDate,
    workerCount: totals.workerCount,
    totalHours: totals.hours,
    overtimeHours: totals.overtimeHours,
    rowCount: rows.length,
  });
};
