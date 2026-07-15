// Auth helpers: session cookies + role/job permission checks.
const crypto = require('crypto');
const cookie = require('cookie');
const { readBlob } = require('./blob');

const SESSION_COOKIE = 'buhl_session';
const SESSION_DAYS = 30;

// Reserved id for the env-only platform owner (#760) — a SYNTHETIC principal
// with NO users.json row, so it never appears in the Employees roster, exports,
// or assignment pickers. Helpers + login live in the owner section below; see
// docs/owner-console.md. The leading/trailing underscores keep it clearly out of
// the real-id namespace (nanoid/`u_*`), and a blob-guard forbids any stored row
// from claiming it.
const OWNER_SENTINEL = '__owner__';

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
  // Env-only owner: a synthetic super-admin with NO users.json row. getSession
  // has already HMAC-verified the cookie, so a forged '__owner__' session is
  // impossible without SESSION_SECRET — the same trust anchor as the role claim.
  // Resolve it here WITHOUT touching the blob (there is no row to find).
  if (isOwnerSentinel(session.userId)) return syntheticOwner();
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

// The client role is a single role, not a tier — but checks still go through
// a predicate so the lint/guard sweep (#156) has one spelling to enforce.
// Mirrors src/lib/auth/roles.ts isClientRole.
function isClientRole(role) {
  return normaliseRole(role) === 'client';
}

// ── Owner Console access (docs/owner-console.md) ─────────────────────────
// 'owner' is a NARROWING WITHIN the admin tier (it is also an ADMIN_ROLES
// member): every owner is an admin, but the Owner Console — the product/
// platform-owner control surface — gates to OWNER only, not the whole office
// admin tier. Identity is EITHER the stored 'owner' role OR an email on the
// OWNER_EMAILS allowlist (the env-configurable bootstrap, so the real product
// owner reaches the console before a users.json role is set). Mirrors
// OWNER_ROLES + isOwnerRole in src/lib/auth/roles.ts (keep both in sync).
const OWNER_ROLES = new Set(['owner']);
function isOwnerRole(role) {
  return OWNER_ROLES.has(normaliseRole(role));
}
// The default seeds the product owner so the console is reachable
// out-of-the-box; rotate it via the comma-separated OWNER_EMAILS env var (no
// code change) as ownership changes.
const DEFAULT_OWNER_EMAILS = ['oskaott@gmail.com'];
function ownerEmails() {
  const raw = process.env.OWNER_EMAILS;
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }
  return DEFAULT_OWNER_EMAILS;
}
function ownerEmailAllowed(email) {
  const e = String(email == null ? '' : email).trim().toLowerCase();
  return e !== '' && ownerEmails().includes(e);
}
// The authoritative Owner Console gate. Takes the FULL user (fresh from
// users.json via getCurrentUser) so the email allowlist can be checked — the
// session cookie itself carries only { userId, role }.
function canAccessOwnerConsole(user) {
  if (!user) return false;
  return isOwnerRole(user.role) || ownerEmailAllowed(user.email);
}

// ── Env-only owner login (#760) ──────────────────────────────────────────────
// The platform owner authenticates against ENV credentials and is represented by
// a SYNTHETIC principal (no users.json row) — so it leaves zero trace in the
// admin Employees view. FAIL CLOSED: with no OWNER_PASSWORD_HASH set, owner login
// does not exist (the login branch is skipped). The password NEVER defaults
// (unlike OWNER_EMAILS, which seeds an email for console access).
function isOwnerSentinel(id) {
  return id === OWNER_SENTINEL;
}
function ownerLoginUsername() {
  const raw = process.env.OWNER_LOGIN_USERNAME;
  return raw && String(raw).trim() ? String(raw).trim() : 'owner';
}
// The ENV bcrypt hash of the owner password — the one-time BOOTSTRAP. No default.
// Once the owner changes their password in the console it's stored in the
// owner-auth.json blob (runtime-mutable) and that wins; env stays the fallback.
function ownerPasswordHashEnv() {
  const h = process.env.OWNER_PASSWORD_HASH;
  return h && String(h).trim() ? String(h).trim() : null;
}
// The blob that holds the owner's chosen password hash (set via the console's
// change-password) so the owner can rotate it WITHOUT an env edit + redeploy.
// Single key (single-owner, single-tenant); shared across environments on a
// shared Blob store — documented in docs/owner-console.md.
const OWNER_AUTH_KEY = 'owner-auth.json';
// The EFFECTIVE owner password hash: the blob (if the owner has set one) else the
// env bootstrap. null ⇒ owner login disabled (fail closed). The login + change-
// password paths use this; never reads env when a blob hash exists.
async function resolveOwnerPasswordHash() {
  try {
    const doc = await readBlob(OWNER_AUTH_KEY, {});
    const h = doc && typeof doc.passwordHash === 'string' ? doc.passwordHash.trim() : '';
    if (h) return h;
  } catch {
    // Blob unavailable → fall back to the env bootstrap.
  }
  return ownerPasswordHashEnv();
}
// The synthetic owner returned to the app. role 'owner' ⇒ canAccessOwnerConsole
// is true and the owner-preview flag branch fires; 'owner' ∈ ADMIN_ROLES ⇒ it
// behaves as a full super-admin through requireAuth/canManageJob. email mirrors
// OWNER_EMAILS[0] for console-gate consistency. Carries NO passwordHash.
function syntheticOwner() {
  return {
    id: OWNER_SENTINEL,
    username: ownerLoginUsername(),
    name: 'Owner',
    role: 'owner',
    email: ownerEmails()[0] || null,
    assignedJobIds: [],
  };
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
    // All-jobs access: admin, leading-hand and field roles may access ANY job —
    // job assignment no longer scopes staff visibility (every worker works every
    // job). Clients stay restricted to their own linked jobs.
    const hasAccess =
      isAdminRole(user.role) ||
      isLeadingHandRole(user.role) ||
      isFieldRole(user.role) ||
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
function canWrite(user, _jobId) {
  if (!user) return false;
  if (isAdminRole(user.role)) return true;
  // All-jobs access: field + LH may write ANY job (assignment no longer scopes).
  if (isLeadingHandRole(user.role) || isFieldRole(user.role)) return true;
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

// ── Named capability helpers ─────────────────────────────────────────
// Thin, self-documenting wrappers over the role tiers above so endpoints
// gate by INTENT ("can this role approve hours?") rather than re-deriving
// the tier inline with literal `role === '...'` checks. Mirrors
// src/lib/auth/permissions.ts — keep both in sync. These do NOT replace the
// deliberately-narrow literal-'admin' create gate (canCreateJob / the POST
// /api/jobs check), which is narrower than the admin tier on purpose.

// Jobs — draft + archived jobs are office-only. The admin TIER (boss/owner/
// manager/office/pm/estimator), not just literal 'admin', may view them,
// matching canManageJob's edit rights so a user who can edit a draft can
// also open it.
function canViewDraftJobs(role) { return isAdminRole(role); }
function canViewArchivedJobs(role) { return isAdminRole(role); }

// Hours — field/LH log their own (or on-behalf); staff approve/reject.
function canSubmitHours(role) { return isFieldRole(role) || isLeadingHandRole(role); }
function canApproveHours(role) { return isStaffRole(role); }

// "Expected to log hours" — the missing-hours / payroll-readiness tracking
// tier. This is an EXPECTATION, not a permission: the workers whose days the
// office chases when no entry exists (/api/time-entries-overview missing[],
// the /hours missing card, /hours/weekly readiness, command-centre).
//
//   tracked:     the whole field tier (tradie, electrician, apprentice,
//                labourer) + leading hands in every spelling — the same
//                normalised tiers canSubmitHours uses. Pre-#114 this rule
//                literal-matched 'tradie'/'leadingHand' only, so onboarded
//                electricians/apprentices/labourers AND lowercase
//                'leadinghand' accounts were invisible to missing-hours,
//                silently understating "not payroll-ready" weeks.
//   not tracked: admin/office tier, clients, unknown roles, and any
//                archived/disabled account (an archived tradie is not
//                expected to submit — same liveness rule listTradies uses).
//
// Takes the USER (not just the role) because expectation depends on account
// liveness, not only tier.
function isHoursTrackedWorker(user) {
  if (!user || isDisabledUser(user)) return false;
  return isFieldRole(user.role) || isLeadingHandRole(user.role);
}

// Evidence / gear — office/admin tier reviews + manages.
function canReviewEvidence(role) { return isAdminRole(role); }
function canManageGear(role) { return isAdminRole(role); }
function canViewAssignedGear(role) { return isFieldRole(role) || isLeadingHandRole(role); }

// Plans — manage (upload/edit/publish) = admin tier or LH on the job;
// viewing current plans = any field-safe role.
function canManagePlans(user, jobId) { return canManageJob(user, jobId); }
function canViewCurrentPlans(role) { return isAdminRole(role) || isLeadingHandRole(role) || isFieldRole(role); }

// Plan markups (Plans Phase 2 overlays) — mirror src/lib/auth/permissions.ts.
// Management is job-scoped via canManageJob; these tier helpers gate intent.
function canManagePlanMarkups(role) { return isAdminRole(role) || isLeadingHandRole(role); }
function canViewPlanMarkups(role) { return isAdminRole(role) || isLeadingHandRole(role); }
function canViewPhilPlanMarkups(role) { return isFieldRole(role) || isLeadingHandRole(role); }

module.exports = {
  isClientRole,
  isOwnerRole,
  OWNER_ROLES,
  ownerEmailAllowed,
  canAccessOwnerConsole,
  OWNER_SENTINEL,
  OWNER_AUTH_KEY,
  isOwnerSentinel,
  ownerLoginUsername,
  ownerPasswordHashEnv,
  resolveOwnerPasswordHash,
  syntheticOwner,
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
  canViewDraftJobs,
  canViewArchivedJobs,
  canSubmitHours,
  canApproveHours,
  isHoursTrackedWorker,
  canReviewEvidence,
  canManageGear,
  canViewAssignedGear,
  canManagePlans,
  canViewCurrentPlans,
  canManagePlanMarkups,
  canViewPlanMarkups,
  canViewPhilPlanMarkups,
};
