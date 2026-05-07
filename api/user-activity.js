// Lightweight activity log used by /my-day's "Continue where you left off".
//
// Schema in blob `user-activity.json`:
//   { entries: [{ userId, jobId, areaId, kind, ts }, ...] }
//
// Rolling window: keep most recent 50 entries per user. kind is 'task'|'snag'|'note'.
//
// GET  /api/user-activity              -> returns entries for the current user (newest first, max 50)
// POST /api/user-activity { jobId, areaId, kind } -> appends entry for current user (fire-and-forget)
//
// Writes are best-effort. A failure here must not break the underlying task/snag/note save —
// the frontend calls this with catch() silenced.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser, canWrite } = require('./_lib/auth');

const KEY = 'user-activity.json';
const MAX_PER_USER = 50;
const VALID_KINDS = new Set(['task', 'snag', 'note']);

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  // GET — return this user's recent activity (top 50)
  if (req.method === 'GET') {
    const raw = await readBlob(KEY, { entries: [] });
    const mine = (raw.entries || [])
      .filter(e => e.userId === me.id)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, MAX_PER_USER);
    return res.status(200).json({ entries: mine });
  }

  // POST — append an activity record
  if (req.method === 'POST') {
    const { jobId, areaId, kind } = req.body || {};
    if (!jobId || !areaId || !kind) {
      return res.status(400).json({ error: 'jobId, areaId, kind required' });
    }
    if (!VALID_KINDS.has(kind)) {
      return res.status(400).json({ error: 'invalid kind' });
    }
    // Permission: user must have write access to this job (same rule as task save)
    if (!canWrite(me, jobId)) {
      // Silently OK — don't error, because the activity write is fire-and-forget
      return res.status(200).json({ ok: true, skipped: 'no access' });
    }

    const raw = await readBlob(KEY, { entries: [] });
    raw.entries = raw.entries || [];
    raw.entries.push({
      userId: me.id,
      jobId: String(jobId),
      areaId: String(areaId),
      kind,
      ts: Date.now(),
    });

    // Cap per-user to MAX_PER_USER (trim oldest). Cheap on a ~hundreds-of-entries blob.
    const byUser = {};
    raw.entries.forEach(e => {
      (byUser[e.userId] = byUser[e.userId] || []).push(e);
    });
    const trimmed = [];
    for (const uid of Object.keys(byUser)) {
      byUser[uid].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const keep = byUser[uid].slice(-MAX_PER_USER);
      trimmed.push(...keep);
    }
    raw.entries = trimmed;

    await writeBlob(KEY, raw);
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
