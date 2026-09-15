// Self-service PIN / password recovery (owner pull 2026-09-14).
//
// THE PROBLEM THIS SOLVES: a worker who forgets their PIN is locked out with no
// way back. The invite flow is NOT a reset — accepting an invite refuses an
// email that already has an account (api/invites.js, anti-takeover) — and the
// office's in-place Reset PIN (PUT /api/users) needs an admin at a keyboard. So
// recovery meant texting the boss.
//
// THE GATE IS INBOX CONTROL, NOT KNOWING AN EMAIL. An unauthenticated screen
// must never reset a credential from a typed address alone: anyone who knew a
// worker's email could lock them out and take the account. Instead we email a
// one-time link to the address ON FILE; only someone who can read that inbox
// can set a new PIN. Same token discipline as invites (api/invites.js):
//
//   · token = 32 random bytes, handed out ONCE inside the emailed link;
//   · only its bcrypt HASH is stored — a leak of the blob grants nothing;
//   · single-use (consumed on success) and short-lived (60 minutes);
//   · issuing a new link invalidates that account's earlier pending ones;
//   · the reset is IN PLACE — same account id, so assigned jobs and hours
//     history are untouched (never a new/duplicate account).
//
// WHY THIS NAMES AN UNKNOWN ADDRESS (owner decision, 2026-09-15). This used to
// answer every request identically — unknown address, disabled account, rate
// limited, provider down — so the endpoint couldn't be used to discover who has
// an account. That protection was worth little here and cost real support: a
// worker who mistypes their address is told "check your email" and waits for a
// link that was never sent (exactly what happened on 14 Sep). The crew's
// addresses follow firstname@<company domain> and are guessable anyway, so the
// silence bought secrecy nobody needed and spent the honesty P7 requires.
//
// So ?action=request now reports WHICH of four things happened. What still
// protects the accounts, and must not be weakened to compensate:
//   · the rate limits below (8 addresses per IP / 3 per address, per 30 min)
//     cap how fast a list can be walked;
//   · login itself throttles at 5 wrong PINs per 15 minutes (api/auth.js);
//   · a reset still only ever DELIVERS to the address on file — naming an
//     account grants nothing, the token still goes to the inbox.
// 'unavailable' deliberately covers disabled AND no-address-on-file together:
// "you're disabled" is the office's news to break, not the app's.
//
// Routes:
//   POST /api/pin-reset?action=request   { email }                → 200 { ok, outcome }
//   GET  /api/pin-reset?action=resolve&token=…                    → { state, firstName? }
//   POST /api/pin-reset?action=accept    { token, pin, confirmPin }→ { ok, username }
//
// Storage: pin-resets.json { resets: [...] } — pruned on every write.
// NOTHING here logs the token or the PIN.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { isDisabledUser } = require('./_lib/auth');
const { isEmailConfigured, sendTemplate, companyName } = require('./_lib/email');
const { createRateLimiter } = require('./_lib/rate-limit');
const audit = require('./_lib/audit-log');

const RESETS_KEY = 'pin-resets.json';
const USERS_KEY = 'users.json';
const TOKEN_BYTES = 32;
// Short by design: a password-reset link is a bearer credential sitting in an
// inbox. Long enough for a worker to open it on site, short enough that an old
// email is not a standing key.
const TTL_MINUTES = 60;
// Used/expired records are kept briefly so a second tap on a spent link still
// says "already used" rather than "invalid", then dropped so the scan stays small.
const PRUNE_AFTER_HOURS = 24;

// Two limiters, both per-serverless-instance (honest limitation — a slowdown,
// not a cluster-wide lock; see api/_lib/rate-limit.js). Per-IP stops a scanner;
// per-address stops mailbox-bombing one worker.
const ipLimiter = createRateLimiter({ windowMs: 30 * 60 * 1000, max: 8 });
const emailLimiter = createRateLimiter({ windowMs: 30 * 60 * 1000, max: 3 });

function nowIso() { return new Date().toISOString(); }
function newId() { return 'pr_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }

// Credential FORMAT policy, mirroring api/users.js validateSecret + the invite
// flow's common-PIN screen. role-literal-ok: format is tied to the literal
// stored role ('admin' logs in with a password), not the admin tier.
const BLOCKED_PINS = new Set(['0000', '1111', '1234', '4321', '1212', '6969', '2580', '0852']);
function isCommonPin(pin) {
  if (!/^\d{4}$/.test(pin)) return false;
  if (BLOCKED_PINS.has(pin)) return true;
  if (/^(\d)\1{3}$/.test(pin)) return true;
  const d = pin.split('').map(Number);
  const asc = d.every((n, i) => i === 0 || n === d[i - 1] + 1);
  const desc = d.every((n, i) => i === 0 || n === d[i - 1] - 1);
  const pair = pin[0] === pin[2] && pin[1] === pin[3];
  return asc || desc || pair;
}
function isPasswordRole(role) { return role === 'admin'; }
function validateSecret(role, secret) {
  if (!secret) return 'secret required';
  if (isPasswordRole(role)) {
    if (String(secret).length < 6) return 'Password must be at least 6 characters';
    return null;
  }
  if (!/^\d{4}$/.test(String(secret))) return 'PIN must be exactly 4 digits';
  if (isCommonPin(String(secret))) return "Pick a PIN that's less easy to guess";
  return null;
}

// Same account resolution as login (api/auth.js): exact username first, then a
// UNIQUE match on the email field. Zero or several matches resolve to nothing —
// we never guess between accounts.
function findUser(users, typed) {
  const key = String(typed || '').trim().toLowerCase();
  if (!key) return null;
  const byUsername = (users || []).find((u) => (u.username || '').toLowerCase() === key);
  if (byUsername) return byUsername;
  const byEmail = (users || []).filter((u) => (u.email || '').toLowerCase() === key);
  return byEmail.length === 1 ? byEmail[0] : null;
}

// Where the emailed link points. APP_BASE_URL wins; otherwise derive from the
// request (same fallback as api/_lib/signup-account.js).
function baseUrl(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : '';
}

function prune(resets, nowMs) {
  const cutoff = nowMs - PRUNE_AFTER_HOURS * 3600 * 1000;
  return (resets || []).filter((r) => {
    if (!r || !r.createdAt) return false;
    const created = Date.parse(r.createdAt);
    if (!Number.isFinite(created)) return false;
    return created >= cutoff;
  });
}

function stateOf(reset, nowMs) {
  if (!reset) return 'invalid';
  if (reset.status === 'used') return 'used';
  if (reset.status === 'superseded') return 'invalid';
  const exp = Date.parse(reset.expiresAt);
  if (!Number.isFinite(exp) || exp < nowMs) return 'expired';
  return 'valid';
}

// O(n) bcrypt scan over a pruned, short list — the invites precedent.
async function findByToken(resets, token) {
  if (!token || typeof token !== 'string') return null;
  for (const r of resets || []) {
    if (!r || !r.tokenHash) continue;
    try {
      if (await bcrypt.compare(token, r.tokenHash)) return r;
    } catch { /* a corrupt hash must not abort the scan */ }
  }
  return null;
}

async function writeAudit(action, user, summary, metadata) {
  try {
    await audit.append({
      action,
      actorId: user ? user.id : 'anonymous',
      actorName: user ? (user.username || user.id) : 'anonymous',
      actorRole: user ? user.role || null : null,
      targetType: 'employee',
      targetId: user ? user.id : 'unknown',
      summary,
      metadata: metadata || undefined,
    });
  } catch (e) {
    console.error('pin-reset audit append failed', action, e && e.message);
  }
}

// Why a request produced no email. The CALLER is never told — every path below
// still answers the same 200 {ok:true}, so this leaks nothing. It exists because
// the first real use of this flow (2026-09-14) ended with "email didn't send"
// and NOTHING in the function logs could say which silent branch ran: no match,
// disabled, no address on file, or a send that the provider accepted and then
// didn't deliver. `warn` rather than `log` so the answer is one error-level log
// query away. Never the typed address, never the token.
function trace(outcome) {
  console.warn(`pin-reset: ${outcome}`);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || '';
  const nowMs = Date.now();

  // ── POST ?action=request — public, ALWAYS 200 ───────────────────────────
  if (req.method === 'POST' && action === 'request') {
    const typed = String((req.body && req.body.email) || '').trim();
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || (req.socket && req.socket.remoteAddress) || '';
    // One of four outcomes, and the screen says each one plainly:
    //   sent        a link is on its way to the address on file
    //   no_account  nothing here matches what they typed
    //   unavailable there IS an account but no link can go to it (disabled, or
    //               no address on file) — ring the office
    //   throttled   too many tries just now
    const ok = (outcome, extra) => res.status(200).json({ ok: true, outcome, ...(extra || {}) });
    if (!typed) return res.status(400).json({ error: 'email required' });
    if (ip && ipLimiter.isLimited(ip)) {
      trace('rate limited by ip — no link sent');
      return ok('throttled', { retryAfterSec: ipLimiter.retryAfterSec(ip) });
    }
    const emailKey = typed.toLowerCase();
    if (emailLimiter.isLimited(emailKey)) {
      trace('rate limited by address — no link sent');
      return ok('throttled', { retryAfterSec: emailLimiter.retryAfterSec(emailKey) });
    }
    if (ip) ipLimiter.record(ip);
    emailLimiter.record(emailKey);

    try {
      const usersBlob = await readBlob(USERS_KEY, { users: [] });
      const user = findUser(usersBlob.users || [], typed);
      if (!user) {
        trace('no account matches the address typed — no link sent');
        return ok('no_account');
      }
      // A disabled worker must not be re-credentialled (login would refuse them
      // anyway) — but they're told to ring the office, not that they're disabled.
      if (isDisabledUser(user)) {
        trace('account is disabled — no link sent');
        return ok('unavailable');
      }
      const to = String(user.email || user.username || '').trim();
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        trace('account has no email on file — nowhere to send the link');
        await writeAudit('auth.pin_reset_requested', user,
          `Reset link requested for ${user.username || user.id} — no email on file`,
          { delivered: false, outcome: 'no_email_on_file', viaIp: ip || null });
        return ok('unavailable');
      }
      if (!isEmailConfigured()) {
        console.error('pin-reset: email provider not configured — no link sent');
        return ok('unavailable');
      }

      const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
      const tokenHash = await bcrypt.hash(token, 10);
      const blob = await readBlob(RESETS_KEY, { resets: [] });
      const resets = prune(blob.resets || [], nowMs);
      // Only the newest link works.
      for (const r of resets) {
        if (r && r.userId === user.id && r.status === 'pending') r.status = 'superseded';
      }
      resets.push({
        id: newId(),
        userId: user.id,
        tokenHash,
        status: 'pending',
        createdAt: nowIso(),
        expiresAt: new Date(nowMs + TTL_MINUTES * 60 * 1000).toISOString(),
        usedAt: null,
        requestedIp: ip || null,
      });
      await writeBlob(RESETS_KEY, { resets });

      const link = `${baseUrl(req)}/reset/${encodeURIComponent(token)}`;
      const sent = await sendTemplate('pinReset', {
        to,
        firstName: String(user.name || user.username || '').trim().split(/\s+/)[0] || 'mate',
        ctaUrl: link,
        expiresText: `This link expires in ${TTL_MINUTES} minutes`,
        adminName: 'The office',
        companyName: companyName(),
        adminPhone: process.env.OFFICE_PHONE || '',
        isPassword: isPasswordRole(user.role),
      });
      const delivered = Boolean(sent && sent.ok !== false);
      if (!delivered) {
        console.error('pin-reset: send failed', sent.reason || sent.error || 'unknown');
      } else {
        // Accepted by the provider — which is NOT proof it landed. A bounce or a
        // junk-folder filing happens after this point and never reaches us, so
        // the screen still offers the office phone as the way through.
        trace('link accepted by the email provider');
      }
      await writeAudit('auth.pin_reset_requested', user,
        `Reset link requested for ${user.username || user.id}`,
        { delivered, outcome: delivered ? 'sent' : 'send_failed', viaIp: ip || null });
      return ok('sent');
    } catch (e) {
      // A backend wobble is not "no account" — never say the address is unknown
      // when the truth is that we failed to look.
      console.error('pin-reset request failed', e && e.message);
      return ok('unavailable');
    }
  }

  // ── GET ?action=resolve — public; reveals nothing on a bad token ─────────
  if (req.method === 'GET' && action === 'resolve') {
    const token = String((req.query && req.query.token) || '');
    try {
      const blob = await readBlob(RESETS_KEY, { resets: [] });
      const reset = await findByToken(blob.resets || [], token);
      const state = stateOf(reset, nowMs);
      if (state !== 'valid') return res.status(200).json({ state });
      const usersBlob = await readBlob(USERS_KEY, { users: [] });
      const user = (usersBlob.users || []).find((u) => u && u.id === reset.userId);
      if (!user || isDisabledUser(user)) return res.status(200).json({ state: 'invalid' });
      // Holding a valid link already proves inbox control, so a first name is
      // safe and reassuring. Nothing else about the account is returned.
      return res.status(200).json({
        state: 'valid',
        firstName: String(user.name || user.username || '').trim().split(/\s+/)[0] || null,
        isPassword: isPasswordRole(user.role),
      });
    } catch (e) {
      console.error('pin-reset resolve failed', e && e.message);
      return res.status(200).json({ state: 'invalid' });
    }
  }

  // ── POST ?action=accept — spend the link, set the credential ─────────────
  if (req.method === 'POST' && action === 'accept') {
    const body = req.body || {};
    const token = String(body.token || '');
    const pin = String(body.pin || '');
    const confirmPin = String(body.confirmPin || '');

    const blob = await readBlob(RESETS_KEY, { resets: [] });
    const resets = blob.resets || [];
    const reset = await findByToken(resets, token);
    const state = stateOf(reset, nowMs);
    if (state === 'used') return res.status(409).json({ error: 'That link has already been used. Ask for a new one.' });
    if (state === 'expired') return res.status(410).json({ error: 'That link has expired. Ask for a new one.' });
    if (state !== 'valid') return res.status(404).json({ error: 'That link is not valid. Ask for a new one.' });

    const usersBlob = await readBlob(USERS_KEY, { users: [] });
    const user = (usersBlob.users || []).find((u) => u && u.id === reset.userId);
    if (!user || isDisabledUser(user)) {
      return res.status(404).json({ error: 'That link is not valid. Ask for a new one.' });
    }

    // Validate BEFORE touching any record, so a bad PIN never spends the link.
    const err = validateSecret(user.role, pin);
    if (err) return res.status(400).json({ error: err });
    if (pin !== confirmPin) return res.status(400).json({ error: "Those don't match" });

    // In place: same account id — assigned jobs and hours history untouched.
    user.passwordHash = await bcrypt.hash(pin, 10);
    await writeBlob(USERS_KEY, usersBlob);

    reset.status = 'used';
    reset.usedAt = nowIso();
    await writeBlob(RESETS_KEY, { resets: prune(resets, nowMs) });

    await writeAudit('auth.pin_reset_completed', user,
      `${user.username || user.id} set a new ${isPasswordRole(user.role) ? 'password' : 'PIN'} from an emailed link`,
      { viaEmailLink: true });

    // The username is returned so the sign-in screen can prefill it. No session
    // is created — they sign in with the new credential, which proves it works.
    return res.status(200).json({ ok: true, username: user.username || null });
  }

  return res.status(404).json({ error: 'unknown action' });
};
