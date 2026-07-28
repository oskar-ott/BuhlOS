// Crew sign-up link — the ONE account writer.
//
// Turns a signup request row into a real account: employee row (employees.json,
// source 'signup-link') + login row (users.json, username = email, passwordHash
// = the pinHash captured at submit), stamps the request approved and clears its
// pinHash (credentials never linger in the queue), persists all three stores,
// then sends the welcome email best-effort.
//
// Two callers, one writer — the shapes must never diverge:
//   · api/signup.js  POST ?action=submit          — instant access (founder
//     decision 2026-07-28): link possession = account. reviewedBy is the
//     SIGNUP_AUTO_REVIEWER sentinel; the link's own gates (expiry, cap,
//     pause/revoke, field-roles-only, duplicate refusal) are the boundary.
//   · api/employees.js POST ?action=signup-approve — kept for leftover
//     pre-instant pending rows. reviewedBy is the approving admin's id.
//
// Field shapes are frozen as shipped (source 'signup-link', setup stamps,
// createdVia 'signup-link') — the client schema knows these exact values.
// Audit entries stay with the callers (different actors tell different
// stories); this module only writes stores + email.

const crypto = require('crypto');
const { readBlob, writeBlob } = require('./blob');
const email = require('./email');

const EMPLOYEES_KEY = 'employees.json';
const SIGNUP_REQUESTS_KEY = 'signup-requests.json';

// reviewedBy/createdBy sentinel for accounts created straight from the public
// link — no admin in the loop. Distinct shape from any real user id ('u_…')
// so queue history reads honestly.
const SIGNUP_AUTO_REVIEWER = 'signup-link:auto';

// Every role a signup request can carry (electrician/apprentice today;
// labourer/leadinghand in legacy queue rows) is a FIELD tier → appAccess
// 'phil'. Mirror of ROLE_APP_ACCESS in api/employees.js for those roles.
function deriveSignupAppAccess() { return 'phil'; }

function nowIso() { return new Date().toISOString(); }
function newId(prefix) { return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

// Canonical base for the welcome email's login CTA: APP_BASE_URL, else derived
// from the request host. Mirror of baseUrl in api/employees.js.
function baseUrl(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'buhlos.com';
  return `${proto}://${host}`;
}

/**
 * Create the account for a signup request. Mutates `request` in place
 * (status/reviewedAt/reviewedBy/pinHash) and persists `reqBlob` — the caller
 * must have `request` inside `reqBlob.requests`. `reviewedBy` also becomes the
 * employee's createdBy (matches the old approve path, where both were the
 * admin's id). Returns
 *   { ok: true, employee, user, welcomeSent }  on success, or
 *   { ok: false, status, error }               on a duplicate re-check refusal
 * (nothing written in that case — the request row stays as the caller had it).
 */
async function createSignupAccount({ request, reqBlob, reviewedBy, req }) {
  const empBlob = await readBlob(EMPLOYEES_KEY, { employees: [] });
  empBlob.employees = empBlob.employees || [];
  const usersBlob = await readBlob('users.json', { users: [] });
  usersBlob.users = usersBlob.users || [];

  // Duplicate re-check at create time (the world may have changed since submit).
  const emailLc = request.email.toLowerCase();
  if (usersBlob.users.find((u) => (u.email || '').toLowerCase() === emailLc || (u.username || '').toLowerCase() === emailLc)) {
    return { ok: false, status: 409, error: 'An account with this email already exists.' };
  }
  if (empBlob.employees.find((e) => (e.email || '').toLowerCase() === emailLc)) {
    return { ok: false, status: 409, error: 'An employee with this email already exists.' };
  }

  const ts = nowIso();
  const employee = {
    id: newId('e_'),
    firstName: request.firstName,
    lastName: request.lastName,
    displayName: request.preferredName || null,
    email: request.email,
    phone: request.mobile,
    role: request.role,
    // role-literal-ok: signup request's requested TRADE ('apprentice' carries a year), not a session tier
    apprenticeYear: request.role === 'apprentice' ? request.apprenticeYear : null,
    appAccess: deriveSignupAppAccess(),
    status: 'active',
    assignedJobIds: [],
    assignedGearIds: [],
    notes: null,
    // Payroll-match facts for the office's Xero connect step.
    legalName: request.legalName,
    dob: request.dob,
    startDate: request.startDate || null,
    createdAt: ts,
    createdBy: reviewedBy,
    lastActiveAt: null,
    disabledAt: null,
    userId: null,
    source: 'signup-link',
  };

  // Login from the PIN hash captured at submit (same convention as
  // api/invites.js accept: username = email, bcrypt hash).
  const user = {
    id: 'u_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    username: emailLc,
    role: request.role,
    passwordHash: request.pinHash,
    email: request.email,
    assignedJobIds: [],
    createdAt: ts,
    createdVia: 'signup-link',
  };
  usersBlob.users.push(user);
  employee.userId = user.id;
  employee.setup = { detailsConfirmed: true, loginCreated: true, introSeen: false, setupCompleteAt: ts };
  empBlob.employees.push(employee);

  request.status = 'approved';
  request.reviewedAt = ts;
  request.reviewedBy = reviewedBy;
  // The hash has served its purpose — don't keep credentials in the queue.
  request.pinHash = null;

  await writeBlob('users.json', usersBlob);
  await writeBlob(EMPLOYEES_KEY, empBlob);
  await writeBlob(SIGNUP_REQUESTS_KEY, reqBlob);

  // Welcome email (E5) — best-effort; the account stands even if send fails.
  let welcomeSent = false;
  if (email.isEmailConfigured()) {
    const result = await email.sendTemplate('welcome', {
      to: request.email,
      firstName: request.preferredName || request.firstName,
      companyName: email.companyName(),
      loginUrl: `${baseUrl(req)}/v2/login`,
      adminPhone: process.env.EMAIL_REPLY_PHONE || null,
    });
    welcomeSent = Boolean(result && result.ok);
  }

  return { ok: true, employee, user, welcomeSent };
}

module.exports = { createSignupAccount, SIGNUP_AUTO_REVIEWER };
