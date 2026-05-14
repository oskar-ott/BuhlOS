// Hours endpoint.
// - GET     /api/hours?jobId=X            → list entries (filtered for tradies to their own + assigned job)
// - GET     /api/hours?jobId=X&mine=1      → list only my entries
// - POST    /api/hours?jobId=X&op=add      → append a single entry { date, hours, notes? }
// - POST    /api/hours?jobId=X&op=remove   → remove an entry { id }
// - POST    /api/hours?jobId=X             → (legacy) overwrite whole blob (admin only)
//
// Entry shape:
//   { id, userId, username, date, hours, notes, createdAt, locked? }
//
// Tradies can only add/remove their OWN entries, and cannot modify locked entries.
// Admin can do anything.
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

function newId() {
  return 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function loadEntries(jobId) {
  const data = await readBlob(`jobs/${jobId}/hours.json`, { entries: [] });
  // Tolerate legacy shapes: { entries: [...] } | [...] | { ...singleDay }
  if (Array.isArray(data)) return { entries: data };
  if (data && Array.isArray(data.entries)) return data;
  // Unknown legacy single-day object → treat as empty (don't lose, but don't surface)
  return { entries: [] };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  // Clients cannot see hours
  if (user.role === 'client') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const KEY = `jobs/${jobId}/hours.json`;
  const mine = (req.query && (req.query.mine === '1' || req.query.mine === 'true'));
  const op = (req.query && req.query.op) || '';

  if (req.method === 'GET') {
    const data = await loadEntries(jobId);
    let entries = data.entries || [];
    if (mine || user.role === 'tradie') {
      // Tradies can only see their own entries.
      entries = entries.filter(e => e.userId === user.id);
    }
    return res.status(200).json({ entries });
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });

    if (op === 'add') {
      const { date, hours, notes, userId: targetUserId } = req.body || {};
      const h = parseFloat(hours);
      if (!date || !Number.isFinite(h) || h <= 0 || h > 24) {
        return res.status(400).json({ error: 'date and hours (0-24) required' });
      }
      // Tradies log only for themselves
      const ownerId = (user.role === 'admin' && targetUserId) ? targetUserId : user.id;
      const data = await loadEntries(jobId);
      // Prevent same-day duplicates for the same user (unless admin overrides via separate user)
      const dupe = (data.entries || []).find(e =>
        e.userId === ownerId && e.date === date && !e.deletedAt
      );
      if (dupe) {
        return res.status(409).json({
          error: 'already logged',
          entry: dupe,
        });
      }
      const entry = {
        id: newId(),
        userId: ownerId,
        username: user.role === 'admin' && targetUserId ? null : user.username,
        date,
        hours: h,
        notes: (notes || '').toString().slice(0, 280),
        enteredBy: user.username,
        enteredByRole: user.role,
        createdAt: new Date().toISOString(),
      };
      data.entries = data.entries || [];
      data.entries.push(entry);
      await writeBlob(KEY, data);
      return res.status(200).json({ entry });
    }

    if (op === 'remove') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const data = await loadEntries(jobId);
      const idx = (data.entries || []).findIndex(e => e.id === id);
      if (idx === -1) return res.status(404).json({ error: 'entry not found' });
      const entry = data.entries[idx];
      if (entry.locked && user.role !== 'admin') {
        return res.status(403).json({ error: 'entry is locked' });
      }
      if (user.role !== 'admin' && entry.userId !== user.id) {
        return res.status(403).json({ error: 'not your entry' });
      }
      data.entries.splice(idx, 1);
      await writeBlob(KEY, data);
      return res.status(200).json({ ok: true });
    }

    // Legacy: admin-only full-blob overwrite. Keep for compatibility.
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      await writeBlob(KEY, req.body);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
