const bcrypt = require('bcryptjs');
const { readBlob, setNoCache } = require('./_lib/blob');
const {
  setSessionCookie, clearSessionCookie, getCurrentUser,
} = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query && req.query.action) || '';

  // GET /api/auth?action=me
  if (req.method === 'GET' && action === 'me') {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'not authenticated' });
    return res.status(200).json({ user });
  }

  // POST /api/auth?action=login  { username, secret }
  if (req.method === 'POST' && action === 'login') {
    const { username, secret } = req.body || {};
    if (!username || !secret) {
      return res.status(400).json({ error: 'username and secret required' });
    }
    const data = await readBlob('users.json', { users: [] });
    const user = (data.users || []).find(
      u => u.username.toLowerCase() === String(username).toLowerCase()
    );
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(String(secret), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    setSessionCookie(res, { userId: user.id, role: user.role });
    const { passwordHash, ...safe } = user;
    return res.status(200).json({ user: safe });
  }

  // POST /api/auth?action=logout
  if (req.method === 'POST' && action === 'logout') {
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  }

  res.status(404).json({ error: 'unknown action' });
};
