const bcrypt = require('bcryptjs');
const { list } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { writeGuardErrorResponse } = require('./_lib/blob-guards');
const { cronAuthState } = require('./_lib/cron-auth');
const { requireAuth, getCurrentUser, canManageJob, isStaffRole, isFieldRole, isLeadingHandRole, isDisabledUser, isClientRole, ownerLoginUsername, OWNER_SENTINEL } = require('./_lib/auth');
const { sendPushToUserId } = require('./_lib/push');

// Role 'owner' is already uncreatable here (not in VALID_ROLES; PUT can't change
// role) — the owner is an env-only principal with no users.json row (#760).
const VALID_ROLES = ['admin', 'tradie', 'leadingHand', 'client'];

// #760: the env-only owner username (and its reserved sentinel id) may never be
// claimed by a real user — a real row with that name would shadow the owner
// login and leave a "trace" in the Employees roster. Enforced on every
// create/rename path below.
function isReservedOwnerName(name) {
  const n = String(name == null ? '' : name).trim().toLowerCase();
  return n !== '' && (n === ownerLoginUsername().toLowerCase() || n === OWNER_SENTINEL);
}

function newId() {
  return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function validateSecret(role, secret) {
  if (!secret) return 'secret required';
  if (role === 'admin') {
    if (String(secret).length < 6) return 'admin password must be at least 6 chars';
  } else {
    if (!/^\d{4}$/.test(String(secret))) return 'PIN must be exactly 4 digits';
  }
  return null;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query && req.query.action) || '';

  // ── Actions accessible to admin OR leadingHand (pre-admin-gate) ──────────

  // POST ?action=createClient — admin or leadingHand with canManageJob
  if (req.method === 'POST' && action === 'createClient') {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'not authenticated' });
    const { username, secret, jobId } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    if (!canManageJob(user, jobId)) return res.status(403).json({ error: 'forbidden' });
    if (!username || !username.trim()) return res.status(400).json({ error: 'username required' });
    if (isReservedOwnerName(username)) return res.status(400).json({ error: 'username is reserved' });
    if (!secret) return res.status(400).json({ error: 'PIN required' });
    const pinErr = validateSecret('client', secret);
    if (pinErr) return res.status(400).json({ error: pinErr });

    const data = await readBlob('users.json', { users: [] });
    data.users = data.users || [];
    if (data.users.find(u => u.username.toLowerCase() === username.trim().toLowerCase())) {
      return res.status(400).json({ error: 'username already exists' });
    }
    const passwordHash = await bcrypt.hash(String(secret), 10);
    const newUser = {
      id: newId(),
      username: username.trim(),
      role: 'client',
      passwordHash,
      assignedJobIds: [jobId],
      createdAt: new Date().toISOString(),
    };
    data.users.push(newUser);
    try {
      await writeBlob('users.json', data, { expectedRev: data.__rev });
    } catch (e) {
      if (e && e.code === 'stale_write') {
        // #157: users.json moved underneath this edit (concurrent admin /
        // sweep / push-prune). Retryable — re-read and re-apply.
        return res.status(409).json({ error: 'conflict', currentRev: e.currentRev });
      }
      throw e;
    }

    // Link client to job
    const jobsData = await readBlob('jobs.json', { jobs: [] });
    const job = (jobsData.jobs || []).find(j => j.id === jobId);
    if (job) {
      job.clientUserId = newUser.id;
      await writeBlob('jobs.json', jobsData);
    }

    const { passwordHash: _, ...safe } = newUser;
    return res.status(200).json({ user: safe });
  }

  // GET ?action=listTradies — the assignable-worker directory used by the Gear
  // holder picker AND job assignment. Caller must be staff: admin-TIER (admin/
  // office/boss/owner/manager/pm/estimator) OR a leading hand — not a literal
  // `admin`/`leadingHand`, so office/boss/PM are no longer locked out. Returns
  // field-tier workers (tradie/electrician/apprentice/labourer) + leading hands
  // — the people who can actually hold gear or be put on a job — never admins/
  // office/clients/unknown, never disabled or archived users, passwordHash
  // stripped. Normalised role checks, not brittle literal strings.
  if (req.method === 'GET' && action === 'listTradies') {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'not authenticated' });
    // #306: field workers need the workmate directory for the gear-handover
    // picker — names/roles of holders only, nothing sensitive.
    if (!isStaffRole(user.role) && !isFieldRole(user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const data = await readBlob('users.json', { users: [] });
    const users = (data.users || [])
      .filter(u => (isFieldRole(u.role) || isLeadingHandRole(u.role)) && !isDisabledUser(u))
      // #304: this is the ONLY non-admin-accessible user fetch (leading hands AND
      // field workers call it for the gear/assignment picker). It must NOT leak
      // pay: strip the legacy users.json `hourlyRate` alongside passwordHash. The
      // confidential loaded-cost rate lives in workforce/cost-rates.json (admin
      // only, api/cost-rates.js) and is never returned here.
      .map(({ passwordHash, hourlyRate, ...u }) => u);
    return res.status(200).json({ users });
  }

  // ── All other user management: admin only — EXCEPT the sweep cron (#381).
  // A VALID CRON_SECRET authorises ?action=sweep without a session (this is
  // what vercel.json's cron sends); anything else — wrong secret, no secret
  // in any environment, unconfigured production — needs an interactive
  // admin. Sweep is destructive, so the preview-no-secret convenience
  // deliberately does NOT apply to it.
  const cronSweep =
    req.method === 'GET' && action === 'sweep' &&
    Boolean(process.env.CRON_SECRET) && cronAuthState(req) === 'ok';
  let me = null;
  if (!cronSweep) {
    me = await requireAuth(req, res, { roles: ['admin'] });
    if (!me) return;
  }

  const data = await readBlob('users.json', { users: [] });
  data.users = data.users || [];

  // NOTE (#381): these two action-gated GET branches previously sat BELOW
  // the bare-GET list and were unreachable — every GET returned the user
  // list first. The sweep cron has never actually swept through this path.
  // GET ?action=archived — list users archived but still inside the
  // restore window. Used by the admin "Restore" UI on /admin/crew.
  if (req.method === 'GET' && action === 'archived') {
    const archived = (data.users || []).filter(u => u.archived).map(u => {
      const { passwordHash, ...safe } = u;
      const at = safe.archivedAt ? Date.parse(safe.archivedAt) : 0;
      const ageDays = Number.isFinite(at) ? (Date.now() - at) / 86400000 : Infinity;
      return { ...safe, restoreWindowDaysRemaining: Math.max(0, Math.ceil(30 - ageDays)) };
    });
    return res.status(200).json({ users: archived });
  }

  // GET ?action=sweep — cron-only: hard-delete archived users past the
  // 30-day window (unless they have unapproved hours; those stay
  // archived until a human clears them).
  if (req.method === 'GET' && action === 'sweep') {
    // Authorised above: valid cron secret (cronSweep) or an admin session.
    const cutoffMs = Date.now() - 30 * 86400000;
    const removed = [];
    const kept = [];
    for (const u of (data.users || [])) {
      if (!u.archived) { kept.push(u); continue; }
      const at = u.archivedAt ? Date.parse(u.archivedAt) : 0;
      if (!Number.isFinite(at) || at > cutoffMs) { kept.push(u); continue; }
      const pending = await userHasUnapprovedHours(u.id);
      if (pending && pending.length) { kept.push(u); continue; }
      removed.push({ id: u.id, username: u.username, archivedAt: u.archivedAt });
    }
    if (removed.length) {
      data.users = kept;
      try {
        // Deliberate bulk removal of reaped archived users — allowShrink so a
        // >20% drop (e.g. 13→10) does not trip the shrink guard and 500 the cron
        // (#512). expectedRev still guards against a concurrent edit.
        await writeBlob('users.json', data, { expectedRev: data.__rev, allowShrink: true });
      } catch (e) {
        // Clean operator-facing error for any tripped guard (stale_write → 409,
        // etc.) instead of a generic 500.
        const mapped = writeGuardErrorResponse(e);
        if (mapped) return res.status(mapped.status).json(mapped.body);
        throw e;
      }
    }
    return res.status(200).json({ ok: true, removed, removedCount: removed.length });
  }

  if (req.method === 'GET') {
    // strip hashes
    const safe = data.users.map(({ passwordHash, ...u }) => u);
    return res.status(200).json({ users: safe });
  }

  if (req.method === 'POST') {
    const { username, role, secret, assignedJobIds = [], hourlyRate, email, xeroEmployeeId } = req.body || {};
    if (!username || !role) return res.status(400).json({ error: 'username and role required' });
    if (isReservedOwnerName(username)) return res.status(400).json({ error: 'username is reserved' });
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'invalid role' });
    }
    const err = validateSecret(role, secret);
    if (err) return res.status(400).json({ error: err });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ error: 'invalid email' });
    }
    if (data.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ error: 'username already exists' });
    }
    const passwordHash = await bcrypt.hash(String(secret), 10);
    const user = {
      id: newId(),
      username,
      role,
      passwordHash,
      email: email ? String(email).trim() : undefined,
      assignedJobIds: Array.isArray(assignedJobIds) ? assignedJobIds : [],
      hourlyRate: (role === 'tradie' || role === 'leadingHand') ? Number(hourlyRate) || 0 : undefined,
      // Xero employee ID — optional, used by payroll CSV export so Xero
      // can match the row back to the employee. Free-text, no validation
      // because Xero IDs come in a few different shapes (UUID, short code).
      xeroEmployeeId: (role === 'tradie' || role === 'leadingHand') && xeroEmployeeId
        ? String(xeroEmployeeId).trim() : undefined,
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    try {
      await writeBlob('users.json', data, { expectedRev: data.__rev });
    } catch (e) {
      if (e && e.code === 'stale_write') {
        // #157: users.json moved underneath this edit (concurrent admin /
        // sweep / push-prune). Retryable — re-read and re-apply.
        return res.status(409).json({ error: 'conflict', currentRev: e.currentRev });
      }
      throw e;
    }
    const { passwordHash: _, ...safe } = user;
    return res.status(200).json({ user: safe });
  }

  if (req.method === 'PUT') {
    const { id, assignedJobIds, hourlyRate, secret, username, email, xeroEmployeeId } = req.body || {};
    const user = data.users.find(u => u.id === id);
    if (!user) return res.status(404).json({ error: 'user not found' });

    // Snapshot prior job assignments before mutation so we can diff and
    // notify the user about *newly added* jobs after the save succeeds.
    const previousJobIds = new Set(user.assignedJobIds || []);
    let addedJobIds = [];

    if (username) {
      if (isReservedOwnerName(username)) return res.status(400).json({ error: 'username is reserved' });
      user.username = username;
    }
    if (Array.isArray(assignedJobIds)) {
      user.assignedJobIds = assignedJobIds;
      addedJobIds = assignedJobIds.filter(j => !previousJobIds.has(j));
    }
    if (hourlyRate !== undefined) user.hourlyRate = Number(hourlyRate) || 0;
    if (xeroEmployeeId !== undefined) {
      // Empty string clears the field; admin sets non-empty to bind to Xero.
      const trimmed = String(xeroEmployeeId).trim();
      user.xeroEmployeeId = trimmed || undefined;
    }
    if (email !== undefined) {
      const trimmed = String(email).trim();
      if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return res.status(400).json({ error: 'invalid email' });
      }
      user.email = trimmed || undefined;
    }
    if (secret) {
      const err = validateSecret(user.role, secret);
      if (err) return res.status(400).json({ error: err });
      user.passwordHash = await bcrypt.hash(String(secret), 10);
    }
    try {
      await writeBlob('users.json', data, { expectedRev: data.__rev });
    } catch (e) {
      if (e && e.code === 'stale_write') {
        // #157: users.json moved underneath this edit (concurrent admin /
        // sweep / push-prune). Retryable — re-read and re-apply.
        return res.status(409).json({ error: 'conflict', currentRev: e.currentRev });
      }
      throw e;
    }

    // Best-effort push: tell the recipient they've been added to one or more
    // jobs. Skipped when the actor edits their own row, when push isn't
    // configured, or when no new jobs were added. Bundles multiple new jobs
    // into a single notification so we don't spam.
    if (addedJobIds.length && user.id !== me.id && !isClientRole(user.role)) {
      try {
        const jobsBlob = await readBlob('jobs.json', { jobs: [] });
        const byId = {};
        for (const j of (jobsBlob.jobs || [])) byId[j.id] = j;
        const names = addedJobIds
          .map(jid => (byId[jid] && byId[jid].name) || '')
          .filter(Boolean);
        const title = addedJobIds.length === 1
          ? 'You’ve been added to a job'
          : 'You’ve been added to ' + addedJobIds.length + ' jobs';
        const body = names.length ? names.join(', ') : 'Open the app for details';
        const targetJobId = addedJobIds[0];
        await sendPushToUserId(user.id, {
          title,
          body,
          url: addedJobIds.length === 1 && byId[targetJobId]
            ? '/phil/jobs/' + targetJobId
            : '/phil/my-day',
          tag: 'buhl-job-assigned-' + Date.now(),
        });
      } catch (e) { /* swallow — best-effort */ }
    }

    const { passwordHash, ...safe } = user;
    return res.status(200).json({ user: safe });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    if (id === me.id) return res.status(400).json({ error: 'cannot delete self' });
    const u = data.users.find(x => x.id === id);
    if (!u) return res.status(404).json({ error: 'user not found' });

    // Brief §08: "Deactivation is reversible for 30 days then becomes
    // deletion — and deletion is hard-blocked if the user has any
    // unapproved hours. Saves the boss from accidentally torching a
    // payroll record."
    const hardDelete = req.query && (req.query.hard === '1' || req.query.hard === 'true');
    if (hardDelete) {
      const pending = await userHasUnapprovedHours(id);
      // Array contract: empty = no blocker. (`if (pending)` was always truthy —
      // an empty array blocked EVERY hard-delete, even with zero pending hours.)
      if (pending.length > 0) {
        return res.status(409).json({
          error: 'cannot hard-delete — user has unapproved hours. Approve or reject them first.',
          pendingDates: pending,
        });
      }
      data.users = data.users.filter(x => x.id !== id);
      try {
      await writeBlob('users.json', data, { expectedRev: data.__rev });
    } catch (e) {
      if (e && e.code === 'stale_write') {
        // #157: users.json moved underneath this edit (concurrent admin /
        // sweep / push-prune). Retryable — re-read and re-apply.
        return res.status(409).json({ error: 'conflict', currentRev: e.currentRev });
      }
      throw e;
    }
      return res.status(200).json({ ok: true, mode: 'hard' });
    }

    // Soft-archive — flip the user out of active lists but keep
    // them on file so we can restore within 30 days.
    if (u.archived) {
      return res.status(400).json({ error: 'already archived (use ?action=restore to revert, or ?hard=1 to remove permanently)' });
    }
    u.archived = true;
    u.archivedAt = new Date().toISOString();
    u.archivedBy = me.id;
    try {
      await writeBlob('users.json', data, { expectedRev: data.__rev });
    } catch (e) {
      if (e && e.code === 'stale_write') {
        // #157: users.json moved underneath this edit (concurrent admin /
        // sweep / push-prune). Retryable — re-read and re-apply.
        return res.status(409).json({ error: 'conflict', currentRev: e.currentRev });
      }
      throw e;
    }
    return res.status(200).json({ ok: true, mode: 'soft', restoreUntil: addDaysIso(u.archivedAt, 30) });
  }

  // POST ?action=restore — un-archive within the 30-day window.
  if (req.method === 'POST' && action === 'restore') {
    const { id } = req.query || req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const u = data.users.find(x => x.id === id);
    if (!u) return res.status(404).json({ error: 'user not found' });
    if (!u.archived) return res.status(400).json({ error: 'user is not archived' });
    const archivedAt = u.archivedAt ? Date.parse(u.archivedAt) : 0;
    const ageDays = Number.isFinite(archivedAt) ? (Date.now() - archivedAt) / 86400000 : Infinity;
    if (ageDays > 30) {
      return res.status(410).json({ error: 'restore window expired (30 days)' });
    }
    delete u.archived;
    delete u.archivedAt;
    delete u.archivedBy;
    u.updatedAt = new Date().toISOString();
    try {
      await writeBlob('users.json', data, { expectedRev: data.__rev });
    } catch (e) {
      if (e && e.code === 'stale_write') {
        // #157: users.json moved underneath this edit (concurrent admin /
        // sweep / push-prune). Retryable — re-read and re-apply.
        return res.status(409).json({ error: 'conflict', currentRev: e.currentRev });
      }
      throw e;
    }
    const { passwordHash, ...safe } = u;
    return res.status(200).json({ user: safe });
  }



  res.status(405).end();
};

// ── Helpers ──────────────────────────────────────────────────────

async function userHasUnapprovedHours(userId) {
  // Returns an array of dates with status='submitted' (or 'rejected')
  // — anything not yet approved. Empty array means no blocker.
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const r = await list({ prefix: `users/${userId}/time-entries/`, token, limit: 1000 });
    const blobs = (r.blobs || []).filter(b =>
      b.pathname.endsWith('.json') && !b.pathname.includes('/time-entries-audit/'));
    const out = [];
    for (const b of blobs) {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) continue;
        const e = await rr.json();
        if (e && e.status && e.status !== 'approved') out.push(e.date);
      } catch {}
    }
    return out;
  } catch (e) {
    // Be conservative: if the check fails, treat as "has pending" so
    // we don't accidentally hard-delete a payroll record.
    console.error('userHasUnapprovedHours failed', e);
    return ['__check_failed__'];
  }
}

function addDaysIso(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

