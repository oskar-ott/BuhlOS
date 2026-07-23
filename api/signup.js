// Crew sign-up link — PUBLIC worker self-signup (build-first slice).
//
// The boss doesn't have every worker's email, so instead of one invite per
// person (api/invites.js, O2/O3) they generate ONE shareable link and drop it
// in the crew group chat: buhlos.com/onboarding/<code>. Anyone who opens it
// while the link is live can submit their details + a PIN. Because the link
// is deliberately shareable, a submission is NOT an account — it lands as a
// pending request that an admin approves on /employees (the approval gate is
// the security boundary). Approval creates the employee + login and sends the
// welcome email; see api/employees.js ?action=signup-approve.
//
// PUBLIC endpoints (no session — the worker has no account yet):
//   GET  /api/signup?action=resolve&code=…  → { state, link? }  (safe payload)
//   POST /api/signup?action=submit          → { ok, state: 'pending' }
//
// SECURITY:
//   · Whole surface is dark behind the `signup_link` flag (404 when off).
//   · The link code is stored PLAINTEXT in signup-links.json — unlike the
//     per-worker invite tokenHash — because the admin must be able to re-copy
//     the standing link, and possession of the code grants nothing but the
//     right to SUBMIT a pending request. Expiry + pause/revoke + cap + the
//     admin approval gate bound the blast radius.
//   · The PIN is bcrypt-hashed at submit and only the hash is stored; the
//     login is created from that hash at approval. PIN is never logged.
//   · Only FIELD roles can be requested from a public link — never admin or
//     office tiers.
//   · Duplicate email vs users/employees/pending requests → friendly 409.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { isFlagOn } = require('./_lib/feature-flags');
const audit = require('./_lib/audit-log');

const LINKS_KEY = 'signup-links.json';
const REQUESTS_KEY = 'signup-requests.json';
const COMPANY_NAME = process.env.EMAIL_COMPANY_NAME || 'bühl electrical';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The only roles a stranger with the group-chat link may request. Office
// tiers are added by an admin in the register, never via public signup.
const FIELD_ROLES = ['leadinghand', 'electrician', 'apprentice', 'labourer'];

// Mirror of api/invites.js#isCommonPin / employees service — keep in sync.
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

function nowIso() { return new Date().toISOString(); }
function newId(prefix) { return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }

// Mirror of src/domains/employees/signup.ts#resolveLinkState — keep in sync.
function resolveLinkState(link, pendingOrApprovedCount, nowMs) {
  if (!link) return 'invalid';
  if (link.status === 'revoked') return 'revoked';
  if (link.status === 'paused') return 'paused';
  const exp = Date.parse(link.expiresAt);
  if (Number.isFinite(exp) && exp < nowMs) return 'expired';
  if (link.cap != null && pendingOrApprovedCount >= link.cap) return 'capped';
  return 'valid';
}

function countTowardCap(requests, linkId) {
  return (requests || []).filter((r) => r.linkId === linkId && r.status !== 'rejected').length;
}

// AU mobile → +61 normal form; returns null if it isn't one.
function normaliseMobile(raw) {
  const digits = String(raw || '').replace(/[\s()\-.]/g, '');
  let national = null;
  if (/^\+61\d{9}$/.test(digits)) national = '0' + digits.slice(3);
  else if (/^61\d{9}$/.test(digits)) national = '0' + digits.slice(2);
  else if (/^0\d{9}$/.test(digits)) national = digits;
  if (national && /^04\d{8}$/.test(national)) return '+61' + national.slice(1);
  return null;
}

// DOB sanity: real date, 14–100 years old. Not a legal check — a typo net.
function isPlausibleDob(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const age = (Date.now() - t) / (365.25 * 24 * 3600 * 1000);
  return age >= 14 && age <= 100;
}

async function writeAudit(action, targetId, summary, metadata) {
  try {
    await audit.append({
      action, actorId: 'worker', actorName: 'worker', actorRole: null,
      targetType: 'signup', targetId, summary, metadata: metadata || undefined,
    });
  } catch (e) {
    console.error('signup audit append failed', action, e && e.message);
  }
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!(await isFlagOn('signup_link'))) return res.status(404).json({ error: 'not found' });

  const action = (req.query && req.query.action) || '';

  // ── GET ?action=resolve ──────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'resolve') {
    const code = String((req.query && req.query.code) || '');
    const [linksBlob, reqBlob] = await Promise.all([
      readBlob(LINKS_KEY, { links: [] }),
      readBlob(REQUESTS_KEY, { requests: [] }),
    ]);
    const link = (linksBlob.links || []).find((l) => l.code === code);
    const state = resolveLinkState(link, link ? countTowardCap(reqBlob.requests, link.id) : 0, Date.now());
    if (state !== 'valid') return res.status(200).json({ state, link: null });
    // SAFE projection — no code echo, no counters, no other workers.
    return res.status(200).json({
      state: 'valid',
      link: {
        companyName: COMPANY_NAME,
        createdByName: link.createdByName || null,
        expiresAt: link.expiresAt,
      },
    });
  }

  // ── POST ?action=submit ──────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'submit') {
    const body = req.body || {};
    const code = String(body.code || '');

    const firstName = String(body.firstName || '').trim();
    const lastName = String(body.lastName || '').trim();
    const preferredName = body.preferredName ? String(body.preferredName).trim() : null;
    const email = String(body.email || '').trim();
    const role = String(body.role || '').toLowerCase();
    const legalName = String(body.legalName || '').trim();
    const dob = String(body.dob || '').trim();
    const startDate = body.startDate ? String(body.startDate).trim() : null;
    const pin = String(body.pin || '');
    const confirmPin = String(body.confirmPin || '');

    // Validate everything BEFORE reading stores (never log the PIN).
    if (!firstName || !lastName) return res.status(400).json({ error: 'First and last name required.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email doesn\'t look right.' });
    const mobile = normaliseMobile(body.mobile);
    if (!mobile) return res.status(400).json({ error: 'That doesn\'t look like an Australian mobile (04…).' });
    if (!FIELD_ROLES.includes(role)) return res.status(400).json({ error: 'Pick your role.' });
    const apprenticeYear = role === 'apprentice' ? Number(body.apprenticeYear) : null;
    if (role === 'apprentice' && !(apprenticeYear >= 1 && apprenticeYear <= 4)) {
      return res.status(400).json({ error: 'Which year of your apprenticeship (1–4)?' });
    }
    if (!legalName) return res.status(400).json({ error: 'Your full legal name is needed for payroll.' });
    if (!isPlausibleDob(dob)) return res.status(400).json({ error: 'That date of birth doesn\'t look right.' });
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return res.status(400).json({ error: 'Start date doesn\'t look right.' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    if (pin !== confirmPin) return res.status(400).json({ error: "Those PINs don't match" });
    if (isCommonPin(pin)) return res.status(400).json({ error: 'Pick a PIN that\'s less easy to guess' });

    const [linksBlob, reqBlob] = await Promise.all([
      readBlob(LINKS_KEY, { links: [] }),
      readBlob(REQUESTS_KEY, { requests: [] }),
    ]);
    reqBlob.requests = reqBlob.requests || [];
    const link = (linksBlob.links || []).find((l) => l.code === code);
    const state = resolveLinkState(link, link ? countTowardCap(reqBlob.requests, link.id) : 0, Date.now());
    if (state === 'expired') return res.status(410).json({ error: 'This link has expired. Ask the office for a fresh one.' });
    if (state === 'paused') return res.status(409).json({ error: 'Sign-ups are paused right now. Check with the office.' });
    if (state === 'capped') return res.status(409).json({ error: 'This link has hit its sign-up limit. Check with the office.' });
    if (state !== 'valid') return res.status(404).json({ error: 'This sign-up link is not valid.' });

    // Friendly duplicate handling: existing login, existing employee, or an
    // already-pending request for the same email.
    const emailLc = email.toLowerCase();
    const [usersBlob, empBlob] = await Promise.all([
      readBlob('users.json', { users: [] }),
      readBlob('employees.json', { employees: [] }),
    ]);
    if ((usersBlob.users || []).find((u) => (u.email || '').toLowerCase() === emailLc || (u.username || '').toLowerCase() === emailLc)) {
      return res.status(409).json({ error: 'Looks like you\'re already set up — sign in instead.', reason: 'existing_account' });
    }
    if ((empBlob.employees || []).find((e) => (e.email || '').toLowerCase() === emailLc)) {
      return res.status(409).json({ error: 'The office already has you in the register — ask them for your invite link.', reason: 'existing_employee' });
    }
    if (reqBlob.requests.find((r) => r.status === 'pending' && r.email.toLowerCase() === emailLc)) {
      return res.status(409).json({ error: 'You\'ve already signed up — the office just needs to approve it.', reason: 'already_pending' });
    }

    const pinHash = await bcrypt.hash(pin, 10);
    const request = {
      id: newId('sr_'),
      linkId: link.id,
      status: 'pending',
      firstName,
      lastName,
      preferredName,
      email,
      mobile,
      role,
      apprenticeYear,
      legalName,
      dob,
      startDate,
      pinHash,
      submittedAt: nowIso(),
      reviewedAt: null,
      reviewedBy: null,
      rejectReason: null,
    };
    reqBlob.requests.push(request);
    await writeBlob(REQUESTS_KEY, reqBlob);

    await writeAudit('signup.submitted', request.id,
      `${firstName} ${lastName} signed up via crew link (${role})`,
      { email, role, linkId: link.id });

    return res.status(200).json({ ok: true, state: 'pending' });
  }

  return res.status(404).json({ error: 'unknown action' });
};
