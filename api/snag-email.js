// Snag-to-email: composer submits here, we call Resend, we log an audit entry.
//
// Requirements (locked in with user):
//   - Sender:     noreply@buhl.com.au
//   - Reply-to:   the sending tradie/LH/admin's email (from their user record)
//   - Roles:      admin, leadingHand, tradie can send. Clients read-only.
//   - Photos:     1024px max longest-edge (client already resized before POST).
//                 Posted as base64 data URLs in `attachments[].dataUrl`.
//   - Audit log:  jobs/<jobId>/snag-emails.json — visible to admin + leadingHand.
//                 Non-admins cannot list it. (Enforced in GET action=list.)
//   - CC rule:    snag.createdBy user's email is auto-CC'd if different from sender.
//
// Uses Resend's HTTPS API directly (no SDK — keeps bundle small, matches other APIs).
// Env vars required:
//   RESEND_API_KEY   — provisioned by user in Vercel dashboard
//   (SNAG_EMAIL_FROM optional override; defaults to noreply@buhl.com.au)

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

const DEFAULT_FROM = 'BUHL Snags <noreply@buhlapp.xyz>';
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4 MB per photo (Resend cap is 40 MB total)

function newId() {
  return 'em_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function normaliseList(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const e = String(raw || '').trim().toLowerCase();
    if (!e || !isValidEmail(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

async function findUserEmailById(userId) {
  if (!userId) return null;
  const users = await readBlob('users.json', { users: [] });
  const u = (users.users || []).find(x => x.id === userId);
  return (u && u.email) || null;
}

async function findUserEmailByUsername(username) {
  if (!username) return null;
  const users = await readBlob('users.json', { users: [] });
  const u = (users.users || []).find(x => (x.username || '').toLowerCase() === String(username).toLowerCase());
  return (u && u.email) || null;
}

// ── Resend send ────────────────────────────────────────────────────────────
async function sendViaResend({ from, to, cc, replyTo, subject, html, text, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');

  const payload = {
    from,
    to,
    subject,
    html,
    text,
  };
  if (cc && cc.length) payload.cc = cc;
  if (replyTo) payload.reply_to = replyTo;
  if (attachments && attachments.length) payload.attachments = attachments;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (body && (body.message || body.error)) || `Resend ${r.status}`;
    throw new Error(msg);
  }
  return body; // { id: '...' }
}

// ── HTML body builder ──────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// NOTE: snag fields follow the existing client model: `desc`, `by`, `stage`, `dwelling`, `priority`, `status`.
// Dwelling is an area ID; we pass the display name in from the client as `dwellingName`.
function buildHtml({ jobName, snag, dwellingName, bodyText, senderName }) {
  const sev = (snag.priority || 'Medium');
  const sevColor = sev === 'High' ? '#dc2626' : sev === 'Low' ? '#64748b' : '#d97706';
  const locLine = [dwellingName || snag.dwelling, snag.stage].filter(Boolean).join(' \u00b7 ');

  const bodyHtml = escapeHtml(bodyText || '').replace(/\n/g, '<br>');

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.5;margin:0;padding:24px;background:#f8fafc">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="padding:16px 20px;background:#0d1f35;color:#fff">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75">BUHL Electrical \u2014 Snag report</div>
      <div style="font-size:16px;font-weight:700;margin-top:2px">${escapeHtml(jobName || 'Job')}</div>
    </div>
    <div style="padding:20px">
      <div style="display:inline-block;padding:3px 10px;border-radius:999px;background:${sevColor};color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">${escapeHtml(sev)} priority</div>
      <h2 style="margin:12px 0 8px;font-size:17px;font-weight:700">${escapeHtml(snag.desc || 'Snag')}</h2>
      ${locLine ? `<div style="font-size:13px;color:#64748b;margin-bottom:16px">${escapeHtml(locLine)}</div>` : ''}
      ${bodyHtml ? `<div style="font-size:14px;color:#0f172a;margin:16px 0;padding:14px;background:#f8fafc;border-radius:8px;border-left:3px solid #0d1f35">${bodyHtml}</div>` : ''}
      <div style="font-size:12px;color:#64748b;margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0">
        Sent by ${escapeHtml(senderName)} via BUHL OS \u00b7 reply to this email to respond directly.
      </div>
    </div>
  </div>
</body></html>`;
}

function buildText({ jobName, snag, dwellingName, bodyText, senderName }) {
  const lines = [];
  lines.push(`BUHL Electrical \u2014 Snag report`);
  lines.push(`Job: ${jobName || ''}`);
  lines.push(`Priority: ${snag.priority || 'Medium'}`);
  const locBits = [dwellingName || snag.dwelling, snag.stage].filter(Boolean);
  if (locBits.length) lines.push(`Location: ${locBits.join(' \u00b7 ')}`);
  lines.push('');
  lines.push(`Description:`);
  lines.push(snag.desc || '');
  if (bodyText) {
    lines.push('');
    lines.push(bodyText);
  }
  lines.push('');
  lines.push(`\u2014 Sent by ${senderName} via BUHL OS`);
  return lines.join('\n');
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const LOG_KEY = `jobs/${jobId}/snag-emails.json`;
  const action = (req.query && req.query.action) || '';

  // ── GET ?action=list  — audit log for admin + leadingHand only.
  if (req.method === 'GET' && action === 'list') {
    if (user.role !== 'admin' && user.role !== 'leadingHand') {
      return res.status(403).json({ error: 'forbidden' });
    }
    const data = await readBlob(LOG_KEY, { emails: [] });
    return res.status(200).json(data);
  }

  // ── GET ?action=for-snag&snagId=X — per-snag log, visible to anyone who can access the job.
  //    This is what feeds the "Communications" strip on the snag modal.
  if (req.method === 'GET' && action === 'for-snag') {
    const snagId = (req.query && req.query.snagId) || '';
    if (!snagId) return res.status(400).json({ error: 'snagId required' });
    const data = await readBlob(LOG_KEY, { emails: [] });
    const emails = (data.emails || [])
      .filter(e => e.snagId === snagId)
      // For non-admin/LH, strip body content and attachments (still show recipients + time)
      .map(e => {
        if (user.role === 'admin' || user.role === 'leadingHand') return e;
        const { bodyText, html, attachments, ...safe } = e;
        return safe;
      });
    return res.status(200).json({ emails });
  }

  // ── POST — send email.
  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    if (user.role === 'client') return res.status(403).json({ error: 'clients cannot send emails' });
    if (!user.email) return res.status(400).json({ error: 'your user profile has no email set — ask an admin to add one' });

    const { snagId, to, cc, subject, bodyText, includePhotos, attachments, dwellingName } = req.body || {};
    if (!snagId) return res.status(400).json({ error: 'snagId required' });

    // Load job + snag
    const dataBlob = await readBlob(`jobs/${jobId}/data.json`, { snags: [] });
    const snag = (dataBlob.snags || []).find(s => s.id === snagId);
    if (!snag) return res.status(404).json({ error: 'snag not found' });

    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
    const jobName = (job && job.name) || jobId;

    // Recipients
    const toList = normaliseList(to);
    if (!toList.length) return res.status(400).json({ error: 'at least one recipient required' });

    let ccList = normaliseList(cc);

    // Auto-CC: the snag's createdBy user, if their email is set and not already sender or in to/cc
    // Snag model uses `by` (username string) + optional `createdByUserId` (new field added by client).
    let createdByEmail = null;
    if (snag.createdByUserId) createdByEmail = await findUserEmailById(snag.createdByUserId);
    if (!createdByEmail && snag.by) createdByEmail = await findUserEmailByUsername(snag.by);
    if (createdByEmail) {
      const e = createdByEmail.toLowerCase();
      if (e !== user.email.toLowerCase() && !toList.includes(e) && !ccList.includes(e)) {
        ccList.push(e);
      }
    }

    // Attachments
    const outAttachments = [];
    if (includePhotos && Array.isArray(attachments)) {
      const slice = attachments.slice(0, MAX_ATTACHMENTS);
      for (let i = 0; i < slice.length; i++) {
        const a = slice[i];
        const parsed = dataUrlToBuffer(a && a.dataUrl);
        if (!parsed) continue;
        if (parsed.buffer.length > MAX_ATTACHMENT_BYTES) {
          return res.status(400).json({ error: `photo ${i + 1} is too large — max 4 MB per photo` });
        }
        const ext = parsed.mimeType.includes('png') ? 'png' : 'jpg';
        outAttachments.push({
          filename: (a.filename || `snag-photo-${i + 1}.${ext}`),
          content: parsed.buffer.toString('base64'),
        });
      }
    }

    // Build email
    const senderName = user.username || 'BUHL';
    const from = process.env.SNAG_EMAIL_FROM || DEFAULT_FROM;
    const finalSubject = (subject && String(subject).trim()) ||
                         `[${jobName}] ${snag.priority || 'Snag'}: ${(snag.desc || '').slice(0, 60)}`;
    const html = buildHtml({ jobName, snag, dwellingName, bodyText, senderName });
    const text = buildText({ jobName, snag, dwellingName, bodyText, senderName });

    let sendResult;
    try {
      sendResult = await sendViaResend({
        from,
        to: toList,
        cc: ccList,
        replyTo: user.email,
        subject: finalSubject,
        html,
        text,
        attachments: outAttachments,
      });
    } catch (e) {
      return res.status(502).json({ error: 'send failed: ' + e.message });
    }

    // Audit log (write last so failures don't pollute)
    const logEntry = {
      id: newId(),
      providerId: sendResult && sendResult.id,
      snagId,
      from,
      replyTo: user.email,
      to: toList,
      cc: ccList,
      subject: finalSubject,
      bodyText: bodyText || '',
      photoCount: outAttachments.length,
      sentByUserId: user.id,
      sentBy: user.username,
      sentAt: new Date().toISOString(),
    };
    try {
      const log = await readBlob(LOG_KEY, { emails: [] });
      log.emails = log.emails || [];
      log.emails.unshift(logEntry);
      // Keep last 500 to bound blob size
      if (log.emails.length > 500) log.emails.length = 500;
      await writeBlob(LOG_KEY, log);
    } catch (e) {
      // Swallow: email already sent. Surface as warning.
      return res.status(200).json({ ok: true, warning: 'sent but log write failed: ' + e.message, entry: logEntry });
    }

    return res.status(200).json({ ok: true, entry: logEntry });
  }

  res.status(405).end();
};
