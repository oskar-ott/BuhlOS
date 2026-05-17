// Hours: per-job entries list, append-safe.
// Two record shapes coexist in one list:
//   Phil personal entry: { id, date, jobId, userId, by, start, end, type, hours, notes, source:'phil' }
//   Switchboard crew day: { id, date, crew:[{name, hours}], notes, source:'switchboard' }
//
// POST behaviour:
//   ?action=append (default if body has no `entries` array): append one entry
//   ?action=replace (or body has `entries: [...]` AND user is admin):
//     bulk-replace the entire entries list. Tradies can never bulk-replace.
//
// New for Phil: GET /api/hours?mine=true returns the current user's entries
// across every job they're assigned to, so Phil doesn't fan out per-job.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, getCurrentUser, canWrite } = require('./_lib/auth');
const {
  readList, writeList, appendRecord, updateRecord, deleteRecord,
} = require('./_lib/listblob');

const FIELD = 'entries';
function keyFor(jobId) { return `jobs/${jobId}/hours.json`; }

function inDateRange(e, fromIso, toIso) {
  const d = String(e.date || '');
  if (fromIso && d < fromIso) return false;
  if (toIso && d > toIso) return false;
  return true;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET /api/hours?mine=true&from=&to= — per-user aggregator ────────
  if (req.method === 'GET' && req.query && req.query.mine === 'true') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'not authenticated' });
    if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });
    const jobIds = (me.assignedJobIds || []);
    const from = req.query.from || '';
    const to   = req.query.to   || '';
    const all = [];
    await Promise.all(jobIds.map(async jobId => {
      const list = await readList(keyFor(jobId), FIELD);
      list.forEach(e => {
        if (!e || e.status === 'deleted') return;
        if (e.userId && me.id && e.userId !== me.id) return;
        if (!inDateRange(e, from, to)) return;
        all.push({ ...e, jobId });
      });
    }));
    all.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return res.status(200).json({ entries: all });
  }

  // ── Per-job routes ─────────────────────────────────────────────────
  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const user = await requireAuth(req, res, { jobId });
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const KEY = keyFor(jobId);

  if (req.method === 'GET') {
    const entries = (await readList(KEY, FIELD)).filter(e => e && e.status !== 'deleted');
    return res.status(200).json({ entries });
  }

  if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const action = (req.query && req.query.action) || '';
      const isBulk = action === 'replace' || Array.isArray(body.entries);
      if (isBulk) {
        // Bulk replace is admin-only to prevent prior-data-loss bugs from
        // less-careful clients. Phil should use append.
        if (user.role !== 'admin') return res.status(403).json({ error: 'admin only for bulk replace' });
        const list = Array.isArray(body.entries) ? body.entries : [];
        await writeList(KEY, FIELD, list);
        return res.status(200).json({ ok: true, entries: list });
      }
      // Single-record append. Tag with source so Switchboard can tell which
      // entries came from Phil vs the desk.
      const record = { ...body };
      if (!record.source) {
        record.source = Array.isArray(record.crew) ? 'switchboard' : 'phil';
      }
      if (record.source === 'phil' && !record.userId && user.id) record.userId = user.id;
      if (record.source === 'phil' && !record.by    && user.username) record.by    = user.username;
      const { record: saved, list } = await appendRecord(KEY, FIELD, record, user, 'hour');
      return res.status(200).json({ ok: true, entry: saved, entries: list });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'PUT') {
    const id = (req.body && req.body.id) || (req.query && req.query.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const { record, list } = await updateRecord(KEY, FIELD, id, req.body || {}, user);
      if (!record) return res.status(404).json({ error: 'entry not found' });
      return res.status(200).json({ ok: true, entry: record, entries: list });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    const id = (req.body && req.body.id) || (req.query && req.query.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const { ok, list } = await deleteRecord(KEY, FIELD, id, user);
      if (!ok) return res.status(404).json({ error: 'entry not found' });
      return res.status(200).json({ ok: true, entries: list.filter(e => e && e.status !== 'deleted') });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
