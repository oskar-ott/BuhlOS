// Bulk close snags on a single job.
//
//   POST /api/snags-bulk-close?jobId=<id>
//        body: { snagIds: [...], note?: 'string' }
//
// Closes up to 100 snags in one read-modify-write. Avoids the existing
// /api/data full-document POST race: every concurrent edit there has to
// re-fetch the whole job data and risk stomping someone else's snag
// write. Here we read once, mark the listed snags Closed atomically,
// write back, return per-snag results.
//
// Why this exists:
//   Handover day. The builder walks through, ticks off twenty snags on a
//   clipboard, then expects them all closed in the system. Doing it row
//   by row in /admin/snags is fifteen minutes of clicking; this endpoint
//   collapses it to one call.
//
//   The optional `note` is stamped onto each closed snag as `closeNote`,
//   so handover summary CSVs (/api/snags-export) can show "Closed:
//   verified on site walkthrough 12/05" alongside the resolved-at date.
//
// Permissions:
//   - admin: any job
//   - leadingHand: their assigned jobs only (canManageJob)
//   - everyone else: 403
//
// Notes:
//   - Already-closed snags are reported in `failed[]` with a clear reason
//     so the UI can distinguish "didn't apply" from "actually failed".
//   - The write is best-effort idempotent — if it fails partway, no
//     mutation lands because we write the entire data blob in one shot.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isStaffRole } = require('./_lib/auth');

const MAX_SNAGS = 100;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isStaffRole(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'no access to job' });

  const body = req.body || {};
  const ids = Array.isArray(body.snagIds) ? body.snagIds : null;
  if (!ids) return res.status(400).json({ error: 'snagIds array required' });
  if (!ids.length) return res.status(400).json({ error: 'snagIds cannot be empty' });
  if (ids.length > MAX_SNAGS) {
    return res.status(400).json({ error: `too many snags (max ${MAX_SNAGS})` });
  }
  const note = (body.note ? String(body.note) : '').trim();

  const KEY = `jobs/${jobId}/data.json`;
  const data = await readBlob(KEY, { dwellings: {}, snags: [], notes: [] });
  const snags = Array.isArray(data.snags) ? data.snags : [];

  const byId = {};
  for (const s of snags) if (s && s.id) byId[s.id] = s;

  const closed = [];
  const failed = [];
  const nowIso = new Date().toISOString();

  for (const sid of ids) {
    if (!sid) {
      failed.push({ snagId: sid || null, error: 'missing id' });
      continue;
    }
    const s = byId[sid];
    if (!s) {
      failed.push({ snagId: sid, error: 'not found' });
      continue;
    }
    if ((s.status || 'Open') === 'Closed') {
      failed.push({ snagId: sid, error: 'already closed' });
      continue;
    }
    s.status     = 'Closed';
    s.closedAt   = nowIso;
    s.updatedAt  = nowIso;
    s.updatedBy  = me.username;
    if (note) s.closeNote = note;
    closed.push({ snagId: sid, desc: s.desc || '' });
  }

  if (closed.length) {
    try {
      await writeBlob(KEY, data);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
  }

  return res.status(200).json({
    jobId,
    closedCount: closed.length,
    failedCount: failed.length,
    closed,
    failed,
  });
};
