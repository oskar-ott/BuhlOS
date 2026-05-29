// Auth helpers: session cookies + role/job permission checks.
const crypto = require('crypto');
const cookie = require('cookie');
const { readBlob } = require('./blob');

const SESSION_COOKIE = 'buhl_session';
const SESSION_DAYS = 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET env var missing or too short');
  return s;
}

// Sign a payload: base64(json).hmac
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  // timing-safe compare
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSessionCookie(res, payload) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const token = signSession({ ...payload, exp });
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  }));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE, '', {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0,
  }));
}

function getSession(req) {
  const header = req.headers.cookie || '';
  const parsed = cookie.parse(header);
  return verifySession(parsed[SESSION_COOKIE]);
}

// Full user lookup (fresh role/assignments from users.json)
async function getCurrentUser(req) {
  const session = getSession(req);
  if (!session) return null;
  const users = await readBlob('users.json', { users: [] });
  const user = users.users.find(u => u.id === session.userId);
  if (!user) return null;
  if (isDisabledUser(user)) return null;
  // strip hash before returning
  const { passwordHash, ...safe } = user;
  return safe;
}

function isDisabledUser(user) {
  return Boolean(user && (user.archived || user.disabled || user.status === 'disabled'));
}

// Role-tier helpers. The canonical taxonomy lives in
// src/lib/auth/roles.ts (TypeScript-only, can't be required from here)
// and in public/login.html landingFor(). Kept in sync with both:
// adding a role here means adding it there too.
//
// Pre-D6 the gates below only matched the bare strings
// 'admin' / 'tradie' / 'leadingHand', which 403'd every user with role
// 'boss' / 'owner' / 'manager' / 'office' / 'pm' / 'estimator'
// (admin-tier) or 'apprentice' / 'labourer' / 'electrician' (field-tier)
// or the lowercase LH variants — even though those roles already had
// admin-shell access via login.html.
//
// normaliseRole lowercases so the legacy camelCase 'leadingHand' and the
// canonical 'leadinghand' (per roles.ts) both resolve.
const ADMIN_ROLES = new Set([
  'admin', 'boss', 'owner', 'manager', 'office', 'pm', 'estimator',
]);
const LEADING_HAND_ROLES = new Set([
  'leadinghand', 'leading_hand', 'leading-hand', 'lh',
]);
const FIELD_ROLES = new Set([
  'tradie', 'apprentice', 'labourer', 'electrician',
]);

function normaliseRole(raw) {
  return String(raw == null ? '' : raw).toLowerCase();
}
function isAdminRole(role) {
  return ADMIN_ROLES.has(normaliseRole(role));
}
function isLeadingHandRole(role) {
  return LEADING_HAND_ROLES.has(normaliseRole(role));
}
function isFieldRole(role) {
  return FIELD_ROLES.has(normaliseRole(role));
}

// "Staff" = anyone on the admin tier OR the leading-hand tier: the people
// who manage jobs, approve hours, triage snags and see team-wide views.
// Field workers and clients are not staff. This is the canonical
// replacement for the inline `['admin', 'leadingHand'].includes(role)`
// literal checks that used to 403 admin-tier roles (boss/owner/office/pm/
// estimator/manager) and the lowercase leading-hand aliases (lh/leadinghand).
function isStaffRole(role) {
  return isAdminRole(role) || isLeadingHandRole(role);
}

// Expand one allowed-role entry passed to requireAuth into the set of
// stored role strings that satisfy it. A gate written `{ roles: ['admin'] }`
// admits the whole admin tier; `{ roles: ['admin', 'leadingHand'] }` also
// admits the lh/leadinghand aliases. Unknown entries (e.g. 'accounts',
// 'client') match themselves, normalised. Comparison is case-insensitive.
function rolesSatisfying(entry) {
  const r = normaliseRole(entry);
  if (ADMIN_ROLES.has(r)) return ADMIN_ROLES;
  if (LEADING_HAND_ROLES.has(r)) return LEADING_HAND_ROLES;
  if (FIELD_ROLES.has(r)) return FIELD_ROLES;
  return new Set([r]);
}
function roleSatisfies(userRole, allowed) {
  const r = normaliseRole(userRole);
  return allowed.some((entry) => rolesSatisfying(entry).has(r));
}

// Middleware-style: returns user or sends error and returns null.
// opts: { roles: ['admin','tradie','client'], jobId: 'xxx' }
//
// `roles` is matched TIER-AWARE and case-insensitively (see roleSatisfies):
// passing 'admin' admits the admin tier, 'leadingHand' admits every LH
// alias, a field role admits the field tier. This keeps API gates in step
// with the UI's canAccessSurface()/isAdminRole() so a boss/owner/office
// user who reaches an admin surface isn't then 403'd by the API behind it.
// `jobId` access uses the normalised admin-role check so an office/boss
// user reaches per-job endpoints the same way an admin does.
async function requireAuth(req, res, opts = {}) {
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: 'not authenticated' });
    return null;
  }
  if (opts.roles && !roleSatisfies(user.role, opts.roles)) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  if (opts.jobId) {
    const hasAccess =
      isAdminRole(user.role) ||
      (user.assignedJobIds || []).includes(opts.jobId);
    if (!hasAccess) {
      res.status(403).json({ error: 'no access to job' });
      return null;
    }
  }
  return user;
}

// Check if a user can WRITE to a job. Admin-tier writes any job;
// field + LH tiers write jobs they're assigned to; clients are
// read-only.
function canWrite(user, jobId) {
  if (!user) return false;
  if (isAdminRole(user.role)) return true;
  if (isLeadingHandRole(user.role) || isFieldRole(user.role)) {
    return (user.assignedJobIds || []).includes(jobId);
  }
  return false; // client + anything unknown is read-only
}

// Check if a user can MANAGE a job (edit setup, crew, client).
// Admin-tier manages any job; LH manages assigned jobs. Field workers
// and clients cannot manage.
function canManageJob(user, jobId) {
  if (!user) return false;
  if (isAdminRole(user.role)) return true;
  if (isLeadingHandRole(user.role)) return (user.assignedJobIds || []).includes(jobId);
  return false;
}

module.exports = {
  SESSION_COOKIE,
  ADMIN_ROLES,
  LEADING_HAND_ROLES,
  FIELD_ROLES,
  normaliseRole,
  isAdminRole,
  isLeadingHandRole,
  isFieldRole,
  isStaffRole,
  roleSatisfies,
  signSession,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  getCurrentUser,
  isDisabledUser,
  requireAuth,
  canWrite,
  canManageJob,
};
