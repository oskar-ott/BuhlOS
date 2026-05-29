// Worker invite resolution + acceptance (Pass O3).
//
// The bridge from O1/O2 (admin creates employee → invite link exists) to a
// real Phil login: worker opens the link → confirms details → creates a
// 4-digit PIN → account is activated → lands in Phil.
//
// Source of truth: "BuhlOS Phil Onboarding Interface Bible.html" §06 (Phil
// screens P1/P4/P5/P6), §08 (state), §10 (security). Storage follows the
// existing Vercel-Blob convention; the worker account is created in the
// production users.json using the SAME bcrypt(passwordHash) convention as
// api/users.js / api/auth.js — the PIN is the worker's login credential.
//
// PUBLIC endpoints (no session needed — the worker has no account yet). The
// token in the URL is the worker's proof of identity; everything is validated
// server-side before any data is returned or any account is created.
//
//   GET  /api/invites?action=resolve&token=…  → { state, invite? } (safe payload)
//   POST /api/invites?action=accept           → { ok, landing, sessionCreated }
//
// SECURITY (bible §10):
//   · tokenHash never returned; raw token never stored/logged/audited.
//   · PIN never logged/returned; stored only as bcrypt hash.
//   · invite is single-use — accept flips status to `accepted`; re-accept fails.
//   · expired / revoked / accepted invites cannot create an account.
//   · no duplicate account: an existing user for the email blocks creation.
//   · api/_lib/auth.js (session signing) is required, never edited.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { setSessionCookie } = require('./_lib/auth');
const audit = require('./_lib/audit-log');

const EMPLOYEES_KEY = 'employees.json';
const INVITES_KEY = 'invites.json';
const COMPANY_NAME = process.env.EMAIL_COMPANY_NAME || 'bühl electrical';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLE_DISPLAY = {
  admin: 'Admin / Owner', pm: 'Project manager', office: 'Office', estimator: 'Estimator',
  leadinghand: 'Leading hand', electrician: 'Electrician', apprentice: 'Apprentice', labourer: 'Labourer',
};
function roleLabel(role) { return ROLE_DISPLAY[role] || 'Worker'; }

// Mirror of src/domains/employees/service.ts#isCommonPin — keep in sync.
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
function newUserId() { return 'u_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

function isExpired(invite, nowMs) {
  if (invite.status === 'accepted' || invite.status === 'revoked') return false;
  const exp = Date.parse(invite.expiresAt);
  return Number.isFinite(exp) && exp < nowMs;
}

// Mirror of src/domains/employees/service.ts#resolveInviteState — keep in sync.
function resolveState(invite, employee, nowMs) {
  if (!invite) return 'invalid';
  if (employee && employee.status === 'disabled') return 'invalid';
  let status = invite.status;
  if ((status === 'sent' || status === 'opened') && isExpired(invite, nowMs)) status = 'expired';
  switch (status) {
    case 'accepted': return 'accepted';
    case 'revoked': return 'revoked';
    case 'expired': return 'expired';
    case 'sent': case 'opened': case 'failed': return 'valid';
    default: return 'invalid';
  }
}

// Where the worker lands after accept. Field/LH → Phil; office tiers → login.
function landingFor(appAccess) {
  if (appAccess === 'phil' || appAccess === 'both') return '/phil/my-day';
  return '/v2/login';
}

// Find the invite whose bcrypt tokenHash matches the plaintext token. O(n)
// scan over invites — fine at this scale (bible accepts bcrypt + scan).
async function findInviteByToken(invites, token) {
  if (!token || typeof token !== 'string') return null;
  for (const inv of invites) {
    if (!inv.tokenHash) continue;
    try {
      if (await bcrypt.compare(token, inv.tokenHash)) return inv;
    } catch { /* malformed hash — skip */ }
  }
  return null;
}

function jobNames(jobsBlob, ids) {
  const byId = {};
  for (const j of (jobsBlob.jobs || [])) byId[j.id] = j.name || j.ref || j.id;
  return (ids || []).map((id) => byId[id]).filter(Boolean);
}

async function writeAudit(actorId, action, targetType, targetId, summary, metadata) {
  try {
    await audit.append({
      action, actorId: actorId || 'worker', actorName: 'worker', actorRole: null,
      targetType, targetId, summary, metadata: metadata || undefined,
    });
  } catch (e) {
    console.error('invite audit append failed', action, e && e.message);
  }
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || '';

  // ── GET ?action=resolve ──────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'resolve') {
    const token = (req.query && req.query.token) || '';
    const [invBlob, empBlob] = await Promise.all([
      readBlob(INVITES_KEY, { invites: [] }),
      readBlob(EMPLOYEES_KEY, { employees: [] }),
    ]);
    const invite = await findInviteByToken(invBlob.invites || [], token);
    if (!invite) return res.status(200).json({ state: 'invalid', invite: null });
    const employee = (empBlob.employees || []).find((e) => e.id === invite.employeeId);
    const now = Date.now();
    const state = resolveState(invite, employee, now);
    if (state !== 'valid' || !employee) {
      return res.status(200).json({ state: state === 'valid' ? 'invalid' : state, invite: null });
    }

    // First valid open → stamp openedAt + flip sent→opened (single write).
    let changed = false;
    if (!invite.openedAt) { invite.openedAt = nowIso(); changed = true; }
    if (invite.status === 'sent') { invite.status = 'opened'; changed = true; }
    if (changed) {
      await writeBlob(INVITES_KEY, invBlob);
      await writeAudit(employee.createdBy, 'invite.opened', 'invite', invite.id,
        `Invite opened by ${employee.firstName}`, { employeeId: employee.id });
    }

    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    // SAFE projection only — no tokenHash, no ids, no other employees.
    return res.status(200).json({
      state: 'valid',
      invite: {
        firstName: employee.firstName,
        lastName: employee.lastName,
        displayName: employee.displayName || null,
        email: employee.email,
        phone: employee.phone || null,
        role: employee.role,
        roleLabel: roleLabel(employee.role),
        appAccess: employee.appAccess,
        apprenticeYear: employee.apprenticeYear || null,
        companyName: COMPANY_NAME,
        expiresAt: invite.expiresAt,
        jobs: jobNames(jobsBlob, employee.assignedJobIds),
      },
    });
  }

  // ── POST ?action=accept ──────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'accept') {
    const body = req.body || {};
    const token = body.token || '';
    const pin = String(body.pin || '');
    const confirmPin = String(body.confirmPin || '');

    // Validate the PIN before touching any record (never log it).
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    if (pin !== confirmPin) return res.status(400).json({ error: "Those PINs don't match" });
    if (isCommonPin(pin)) return res.status(400).json({ error: 'Pick a PIN that\'s less easy to guess' });

    const invBlob = await readBlob(INVITES_KEY, { invites: [] });
    invBlob.invites = invBlob.invites || [];
    const empBlob = await readBlob(EMPLOYEES_KEY, { employees: [] });
    empBlob.employees = empBlob.employees || [];

    const invite = await findInviteByToken(invBlob.invites, token);
    if (!invite) return res.status(404).json({ error: 'This invite link is not valid.' });
    const employee = (empBlob.employees || []).find((e) => e.id === invite.employeeId);
    const now = Date.now();
    const state = resolveState(invite, employee, now);
    if (state === 'accepted') return res.status(409).json({ error: 'This invite has already been used. Sign in instead.' });
    if (state === 'revoked') return res.status(409).json({ error: 'This invite was revoked. Ask your supervisor for a new link.' });
    if (state === 'expired') return res.status(410).json({ error: 'This invite has expired. Ask your supervisor for a new link.' });
    if (state !== 'valid' || !employee) return res.status(400).json({ error: 'This invite link is not valid.' });

    // No duplicate accounts: an existing user for this email blocks creation
    // (prevents invite-driven takeover of an existing login).
    const usersBlob = await readBlob('users.json', { users: [] });
    usersBlob.users = usersBlob.users || [];
    const emailLc = String(employee.email || '').toLowerCase();
    if (emailLc && usersBlob.users.find((u) => (u.email || '').toLowerCase() === emailLc || (u.username || '').toLowerCase() === emailLc)) {
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
    }

    // Optional phone fill-in (AU mobile) when missing.
    if (body.phone && !employee.phone) {
      const digits = String(body.phone).replace(/[\s()\-.]/g, '');
      let national = null;
      if (/^\+61\d{9}$/.test(digits)) national = '0' + digits.slice(3);
      else if (/^61\d{9}$/.test(digits)) national = '0' + digits.slice(2);
      else if (/^0\d{9}$/.test(digits)) national = digits;
      if (national && /^04\d{8}$/.test(national)) employee.phone = '+61' + national.slice(1);
    }

    // Create the worker login (bcrypt PIN hash; username = email so the worker
    // signs in with email + PIN). Same convention as api/users.js.
    const passwordHash = await bcrypt.hash(pin, 10);
    const user = {
      id: newUserId(),
      username: emailLc,
      role: employee.role,
      passwordHash,
      email: employee.email,
      assignedJobIds: Array.isArray(employee.assignedJobIds) ? employee.assignedJobIds : [],
      createdAt: nowIso(),
      createdVia: 'invite',
    };
    usersBlob.users.push(user);
    await writeBlob('users.json', usersBlob);

    // Activate the employee + complete setup.
    const ts = nowIso();
    employee.status = 'active';
    employee.userId = user.id;
    employee.lastActiveAt = ts;
    employee.setup = { detailsConfirmed: true, loginCreated: true, introSeen: true, setupCompleteAt: ts };
    await writeBlob(EMPLOYEES_KEY, empBlob);

    // Mark the invite accepted — single-use (re-accept now returns 409).
    invite.status = 'accepted';
    invite.acceptedAt = ts;
    if (!invite.openedAt) invite.openedAt = ts;
    await writeBlob(INVITES_KEY, invBlob);

    // Audit — metadata only, never token/PIN.
    await writeAudit(user.id, 'invite.accepted', 'invite', invite.id,
      `Invite accepted by ${employee.firstName} ${employee.lastName}`, { email: employee.email });
    await writeAudit(user.id, 'employee.activated', 'employee', employee.id,
      `${employee.firstName} ${employee.lastName} activated (${employee.role})`, { role: employee.role });

    // Auto-session using the existing signer (api/_lib/auth.js untouched), so
    // the worker lands in Phil already signed in.
    setSessionCookie(res, { userId: user.id, role: user.role });
    return res.status(200).json({
      ok: true,
      landing: landingFor(employee.appAccess),
      sessionCreated: true,
    });
  }

  return res.status(404).json({ error: 'unknown action' });
};
