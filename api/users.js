const bcrypt = require('bcryptjs');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, getCurrentUser, canManageJob } = require('./_lib/auth');
const { sendPushToUserId } = require('./_lib/push');

const VALID_ROLES = ['admin', 'tradie', 'leadingHand', 'client'];

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
    await writeBlob('users.json', data);

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

  // GET ?action=listTradies — admin or leadingHand; returns non-client non-admin users
  if (req.method === 'GET' && action === 'listTradies') {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'not authenticated' });
    if (user.role !== 'admin' && user.role !== 'leadingHand') {
      return res.status(403).json({ error: 'forbidden' });
    }
    const data = await readBlob('users.json', { users: [] });
    const users = (data.users || [])
      .filter(u => u.role === 'tradie' || u.role === 'leadingHand')
      .map(({ passwordHash, ...u }) => u);
    return res.status(200).json({ users });
  }

  // ── All other user management: admin only ────────────────────────────────
  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const data = await readBlob('users.json', { users: [] });
  data.users = data.users || [];

  if (req.method === 'GET') {
    // strip hashes
    const safe = data.users.map(({ passwordHash, ...u }) => u);
    return res.status(200).json({ users: safe });
  }

  if (req.method === 'POST') {
    const { username, role, secret, assignedJobIds = [], hourlyRate, email, xeroEmployeeId } = req.body || {};
    if (!username || !role) return res.status(400).json({ error: 'username and role required' });
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
    await writeBlob('users.json', data);
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

    if (username) user.username = username;
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
    await writeBlob('users.json', data);

    // Best-effort push: tell the recipient they've been added to one or more
    // jobs. Skipped when the actor edits their own row, when push isn't
    // configured, or when no new jobs were added. Bundles multiple new jobs
    // into a single notification so we don't spam.
    if (addedJobIds.length && user.id !== me.id && user.role !== 'client') {
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
            ? '/jobs/' + targetJobId
            : '/my-day',
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
    data.users = data.users.filter(u => u.id !== id);
    await writeBlob('users.json', data);
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
