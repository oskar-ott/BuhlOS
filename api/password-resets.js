// Password reset requests — users who forgot their password/PIN ask
// admin to reset it manually.
//
// Chose a separate endpoint (not folded into access-requests.js) because
// the schemas + enumeration rules differ enough that a discriminator
// would muddy both: access-requests has a richer schema (role/job/etc)
// and may want to expose "your request was received" UX details, while
// password-resets is enumeration-resistant by design (always 200, never
// confirm whether the name matches an account). Splitting keeps the
// rules and the audit log clean.
//
// Flow:
//   • POST /api/password-resets    — public. Always returns 200 + {ok:true}
//     regardless of whether the name matches a real account, so the form
//     can't be used to enumerate valid users. We still always persist
//     the record (admin sees ALL requests, including ones with no
//     matching account — useful signal that someone's confused or
//     phishing). Resend alert to admin.
//   • GET  /api/password-resets    — admin only. ?status=open|resolved|all.
//   • PUT  /api/password-resets?id= — admin only. Update status + notes.
//
// Storage: password-resets/<id>.json

const { put, list } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const VALID_STATUS = ['open', 'resolved'];

// Per-instance rate limit (see access-requests.js for context — same
// TODO about needing a shared store for cluster-wide enforcement).
const RL = new Map();
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
  return 'pwr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function listAllResets() {
  const { blobs } = await list({ prefix: 'password-resets/', token: process.env.BLOB_READ_WRITE_TOKEN });
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

async function alertAdmin(record, nameMatchesAccount) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: 'no RESEND_API_KEY configured' };
  const to = process.env.ADMIN_ALERT_EMAIL || 'office@buhlapp.xyz';
  const from = 'BuhlOS <noreply@buhlapp.xyz>';
  const subject = 'BuhlOS — password reset request for ' + (record.name || 'unknown');
  // Tell the admin (in the email body, NOT the public response) whether
  // the requested name actually maps to a user. Saves them a lookup.
  const matchLine = nameMatchesAccount
    ? `<span style="color:#1f8b5a;font-weight:600">✓ matches an existing account</span>`
    : `<span style="color:#d68a1a;font-weight:600">⚠ no account with this name — could be a typo or someone fishing</span>`;
  const html = [
    `<p style="margin:0 0 12px;font-size:15px"><b>${escapeHtml(record.name)}</b> can't log in and wants you to reset their password/PIN.</p>`,
    `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">`,
    `<tr><td style="color:#6a7591">Name they entered</td><td><b>${escapeHtml(record.name)}</b></td></tr>`,
    `<tr><td style="color:#6a7591">Account match</td><td>${matchLine}</td></tr>`,
    `<tr><td style="color:#6a7591">Reach them on</td><td>${escapeHtml(record.contact)}</td></tr>`,
    `<tr><td style="color:#6a7591">Submitted</td><td>${escapeHtml(record.createdAt)}</td></tr>`,
    `</table>`,
    `<p style="margin:18px 0 0;font-size:13px;color:#6a7591">Triage at <a href="https://buhlapp.xyz/admin/support">/admin/support</a> — reset the password from /admin/crew and text them out-of-band.</p>`,
    `<p style="margin:6px 0 0;font-size:11px;color:#9aa3bc">Request id: <code>${escapeHtml(record.id)}</code> · alerts go to <code>${escapeHtml(to)}</code> (set <code>ADMIN_ALERT_EMAIL</code> to change)</p>`,
  ].join('\n');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text: `Password reset request: ${record.name} (${nameMatchesAccount ? 'matches account' : 'no account match'}). Contact: ${record.contact}. Triage at https://buhlapp.xyz/admin/support` }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      return { error: (body && (body.message || body.error)) || ('Resend ' + r.status) };
    }
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// Cheap check: does this name correspond to a real user? Done only for
// the admin email body. NEVER surfaced in the HTTP response — enumeration
// resistance is the whole point of this endpoint's contract.
async function nameMatchesAccount(name) {
  if (!name) return false;
  try {
    const users = await readBlob('users.json', { users: [] });
    const target = String(name).trim().toLowerCase();
    return (users.users || []).some(u => (u.username || '').toLowerCase() === target);
  } catch (e) { return false; }
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── POST — public + enumeration-resistant ────────────────────────────
  if (req.method === 'POST') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
    // Rate-limit but still respond 200 — we don't want a 429 to leak
    // signal that a name was a valid target either. The form just sees
    // the same success path; rate-limited requests are dropped silently.
    if (!rateLimitOk(ip)) return res.status(200).json({ ok: true });

    const body = req.body || {};
    const name    = String(body.name    || '').trim().slice(0, 120);
    const contact = String(body.contact || '').trim().slice(0, 200);
    if (!name || !contact) {
      // The spec said always-success, but missing fields are a client bug
      // not an enumeration leak — surface those to the form.
      return res.status(400).json({ error: 'name and contact are required' });
    }

    const matches = await nameMatchesAccount(name);
    const record = {
      id: newId(),
      type: 'password-reset',
      name, contact,
      // Admin sees this signal in the inbox; users do not.
      nameMatchesAccount: matches,
      status: 'open',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedByUserId: null,
      resolvedByName: null,
      adminNotes: '',
      sourceIp: ip || null,
      sourceUserAgent: (req.headers['user-agent'] || '').slice(0, 200) || null,
    };
    try { await writeBlob('password-resets/' + record.id + '.json', record); }
    catch (e) { /* still return success — don't leak save failure as enum signal */ }
    alertAdmin(record, matches).then(r => {
      if (r && r.error) console.error('password-reset email alert failed:', r.error);
    }).catch(e => console.error('password-reset email alert threw:', e.message));
    return res.status(200).json({ ok: true });
  }

  // ── GET + PUT — admin only ──────────────────────────────────────────
  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  if (req.method === 'GET') {
    const filter = (req.query && req.query.status) || 'open';
    const all = await listAllResets();
    const visible = filter === 'all' ? all : all.filter(r => r.status === filter);
    return res.status(200).json({ resets: visible, total: all.length });
  }

  if (req.method === 'PUT') {
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id query param required' });
    const key = 'password-resets/' + id + '.json';
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
        next.resolvedAt = null; next.resolvedByUserId = null; next.resolvedByName = null;
      }
    }
    if (body.adminNotes !== undefined) next.adminNotes = String(body.adminNotes || '').slice(0, 2000);
    try { await writeBlob(key, next); }
    catch (e) { return res.status(500).json({ error: 'save failed' }); }
    return res.status(200).json({ reset: next });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
