const bcrypt = require('bcryptjs');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const {
  setSessionCookie, clearSessionCookie, getCurrentUser, isDisabledUser,
  resolveOwnerPasswordHash, ownerLoginUsername, syntheticOwner, isOwnerSentinel,
} = require('./_lib/auth');
const { createRateLimiter } = require('./_lib/rate-limit');

const DISABLED_MESSAGE = 'Account disabled. Ask your supervisor.';

// #514: per-USERNAME throttle on failed PIN logins. A four-digit field PIN is
// online brute-forceable; this slows a wrong-PIN storm on one username without a
// shared-site IP locking out the rest of the crew. In-memory, per-serverless-
// instance (honest limitation — a slowdown, not a hard cluster-wide lockout;
// see api/_lib/rate-limit.js). 5 failures / 15 min, cleared on a successful login.
const loginThrottle = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

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
    const throttleKey = String(username).toLowerCase();
    // #514: refuse early when this username is already over the failed-attempt
    // limit — BEFORE the password compare, so a throttled account can't be
    // probed (and the correct PIN won't sneak through a lockout window).
    if (loginThrottle.isLimited(throttleKey)) {
      const retryAfterSec = loginThrottle.retryAfterSec(throttleKey);
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.', retryAfterSec });
    }
    // Env-only owner (#760): a synthetic super-admin with NO users.json row. Only
    // active when OWNER_PASSWORD_HASH is configured (fail closed); checked BEFORE
    // the users.json lookup so the reserved owner username can't be shadowed.
    // Throttled like any login; the session carries the reserved sentinel id.
    const ownerHash = await resolveOwnerPasswordHash();
    if (ownerHash && throttleKey === ownerLoginUsername().toLowerCase()) {
      const ownerOk = await bcrypt.compare(String(secret), ownerHash);
      if (!ownerOk) {
        loginThrottle.record(throttleKey);
        return res.status(401).json({ error: 'invalid credentials' });
      }
      loginThrottle.clear(throttleKey);
      const owner = syntheticOwner();
      setSessionCookie(res, { userId: owner.id, role: owner.role });
      return res.status(200).json({ user: owner });
    }
    const data = await readBlob('users.json', { users: [] });
    const user = (data.users || []).find(u => u.username.toLowerCase() === throttleKey);
    if (!user) {
      loginThrottle.record(throttleKey); // throttle guessing of unknown usernames too
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const ok = await bcrypt.compare(String(secret), user.passwordHash);
    if (!ok) {
      loginThrottle.record(throttleKey);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (isDisabledUser(user)) return res.status(403).json({ error: DISABLED_MESSAGE });
    loginThrottle.clear(throttleKey); // a good login resets the counter
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
    // Env-only owner (#760): no users.json row — rotate the password into the
    // owner-auth.json blob so it can be changed from the console without an env
    // edit + redeploy. Verify CURRENT against the effective hash (blob else env
    // bootstrap), then write the new hash (it wins thereafter).
    if (isOwnerSentinel(me.id)) {
      const currentHash = await resolveOwnerPasswordHash();
      if (!currentHash) return res.status(400).json({ error: 'owner login not configured' });
      const ok = await bcrypt.compare(String(currentSecret), currentHash);
      if (!ok) return res.status(401).json({ error: 'current password incorrect' });
      if (String(newSecret).length < 8) {
        return res.status(400).json({ error: 'owner password must be at least 8 characters' });
      }
      const passwordHash = await bcrypt.hash(String(newSecret), 12);
      // Literal key (matches OWNER_AUTH_KEY in ./_lib/auth) — the backup-manifest
      // guard resolves same-file string literals; owner-auth.json is in the manifest.
      await writeBlob('owner-auth.json', { passwordHash, updatedAt: new Date().toISOString() });
      return res.status(200).json({ ok: true });
    }
    const data = await readBlob('users.json', { users: [] });
    const u = (data.users || []).find(x => x.id === me.id);
    if (!u) return res.status(404).json({ error: 'user not found' });
    const ok = await bcrypt.compare(String(currentSecret), u.passwordHash);
    if (!ok) return res.status(401).json({ error: 'current password incorrect' });
    // role-literal-ok: credential FORMAT policy (admin password vs 4-digit PIN) is tied to the stored literal role, not the tier
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
