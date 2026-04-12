const bcrypt = require('bcryptjs');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const {
  setSessionCookie, clearSessionCookie, getCurrentUser,
} = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || '';

  if (req.method === 'GET' && action === 'me') {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'not authenticated' });
    return res.status(200).json({ user });
  }

  if (req.method === 'POST' && action === 'login') {
    const { username, secret } = req.body || {};
    if (!username || !secret) return res.status(400).json({ error: 'username and secret required' });
    const data = await readBlob('users.json', { users: [] });
    const user = (data.users || []).find(u => u.username.toLowerCase() === String(username).toLowerCase());
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(String(secret), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    setSessionCookie(res, { userId: user.id, role: user.role });
    const { passwordHash, ...safe } = user;
    return res.status(200).json({ user: safe });
  }

  if (req.method === 'POST' && action === 'logout') {
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'POST' && action === 'change-password') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'not authenticated' });
    const { currentSecret, newSecret } = req.body || {};
    if (!currentSecret || !newSecret) return res.status(400).json({ error: 'current and new required' });
    const data = await readBlob('users.json', { users: [] });
    const u = (data.users || []).find(x => x.id === me.id);
    if (!u) return res.status(404).json({ error: 'user not found' });
    const ok = await bcrypt.compare(String(currentSecret), u.passwordHash);
    if (!ok) return res.status(401).json({ error: 'current password incorrect' });
    if (u.role === 'admin') {
      if (String(newSecret).length < 6) return res.status(400).json({ error: 'admin password must be at least 6 chars' });
    } else {
      if (!/^\d{4}$/.test(String(newSecret))) return res.status(400).json({ error: 'PIN must be 4 digits' });
    }
    u.passwordHash = await bcrypt.hash(String(newSecret), 10);
    await writeBlob('users.json', data);
    return res.status(200).json({ ok: true });
  }

  res.status(404).json({ error: 'unknown action' });
};
