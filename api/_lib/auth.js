// Auth helpers: session cookies + role/job permission checks.
const crypto = require('crypto');
const cookie = require('cookie');
const { readBlob } = require('./blob');
const { getCookieDomain } = require('./domains');

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

// Cookie options shared between set + clear so they always match —
// browsers will only delete a cookie whose path/domain match the
// original Set-Cookie. The optional BUHLOS_COOKIE_DOMAIN env var lets
// the session be scoped to .buhlos.com so a login on buhlos.com is
// honoured at phil.buhlos.com (and vice versa). It is intentionally
// undefined by default so the cookie stays host-only on localhost and
// preview deployments.
function cookieOptions(extra) {
  const domain = getCookieDomain();
  const opts = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    ...extra,
  };
  if (domain) opts.domain = domain;
  return opts;
}

function setSessionCookie(res, payload) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const token = signSession({ ...payload, exp });
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE, token, cookieOptions({
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  })));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE, '', cookieOptions({
    maxAge: 0,
  })));
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
  // strip hash before returning
  const { passwordHash, ...safe } = user;
  return safe;
}

// Middleware-style: returns user or sends error and returns null.
// opts: { roles: ['admin','tradie','client'], jobId: 'xxx' }
async function requireAuth(req, res, opts = {}) {
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: 'not authenticated' });
    return null;
  }
  if (opts.roles && !opts.roles.includes(user.role)) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  if (opts.jobId) {
    const hasAccess =
      user.role === 'admin' ||
      (user.assignedJobIds || []).includes(opts.jobId);
    if (!hasAccess) {
      res.status(403).json({ error: 'no access to job' });
      return null;
    }
  }
  return user;
}

// Check if a user can WRITE to a job (clients can't)
function canWrite(user, jobId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'tradie' || user.role === 'leadingHand') {
    return (user.assignedJobIds || []).includes(jobId);
  }
  return false; // client is read-only
}

// Check if a user can MANAGE a job (edit setup, crew, client).
// Admin can manage any job; leadingHand only their assigned jobs.
function canManageJob(user, jobId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'leadingHand') return (user.assignedJobIds || []).includes(jobId);
  return false;
}

module.exports = {
  SESSION_COOKIE,
  signSession,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  getCurrentUser,
  requireAuth,
  canWrite,
  canManageJob,
};
