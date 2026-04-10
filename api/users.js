const bcrypt = require('bcryptjs');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

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

  // Only admin can manage users
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
    const { username, role, secret, assignedJobIds = [], hourlyRate } = req.body || {};
    if (!username || !role) return res.status(400).json({ error: 'username and role required' });
    if (!['admin', 'tradie', 'client'].includes(role)) {
      return res.status(400).json({ error: 'invalid role' });
    }
    const err = validateSecret(role, secret);
    if (err) return res.status(400).json({ error: err });
    if (data.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ error: 'username already exists' });
    }
    const passwordHash = await bcrypt.hash(String(secret), 10);
    const user = {
      id: newId(),
      username,
      role,
      passwordHash,
      assignedJobIds: Array.isArray(assignedJobIds) ? assignedJobIds : [],
      hourlyRate: role === 'tradie' ? Number(hourlyRate) || 0 : undefined,
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    await writeBlob('users.json', data);
    const { passwordHash: _, ...safe } = user;
    return res.status(200).json({ user: safe });
  }

  if (req.method === 'PUT') {
    const { id, assignedJobIds, hourlyRate, secret, username } = req.body || {};
    const user = data.users.find(u => u.id === id);
    if (!user) return res.status(404).json({ error: 'user not found' });
    if (username) user.username = username;
    if (Array.isArray(assignedJobIds)) user.assignedJobIds = assignedJobIds;
    if (hourlyRate !== undefined) user.hourlyRate = Number(hourlyRate) || 0;
    if (secret) {
      const err = validateSecret(user.role, secret);
      if (err) return res.status(400).json({ error: err });
      user.passwordHash = await bcrypt.hash(String(secret), 10);
    }
    await writeBlob('users.json', data);
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
