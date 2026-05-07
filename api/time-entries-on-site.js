// Returns crew on-site for a given job + date.
//
//   GET /api/time-entries-on-site?jobId=<id>&date=YYYY-MM-DD
//                                 (date defaults to today)
//
// Response: { count, users: [{ id, username, hours }] }
//
// Why this exists:
//   /api/time-entries-overview is admin/LH-only — too restrictive for the
//   "X on site today" sub-meta on /my-day's job rows, which is useful for
//   tradies to see who else is on a job. This endpoint is the minimum-data
//   variant: it returns just user identifiers + their this-job hours for that
//   date, gated by canWrite (i.e. job-assignment access).
//
// Permissions:
//   - admin: any job
//   - leadingHand / tradie: only jobs in their assignedJobIds
//   - client: 403 (clients don't see hours)

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return; // requireAuth already wrote 401/403

  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (!canWrite(user, jobId) && user.role !== 'admin') {
    return res.status(403).json({ error: 'no access to job' });
  }

  const date = (req.query && req.query.date) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  // Walk users/<*>/time-entries/<date>.json by path-prefix — no body fetch
  // unless the path matches.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let blobs = [];
  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    blobs = r.blobs || [];
  } catch (e) {
    return res.status(502).json({ error: 'blob list failed: ' + e.message });
  }
  const matching = blobs.filter(b => b.pathname.endsWith('/time-entries/' + date + '.json'));

  const fetched = await Promise.all(matching.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }));

  // Need usernames in case the entry didn't capture them at create time
  // (back-compat with earlier writes). Single users.json read.
  const usersBlob = await readBlob('users.json', { users: [] });
  const userById = {};
  (usersBlob.users || []).forEach(u => { userById[u.id] = u; });

  const out = [];
  for (const e of fetched) {
    if (!e || !e.userId) continue;
    const allocs = (e.allocations || []).filter(a => a.jobId === jobId);
    if (!allocs.length) continue; // entry exists but on other jobs only
    const hours = allocs.reduce((s, a) => s + (Number(a.hours) || 0), 0);
    if (hours <= 0) continue;
    out.push({
      id: e.userId,
      username: e.userName || (userById[e.userId] && userById[e.userId].username) || e.userId,
      hours: Math.round(hours * 100) / 100,
    });
  }

  out.sort((a, b) => a.username.localeCompare(b.username));
  return res.status(200).json({ count: out.length, users: out });
};
