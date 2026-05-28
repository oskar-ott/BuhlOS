// Employee-onboarding API (Pass O1).
//
// Source of truth for behaviour: "BuhlOS Phil Onboarding Interface Bible.html"
// §05 (admin screens), §08 (state model), §10 (security). Storage follows the
// existing Vercel-Blob convention (api/_lib/blob.js):
//
//   employees.json  { employees: [...] }   — onboarding employee records
//   invites.json    { invites:   [...] }   — invite records (tokenHash only)
//
// These are NEW blobs. The production users.json login store is read (to show
// the current team in the register) but only written on ?action=disable for an
// existing user — onboarding employees never enter users.json until they
// complete setup (O3), so /login is never at risk.
//
// SECURITY (bible §10):
//   · Invite tokens are 32-byte URL-safe, generated server-side here.
//   · Only the bcrypt hash (tokenHash) is stored. The plaintext token is
//     returned exactly once, in the create/invite response, for the admin
//     copy-link. It is never persisted and never logged.
//   · Admin actions are audited (best-effort) via api/_lib/audit-log.js.
//
// Endpoints (all gated to the admin surface — isAdminRole):
//   GET    /api/employees                         → register list
//   GET    /api/employees?id=<id>                 → one employee + invite
//   POST   /api/employees                         → create (+ optional invite)
//   PATCH  /api/employees?id=<id>                 → update role/details/jobs/gear
//   POST   /api/employees?action=invite&id=<id>   → issue / re-issue invite link
//   POST   /api/employees?action=revoke&id=<id>   → revoke invite (token dead)
//   POST   /api/employees?action=disable&id=<id>  → soft-disable (reversible)

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser, isAdminRole } = require('./_lib/auth');
const audit = require('./_lib/audit-log');
const email = require('./_lib/email');

const EMPLOYEES_KEY = 'employees.json';
const INVITES_KEY = 'invites.json';
const TOKEN_BYTES = 32;
const DEFAULT_EXPIRY_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Resend rate limit (bible A8 / §10). Mirror of recentResendCount in
// src/domains/employees/service.ts — keep both in sync.
const RESEND_MAX_PER_WINDOW = 3;
const RESEND_WINDOW_MS = 60 * 60 * 1000;

// Plain-language role word for the invite email body ("added you as a …").
const ROLE_LABEL = {
  admin: 'admin', pm: 'project manager', office: 'office staff', estimator: 'estimator',
  leadinghand: 'leading hand', electrician: 'electrician', apprentice: 'apprentice', labourer: 'labourer',
};
function roleLabel(role) { return ROLE_LABEL[role] || 'worker'; }

function recentResendCount(timestamps, nowMs) {
  if (!Array.isArray(timestamps)) return 0;
  const cutoff = nowMs - RESEND_WINDOW_MS;
  return timestamps.filter((t) => { const ms = Date.parse(t); return Number.isFinite(ms) && ms > cutoff; }).length;
}

// Canonical base for invite CTA links: APP_BASE_URL, else derived from the
// request host (so previews/prod each build their own absolute link).
function baseUrl(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'buhlos.com';
  return `${proto}://${host}`;
}

function expiresText(iso) {
  try {
    const d = new Date(iso);
    return `This invite expires ${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  } catch { return 'This invite expires in 14 days'; }
}

// Apply lazy expiry (no cron) — flips a stale sent/opened invite to expired.
// Returns true if it changed (caller persists on mutations; GET applies it
// in-memory for display only). Mirrors effectiveInviteStatus in service.ts.
function applyLazyExpiry(invite, nowMs) {
  if (!invite) return false;
  if ((invite.status === 'sent' || invite.status === 'opened')) {
    const exp = Date.parse(invite.expiresAt);
    if (Number.isFinite(exp) && exp < nowMs) { invite.status = 'expired'; return true; }
  }
  return false;
}

const ROLE_APP_ACCESS = {
  admin: 'both', pm: 'buhlos', office: 'buhlos', estimator: 'buhlos',
  leadinghand: 'phil', electrician: 'phil', apprentice: 'phil', labourer: 'phil',
};
const BIBLE_ROLES = Object.keys(ROLE_APP_ACCESS);

function newId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}
function nowIso() { return new Date().toISOString(); }
function deriveAppAccess(role) { return ROLE_APP_ACCESS[role] || 'phil'; }
function computeExpiresAt(fromIso, days) {
  const d = new Date(fromIso); d.setDate(d.getDate() + days); return d.toISOString();
}
// O2 email delivery is merged, but the worker setup route it points to
// (/phil/invite/[token]) only becomes live with O3. Until that route is on
// main, never send a worker an email whose primary CTA lands on a 404.
function inviteSetupRouteLive() { return false; }
function emailConfigured() { return inviteSetupRouteLive() && email.isEmailConfigured(); }

// Map a (possibly coarse legacy) role string onto one of the eight bible roles
// so the register row validates against EmployeeRoleSchema. Returns null for
// clients / unknown roles — those are not employees and are dropped.
function mapLegacyRoleToBible(role) {
  const r = String(role || '').toLowerCase();
  if (BIBLE_ROLES.includes(r)) return r;
  if (['admin', 'boss', 'owner', 'manager'].includes(r)) return 'admin';
  if (['leadinghand', 'leading_hand', 'leading-hand', 'lh'].includes(r)) return 'leadinghand';
  if (r === 'tradie') return 'electrician'; // generic field tradesman
  if (r === 'client') return null;
  return null;
}

function mapUserToEmployee(u) {
  const role = mapLegacyRoleToBible(u.role);
  if (!role) return null;
  const name = String(u.username || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || name || u.id;
  const lastName = parts.slice(1).join(' ');
  return {
    id: u.id,
    firstName,
    lastName,
    displayName: name || null,
    email: u.email || '',
    phone: null,
    role,
    apprenticeYear: null,
    appAccess: deriveAppAccess(role),
    status: u.archived ? 'disabled' : 'active',
    assignedJobIds: Array.isArray(u.assignedJobIds) ? u.assignedJobIds : [],
    assignedGearIds: [],
    notes: null,
    createdAt: u.createdAt || nowIso(),
    createdBy: u.id,
    lastActiveAt: null, // no Phil heartbeat yet — honest null, not a faked time
    disabledAt: u.archivedAt || null,
    userId: u.id,
    source: 'user',
  };
}

// Strip server-only fields before anything goes to the client: the bcrypt
// tokenHash (bible §10 S07) and the resend timestamp log.
function toPublicInvite(invite) {
  if (!invite) return null;
  const { tokenHash, resendTimestamps, ...rest } = invite;
  void tokenHash; void resendTimestamps;
  return rest;
}

function latestInviteFor(invites, employeeId) {
  const matches = (invites.invites || []).filter((i) => i.employeeId === employeeId);
  if (matches.length === 0) return null;
  // Most recently touched wins (sent/revoked/created).
  return matches.slice().sort((a, b) => {
    const ta = Date.parse(a.sentAt || a.revokedAt || a.expiresAt || 0) || 0;
    const tb = Date.parse(b.sentAt || b.revokedAt || b.expiresAt || 0) || 0;
    return tb - ta;
  })[0];
}

function buildRow(employee, invite) {
  return {
    employee,
    invite: toPublicInvite(invite),
    jobsCount: (employee.assignedJobIds || []).length,
    // Gear count reflects gear assigned through onboarding. Live gear-holdings
    // (gear register currentHolderId) are a separate view; surfacing them here
    // would mean enumerating every per-asset blob, deferred past O1.
    gearCount: (employee.assignedGearIds || []).length,
  };
}

async function writeAudit(actor, action, targetType, targetId, summary, metadata) {
  try {
    await audit.append({
      action,
      actorId: actor.id,
      actorName: actor.username || actor.name || actor.id,
      actorRole: actor.role || null,
      targetType,
      targetId,
      summary,
      metadata: metadata || undefined,
    });
  } catch (e) {
    // Best-effort: a journal failure never blocks the parent mutation.
    console.error('employee audit append failed', action, e && e.message);
  }
}

// Audit an invite issue/resend, or a provider send failure — metadata only,
// never the token. `delivery` is the result from deliverInvite().
async function auditInvite(actor, employee, invite, delivery) {
  if (delivery && delivery.mode === 'email' && delivery.sent === false) {
    await writeAudit(actor, 'invite.send_failed', 'invite', invite.id,
      `Invite email failed for ${employee.email}`,
      { email: employee.email, providerConfigured: true, reason: delivery.reason, resentCount: invite.resentCount });
  } else {
    await writeAudit(actor, 'invite.issued', 'invite', invite.id,
      `Invite issued for ${employee.email}`,
      { email: employee.email, providerConfigured: emailConfigured(), delivery: invite.delivery, resentCount: invite.resentCount });
  }
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'forbidden' });

  const action = (req.query && req.query.action) || '';
  const id = (req.query && req.query.id) || (req.body && req.body.id) || '';

  // ── GET: list (no id) or detail (id) ────────────────────────────────────
  if (req.method === 'GET') {
    const [usersBlob, empBlob, invBlob] = await Promise.all([
      readBlob('users.json', { users: [] }),
      readBlob(EMPLOYEES_KEY, { employees: [] }),
      readBlob(INVITES_KEY, { invites: [] }),
    ]);

    const now = Date.now();
    if (id) {
      const row = resolveRow(id, usersBlob, empBlob, invBlob);
      if (!row) return res.status(404).json({ error: 'employee not found' });
      // Lazy expiry for display only — GET never writes.
      if (row.invite) applyLazyExpiry(row.invite, now);
      return res.status(200).json({ row, emailConfigured: emailConfigured() });
    }

    const fromUsers = (usersBlob.users || [])
      .map(mapUserToEmployee)
      .filter(Boolean);
    const fromOnboarding = (empBlob.employees || []);
    const rows = [...fromUsers, ...fromOnboarding].map((e) => {
      const invite = latestInviteFor(invBlob, e.id);
      if (invite) applyLazyExpiry(invite, now); // display-only; not persisted
      return buildRow(e, invite);
    });
    return res.status(200).json({ employees: rows, emailConfigured: emailConfigured() });
  }

  // For all mutations below we read the onboarding stores fresh.
  const empBlob = await readBlob(EMPLOYEES_KEY, { employees: [] });
  empBlob.employees = empBlob.employees || [];
  const invBlob = await readBlob(INVITES_KEY, { invites: [] });
  invBlob.invites = invBlob.invites || [];

  // ── POST create ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && !action) {
    const body = req.body || {};
    const firstName = String(body.firstName || '').trim();
    const lastName = String(body.lastName || '').trim();
    const email = String(body.email || '').trim();
    const role = String(body.role || '').toLowerCase();

    if (!firstName || !lastName) return res.status(400).json({ error: 'first and last name required' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email' });
    if (!BIBLE_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (role === 'apprentice' && !(body.apprenticeYear >= 1 && body.apprenticeYear <= 4)) {
      return res.status(400).json({ error: 'apprentice year (1–4) is required for apprentices' });
    }

    // Duplicate-email block across BOTH onboarding employees and existing
    // users (bible A2 / §11 — block with a link to the existing record).
    const usersBlob = await readBlob('users.json', { users: [] });
    const dupOnboard = empBlob.employees.find((e) => e.email.toLowerCase() === email.toLowerCase());
    if (dupOnboard) {
      return res.status(409).json({ error: 'An employee with this email already exists.', existingEmployeeId: dupOnboard.id });
    }
    const dupUser = (usersBlob.users || []).find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (dupUser) {
      return res.status(409).json({ error: 'A user with this email already exists.', existingEmployeeId: dupUser.id });
    }

    const phone = body.phone ? String(body.phone).trim() : null;
    const now = nowIso();
    const employee = {
      id: newId('e_'),
      firstName,
      lastName,
      displayName: body.displayName ? String(body.displayName).trim() : null,
      email,
      phone,
      role,
      apprenticeYear: role === 'apprentice' ? Number(body.apprenticeYear) : null,
      appAccess: deriveAppAccess(role),
      status: 'draft',
      assignedJobIds: Array.isArray(body.assignedJobIds) ? body.assignedJobIds.map(String) : [],
      assignedGearIds: Array.isArray(body.assignedGearIds) ? body.assignedGearIds.map(String) : [],
      notes: body.notes ? String(body.notes).trim() : null,
      createdAt: now,
      createdBy: me.id,
      lastActiveAt: null,
      disabledAt: null,
      userId: null,
      source: 'onboarding',
    };
    empBlob.employees.push(employee);

    let issued = null;
    let delivery = null;
    if (body.sendInvite) {
      issued = await issueInvite(employee, invBlob, me, { expiryDays: body.expiryDays });
      delivery = await deliverInvite(employee, issued.invite, issued.kind, issued.link, req, me, {
        inviteNote: body.inviteNote,
      });
    }
    await writeBlob(EMPLOYEES_KEY, empBlob);
    if (issued) await writeBlob(INVITES_KEY, invBlob);

    await writeAudit(me, 'employee.created', 'employee', employee.id,
      `Created employee ${employee.firstName} ${employee.lastName} (${role})`,
      { role, sentInvite: Boolean(issued) });
    if (issued) await auditInvite(me, employee, issued.invite, delivery);

    return res.status(200).json({
      row: buildRow(employee, issued ? issued.invite : null),
      inviteLink: issued ? issued.link : null,
      emailConfigured: emailConfigured(),
    });
  }

  // ── PATCH update ───────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const employee = empBlob.employees.find((e) => e.id === id);
    if (!employee) return res.status(404).json({ error: 'employee not found (onboarding employees only are editable here)' });
    const body = req.body || {};

    if (body.email !== undefined) {
      const email = String(body.email).trim();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email' });
      const dup = empBlob.employees.find((e) => e.id !== id && e.email.toLowerCase() === email.toLowerCase());
      if (dup) return res.status(409).json({ error: 'An employee with this email already exists.', existingEmployeeId: dup.id });
      employee.email = email;
    }
    if (body.firstName !== undefined) employee.firstName = String(body.firstName).trim();
    if (body.lastName !== undefined) employee.lastName = String(body.lastName).trim();
    if (body.displayName !== undefined) employee.displayName = body.displayName ? String(body.displayName).trim() : null;
    if (body.phone !== undefined) employee.phone = body.phone ? String(body.phone).trim() : null;
    if (body.notes !== undefined) employee.notes = body.notes ? String(body.notes).trim() : null;
    if (Array.isArray(body.assignedJobIds)) employee.assignedJobIds = body.assignedJobIds.map(String);
    if (Array.isArray(body.assignedGearIds)) employee.assignedGearIds = body.assignedGearIds.map(String);

    let roleChanged = null;
    if (body.role !== undefined) {
      const role = String(body.role).toLowerCase();
      if (!BIBLE_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
      if (role !== employee.role) roleChanged = { from: employee.role, to: role };
      employee.role = role;
      employee.appAccess = deriveAppAccess(role);
      if (role !== 'apprentice') employee.apprenticeYear = null;
    }
    if (body.apprenticeYear !== undefined && employee.role === 'apprentice') {
      employee.apprenticeYear = Number(body.apprenticeYear) || null;
    }

    await writeBlob(EMPLOYEES_KEY, empBlob);
    if (roleChanged) {
      await writeAudit(me, 'employee.role_changed', 'employee', employee.id,
        `Role changed ${roleChanged.from} → ${roleChanged.to}`, roleChanged);
    } else {
      await writeAudit(me, 'employee.updated', 'employee', employee.id, 'Employee details updated');
    }
    return res.status(200).json({
      row: buildRow(employee, latestInviteFor(invBlob, employee.id)),
      emailConfigured: emailConfigured(),
    });
  }

  // ── POST ?action=invite — issue / re-issue ───────────────────────────────
  if (req.method === 'POST' && action === 'invite') {
    const employee = empBlob.employees.find((e) => e.id === id);
    if (!employee) return res.status(404).json({ error: 'employee not found' });
    if (employee.status === 'disabled') return res.status(409).json({ error: 'employee is disabled' });

    // Rate limit RESENDS (not the first issue): max 3 per hour per employee
    // (bible A8 / §10). The first link for an employee is never rate-limited.
    const existing = invBlob.invites.find((i) => i.employeeId === id);
    if (existing && recentResendCount(existing.resendTimestamps, Date.now()) >= RESEND_MAX_PER_WINDOW) {
      return res.status(429).json({
        error: "You've resent this invite a few times in the last hour. Wait a bit before sending another.",
      });
    }

    const issued = await issueInvite(employee, invBlob, me, {
      expiryDays: (req.body && req.body.expiryDays) || undefined,
    });
    const delivery = await deliverInvite(employee, issued.invite, issued.kind, issued.link, req, me, {
      inviteNote: (req.body && req.body.inviteNote) || null,
    });
    await writeBlob(EMPLOYEES_KEY, empBlob);
    await writeBlob(INVITES_KEY, invBlob);
    await auditInvite(me, employee, issued.invite, delivery);
    return res.status(200).json({
      row: buildRow(employee, issued.invite),
      inviteLink: issued.link,
      emailConfigured: emailConfigured(),
    });
  }

  // ── POST ?action=revoke ──────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'revoke') {
    const employee = empBlob.employees.find((e) => e.id === id);
    if (!employee) return res.status(404).json({ error: 'employee not found' });
    const invite = latestInviteFor(invBlob, id);
    if (!invite) return res.status(404).json({ error: 'no invite to revoke' });
    if (invite.status === 'accepted') return res.status(409).json({ error: 'invite already accepted — disable the employee instead' });
    invite.status = 'revoked';
    invite.revokedAt = nowIso();
    // Token is dead: replace the hash so the old plaintext can never resolve.
    invite.tokenHash = await bcrypt.hash(crypto.randomBytes(TOKEN_BYTES).toString('base64url'), 10);
    if (employee.status === 'invited') employee.status = 'draft';
    await writeBlob(EMPLOYEES_KEY, empBlob);
    await writeBlob(INVITES_KEY, invBlob);
    await writeAudit(me, 'invite.revoked', 'invite', invite.id, `Invite revoked for ${employee.email}`);
    return res.status(200).json({
      row: buildRow(employee, invite),
      emailConfigured: emailConfigured(),
    });
  }

  // ── POST ?action=disable — soft-disable (reversible) ─────────────────────
  if (req.method === 'POST' && action === 'disable') {
    // Onboarding employee?
    const employee = empBlob.employees.find((e) => e.id === id);
    if (employee) {
      employee.status = 'disabled';
      employee.disabledAt = nowIso();
      await writeBlob(EMPLOYEES_KEY, empBlob);
      await writeAudit(me, 'employee.disabled', 'employee', employee.id,
        `Disabled employee ${employee.firstName} ${employee.lastName}`);
      return res.status(200).json({
        row: buildRow(employee, latestInviteFor(invBlob, employee.id)),
        emailConfigured: emailConfigured(),
      });
    }
    // Existing users.json staff — reuse the established soft-archive pattern.
    if (id === me.id) return res.status(400).json({ error: 'cannot disable yourself' });
    const usersBlob = await readBlob('users.json', { users: [] });
    const u = (usersBlob.users || []).find((x) => x.id === id);
    if (!u) return res.status(404).json({ error: 'employee not found' });
    u.archived = true;
    u.archivedAt = nowIso();
    u.archivedBy = me.id;
    await writeBlob('users.json', usersBlob);
    await writeAudit(me, 'employee.disabled', 'employee', u.id, `Disabled user ${u.username}`);
    const mapped = mapUserToEmployee(u);
    return res.status(200).json({ row: buildRow(mapped, null), emailConfigured: emailConfigured() });
  }

  return res.status(405).json({ error: 'method not allowed' });
};

// ── helpers ────────────────────────────────────────────────────────────────

function resolveRow(id, usersBlob, empBlob, invBlob) {
  const onboarding = (empBlob.employees || []).find((e) => e.id === id);
  if (onboarding) return buildRow(onboarding, latestInviteFor(invBlob, id));
  const u = (usersBlob.users || []).find((x) => x.id === id);
  if (u) {
    const mapped = mapUserToEmployee(u);
    if (mapped) return buildRow(mapped, null);
  }
  return null;
}

/**
 * Issue (or re-issue) an invite for an employee. Generates a fresh 32-byte
 * URL-safe token, stores only its bcrypt hash, and returns the plaintext link
 * exactly once. Re-issuing rotates the token (old one dies, bible §10 S06),
 * bumps resentCount, records a resend timestamp (for the 3/hr rate limit), and
 * picks the template kind (resend vs expired-replacement). Mutates the passed
 * blobs in place; the caller persists. NEVER logs the token.
 *
 * Returns { invite, link, token, kind }. `kind` ∈ invite|resend|expiredReplacement.
 */
async function issueInvite(employee, invBlob, actor, opts) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = await bcrypt.hash(token, 10);
  const now = nowIso();
  const expiryDays = Number(opts && opts.expiryDays) || DEFAULT_EXPIRY_DAYS;
  const expiresAt = computeExpiresAt(now, expiryDays);

  let invite = invBlob.invites.find((i) => i.employeeId === employee.id);
  let kind;
  if (invite) {
    // Was the prior invite already past expiry? → E3 replacement, else E2 resend.
    applyLazyExpiry(invite, Date.now());
    kind = invite.status === 'expired' ? 'expiredReplacement' : 'resend';
    invite.resendTimestamps = Array.isArray(invite.resendTimestamps) ? invite.resendTimestamps : [];
    invite.resendTimestamps.push(now);
    invite.tokenHash = tokenHash;
    invite.email = employee.email;
    invite.status = 'sent';
    invite.sentAt = now;
    invite.expiresAt = expiresAt;
    invite.openedAt = null;
    invite.acceptedAt = null;
    invite.revokedAt = null;
    invite.resentCount = (invite.resentCount || 0) + 1;
    invite.delivery = null;
    invite.sendError = null;
  } else {
    kind = 'invite';
    invite = {
      id: newId('i_'),
      employeeId: employee.id,
      email: employee.email,
      tokenHash,
      status: 'sent',
      expiresAt,
      sentAt: now,
      openedAt: null,
      acceptedAt: null,
      revokedAt: null,
      createdBy: actor.id,
      resentCount: 0,
      resendTimestamps: [],
      delivery: null,
      sendError: null,
    };
    invBlob.invites.push(invite);
  }
  employee.status = 'invited';
  // Relative path — the client turns it into an absolute URL with its own
  // origin so the copy-link works regardless of preview/prod host.
  const link = `/phil/invite/${token}`;
  return { invite, link, token, kind };
}

/**
 * Deliver the freshly-issued invite. If a provider is configured, send the
 * matching template (E1/E2/E3) and set delivery=email; on provider failure set
 * the invite to `failed` + a sanitised reason (the copy-link still works as a
 * fallback). If no provider, mark delivery=link (copy-link mode — bible §07).
 * Mutates `invite`. NEVER logs the token or the rendered body.
 *
 * Returns { mode:'email'|'link', sent:boolean, reason?:string }.
 */
async function deliverInvite(employee, invite, kind, link, req, me, opts) {
  if (!emailConfigured()) {
    invite.delivery = 'link';
    return { mode: 'link', sent: false };
  }
  const ctaUrl = `${baseUrl(req)}${link}`;
  const result = await email.sendTemplate(kind, {
    to: employee.email,
    firstName: employee.firstName,
    companyName: email.companyName(),
    roleLabel: roleLabel(employee.role),
    ctaUrl,
    expiresText: expiresText(invite.expiresAt),
    adminName: me.username || me.name || 'your supervisor',
    adminPhone: process.env.EMAIL_REPLY_PHONE || null,
    optionalNote: (opts && opts.inviteNote) || null,
  });
  if (result.ok) {
    invite.delivery = 'email';
    invite.sendError = null;
    return { mode: 'email', sent: true };
  }
  invite.status = 'failed';
  invite.delivery = 'email';
  invite.sendError = result.reason;
  return { mode: 'email', sent: false, reason: result.reason };
}
