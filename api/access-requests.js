// Access requests — people without an account asking to be set up.
//
// Flow:
//   • POST /api/access-requests     — public (no auth). Captures contact
//     + intended role + (optional) job/site + message. Creates a record
//     with status 'open' and fires a Resend email to the admin inbox
//     (best-effort; never blocks the response).
//   • GET  /api/access-requests     — admin only. Lists requests with
//     optional ?status=open|resolved|rejected|all filter.
//   • PUT  /api/access-requests?id= — admin only. Update status,
//     adminNotes, resolvedAt, resolvedByUserId. Used by the admin
//     Support inbox to triage.
//
// Storage:
//   access-requests/<id>.json  — one file per request. List view enumerates
//                                with list({ prefix: 'access-requests/' })
//                                and fetches each.
//
// Email transport:
//   Reuses the Resend integration already wired for api/snag-email.js
//   (RESEND_API_KEY env var). Recipient: ADMIN_ALERT_EMAIL env var,
//   fallback to office@buhlapp.xyz (call it out in the email body so
//   admin can fix the env var if the wrong inbox is getting messages).
//   On send-failure we log + continue — the request is still saved.
//
// Rate limit:
//   Soft cap of 5 requests per IP per 30 min via in-memory map. This is
//   per-instance not per-cluster — fine for v1 to slow obvious spam,
//   not a security control. A real rate limit would need a shared store
//   (Vercel KV). Flagged here as a TODO.

const { put, list } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const VALID_ROLES   = ['tradie', 'client'];
const VALID_STATUS  = ['open', 'resolved', 'rejected'];

// TODO: per-cluster rate limit would need a shared store. This map is
// per-serverless-instance and resets on cold start — fine for v1 spam
// slowdown, not a security control.
const RL = new Map(); // ip → [{ ts }]
const RL_WINDOW_MS = 30 * 60 * 1000;
const RL_MAX = 5;
function rateLimitOk(ip) {
  if (!ip) return true;
  const now = Date.now();
  const hits = (RL.get(ip) || []).filter(h => now - h.ts < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) return false;
  hits.push({ ts: now });
  RL.set(ip, hits);
  return true;
}

function newId() {
  return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function listAllRequests() {
  const { blobs } = await list({ prefix: 'access-requests/', token: process.env.BLOB_READ_WRITE_TOKEN });
  const records = await Promise.all((blobs || [])
    .filter(b => b.pathname.endsWith('.json'))
    .map(async b => {
      try {
        const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return null;
        return await r.json();
      } catch (e) { return null; }
    }));
  return records.filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// Fire-and-forget email alert to admin. Failures are logged but never
// block the response — the request is already persisted to blob.
async function alertAdmin(record) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: 'no RESEND_API_KEY configured' };
  const to = process.env.ADMIN_ALERT_EMAIL || 'office@buhlapp.xyz';
  const from = 'BuhlOS <noreply@buhlapp.xyz>';
  const subject = 'BuhlOS — new access request from ' + (record.name || 'unknown');
  const lines = [
    `<p style="margin:0 0 12px;font-size:15px"><b>${escapeHtml(record.name)}</b> wants access to BuhlOS.</p>`,
    `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">`,
    `<tr><td style="color:#6a7591">Name</td><td><b>${escapeHtml(record.name)}</b></td></tr>`,
    `<tr><td style="color:#6a7591">Phone</td><td><a href="tel:${escapeHtml(record.phone)}">${escapeHtml(record.phone)}</a></td></tr>`,
    `<tr><td style="color:#6a7591">Email</td><td><a href="mailto:${escapeHtml(record.email)}">${escapeHtml(record.email)}</a></td></tr>`,
    `<tr><td style="color:#6a7591">Role</td><td>${escapeHtml(record.requestedRole === 'client' ? 'Client' : 'Tradie')}</td></tr>`,
    record.jobOrSite ? `<tr><td style="color:#6a7591">Job / site</td><td>${escapeHtml(record.jobOrSite)}</td></tr>` : '',
    record.message ? `<tr><td style="color:#6a7591;vertical-align:top">Message</td><td style="white-space:pre-wrap">${escapeHtml(record.message)}</td></tr>` : '',
    `</table>`,
    `<p style="margin:18px 0 0;font-size:13px;color:#6a7591">Triage at <a href="https://buhlapp.xyz/admin/support">/admin/support</a></p>`,
    `<p style="margin:6px 0 0;font-size:11px;color:#9aa3bc">Request id: <code>${escapeHtml(record.id)}</code> · alerts go to <code>${escapeHtml(to)}</code> (set <code>ADMIN_ALERT_EMAIL</code> to change)</p>`,
  ].join('\n');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html: lines, text: `New access request from ${record.name}. Phone: ${record.phone}. Email: ${record.email}. Role: ${record.requestedRole}.${record.jobOrSite ? ' Job/site: ' + record.jobOrSite : ''}${record.message ? '\n\n' + record.message : ''}\n\nTriage at https://buhlapp.xyz/admin/support` }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      return { error: (body && (body.message || body.error)) || ('Resend ' + r.status) };
    }
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── POST — public ────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
    if (!rateLimitOk(ip)) {
      return res.status(429).json({ error: 'Too many requests — try again later.' });
    }
    const body = req.body || {};
    const name  = String(body.name  || '').trim().slice(0, 120);
    const phone = String(body.phone || '').trim().slice(0, 40);
    const email = String(body.email || '').trim().slice(0, 200);
    const role  = String(body.requestedRole || '').trim();
    const jobOrSite = String(body.jobOrSite || '').trim().slice(0, 200);
    const message   = String(body.message   || '').trim().slice(0, 2000);
    if (!name || !phone || !email) return res.status(400).json({ error: 'name, phone and email are required' });
    if (!isValidEmail(email))      return res.status(400).json({ error: 'email is not valid' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'requestedRole must be tradie or client' });

    const now = new Date().toISOString();
    const record = {
      id: newId(),
      type: 'access-request',
      name, phone, email,
      requestedRole: role,
      jobOrSite: jobOrSite || null,
      message:   message   || null,
      status: 'open',
      createdAt: now,
      resolvedAt: null,
      resolvedByUserId: null,
      resolvedByName: null,
      adminNotes: '',
      // light fingerprint for admin (not exposed to public lookup)
      sourceIp: ip || null,
      sourceUserAgent: (req.headers['user-agent'] || '').slice(0, 200) || null,
    };
    try {
      await writeBlob('access-requests/' + record.id + '.json', record);
    } catch (e) {
      return res.status(500).json({ error: 'could not save request — try again' });
    }
    // Fire email asynchronously. Don't await — response shouldn't depend
    // on Resend availability.
    alertAdmin(record).then(r => {
      if (r && r.error) console.error('access-request email alert failed:', r.error);
    }).catch(e => console.error('access-request email alert threw:', e.message));
    return res.status(201).json({ ok: true });
  }

  // ── GET + PUT — admin only ──────────────────────────────────────────
  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  if (req.method === 'GET') {
    const filter = (req.query && req.query.status) || 'open';
    const all = await listAllRequests();
    const visible = filter === 'all' ? all : all.filter(r => r.status === filter);
    return res.status(200).json({ requests: visible, total: all.length });
  }

  if (req.method === 'PUT') {
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id query param required' });
    const key = 'access-requests/' + id + '.json';
    const existing = await readBlob(key, null);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const body = req.body || {};
    const next = { ...existing };
    if (body.status !== undefined) {
      if (!VALID_STATUS.includes(body.status)) return res.status(400).json({ error: 'invalid status' });
      next.status = body.status;
      if (body.status !== 'open') {
        next.resolvedAt = new Date().toISOString();
        next.resolvedByUserId = me.id;
        next.resolvedByName = me.username;
      } else {
        next.resolvedAt = null;
        next.resolvedByUserId = null;
        next.resolvedByName = null;
      }
    }
    if (body.adminNotes !== undefined) next.adminNotes = String(body.adminNotes || '').slice(0, 2000);
    try { await writeBlob(key, next); }
    catch (e) { return res.status(500).json({ error: 'save failed' }); }
    return res.status(200).json({ request: next });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
