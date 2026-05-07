const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

function newId() {
  return 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Normalise whatever is in the blob to { entries: [...] }.
// Handles the old broken shape (single {date,crew,notes} object).
function normalise(raw) {
  if (raw && Array.isArray(raw.entries)) return raw;
  if (raw && raw.date && Array.isArray(raw.crew)) {
    // Legacy single-entry blob — wrap it
    return { entries: [{ id: newId(), date: raw.date, crew: raw.crew, notes: raw.notes || '' }] };
  }
  if (Array.isArray(raw)) return { entries: raw };
  return { entries: [] };
}

// Add { hours, minutes } convenience fields to a decimal hours value
function enrichCrew(crew) {
  return (crew || []).map(c => ({
    ...c,
    hoursMins: { hours: Math.floor(c.hours), minutes: Math.round((c.hours % 1) * 60) },
  }));
}

// ─── DEPRECATED ────────────────────────────────────────────────────────────
// This is the legacy per-job hours endpoint. After the time-entries cutover
// across the live UI, NO part of BuhlOS reads or writes this anymore. We keep
// GET working so the migration script + any external read-only viewer can
// still access historical data; writes are blocked with 410 Gone so an orphan
// stale browser tab can't create a dead-end entry that never reaches the new
// system.
//
// To retire this endpoint completely once migration is verified:
//   1. Run scripts/migrate-hours.js to backfill legacy → time-entries
//   2. Delete the source jobs/<id>/hours.json blobs
//   3. Delete this file + the route mapping
// ───────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Block writes — single source of truth is /api/time-entries.
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    return res.status(410).json({
      error: 'legacy /api/hours is read-only — log hours via /api/time-entries (BuhlLogHours modal)',
      replaceWith: '/api/time-entries',
    });
  }

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  // Clients cannot access hours
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const KEY = `jobs/${jobId}/hours.json`;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const raw = await readBlob(KEY, { entries: [] });
    const data = normalise(raw);
    const entries = data.entries.map(e => ({ ...e, crew: enrichCrew(e.crew) }));
    return res.status(200).json({ entries });
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });

    const body = req.body || {};
    const force = (req.query && req.query.force) === '1';

    const raw = await readBlob(KEY, { entries: [] });
    const data = normalise(raw);

    // ── New fast-path format: { date, entries: [{userId, hours, minutes}] }
    if (body.entries && Array.isArray(body.entries)) {
      const date = body.date;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date required as YYYY-MM-DD' });
      }

      // Load users for name lookup + permission checks
      const usersData = await readBlob('users.json', { users: [] });
      const usersById = {};
      (usersData.users || []).forEach(u => { usersById[u.id] = u; });

      // Find or create day entry
      let dayEntry = data.entries.find(e => e.date === date);
      if (!dayEntry) {
        dayEntry = { id: newId(), date, crew: [], notes: '' };
        data.entries.push(dayEntry);
      }

      const conflicts = [];
      const saved = [];

      for (const item of body.entries) {
        const { userId, hours = 0, minutes = 0 } = item;
        if (!userId) continue;

        // Role check: tradies can only write for themselves or other tradies on this job
        if (user.role === 'tradie' && userId !== user.id) {
          const target = usersById[userId];
          if (!target || target.role !== 'tradie') continue;
          if (!(target.assignedJobIds || []).includes(jobId)) continue;
        }

        const decimal = Number(hours) + Number(minutes) / 60;
        const existing = dayEntry.crew.find(c => c.userId === userId);

        if (existing && !force) {
          conflicts.push({
            userId,
            existing: {
              hours: Math.floor(existing.hours),
              minutes: Math.round((existing.hours % 1) * 60),
            },
          });
        } else {
          const name = (usersById[userId] && usersById[userId].username) || item.name || userId;
          if (existing) {
            existing.hours = decimal;
            existing.name = name;
          } else {
            dayEntry.crew.push({ userId, name, hours: decimal });
          }
          saved.push({ userId });
        }
      }

      // Always write even if some conflicts — non-conflicting rows are already saved
      if (saved.length > 0 || (force && conflicts.length === 0)) {
        await writeBlob(KEY, data);
      }

      if (conflicts.length > 0) {
        return res.status(409).json({ conflicts, saved });
      }
      return res.status(200).json({ ok: true, saved });
    }

    // ── Legacy format: { date, crew: [{name, hours}], notes } ────────────
    // Used by the existing Hours tab submit form
    if (body.crew && Array.isArray(body.crew)) {
      const date = body.date;
      if (!date) return res.status(400).json({ error: 'date required' });

      let dayEntry = data.entries.find(e => e.date === date);
      if (dayEntry) {
        // Merge by name
        for (const c of body.crew) {
          const ex = dayEntry.crew.find(x => x.name === c.name);
          if (ex) ex.hours = c.hours;
          else dayEntry.crew.push(c);
        }
        if (body.notes !== undefined) dayEntry.notes = body.notes;
      } else {
        data.entries.push({
          id: newId(),
          date,
          crew: body.crew,
          notes: body.notes || '',
        });
      }

      await writeBlob(KEY, data);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'invalid payload — expected entries[] or crew[]' });
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const raw = await readBlob(KEY, { entries: [] });
    const data = normalise(raw);
    data.entries = data.entries.filter(e => e.id !== id);
    await writeBlob(KEY, data);
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
