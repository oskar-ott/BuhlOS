// Bulk close snags on a single job — BOTH stores since #414.
//
//   POST /api/snags-bulk-close?jobId=<id>
//        body: { snagIds: [...], note?: 'string' }
//
// Closes up to 100 snags in one read-modify-write. Avoids the existing
// /api/data full-document POST race: every concurrent edit there has to
// re-fetch the whole job data and risk stomping someone else's snag
// write. Here we read once, mark the listed snags closed atomically,
// write back, return per-snag results.
//
// Why this exists:
//   Handover day. The builder walks through, ticks off twenty snags on a
//   clipboard, then expects them all closed in the system. Doing it row
//   by row is fifteen minutes of clicking; this endpoint collapses it to
//   one call. Since #414 it backs the /defects register's bulk-close.
//
// Each requested id is resolved against snagsV2[] FIRST, then the legacy
// snags[] array, and closed with the CORRECT semantics for its store:
//
//   v2 (mirrors api/snags.js applyTransition 'closed'):
//     status='closed', closedAt, closedById, closedByName, updatedAt
//     - already 'closed'  → failed: 'already closed'
//     - 'rejected'        → failed: 'rejected — reopen it first' (rejected
//       means admin ruled it NOT a defect; closing it would silently
//       overwrite that ruling. Single-snag recovery stays in /v2/jobs/
//       [jobId]/snags via rejected→open.)
//     - any other status closes directly. This deliberately SKIPS the
//       single-snag verify step (resolved→verified→closed) — bulk close
//       IS the walkthrough sign-off, same as the legacy behaviour below.
//     - NO per-snag audit rows are written (parity with this endpoint's
//       pre-#414 behaviour; up to 100 sequential journal writes inside
//       one request is its own race hazard). auditLogIds is best-effort
//       by design — api/snags.js tolerates gaps.
//
//   legacy (unchanged):
//     status='Closed', closedAt, updatedAt, updatedBy
//
//   The optional `note` is stamped onto each closed snag as `closeNote`
//   (both stores; the v2 schema is passthrough), so handover summary
//   CSVs (/api/snags-export) can show "Closed: verified on site
//   walkthrough 12/05" alongside the resolved-at date.
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
//     mutation lands because we write the entire data blob (BOTH arrays
//     live on the same jobs/<id>/data.json) in one shot.
//   - `closed[]` entries carry `source: 'v2'|'legacy'`; `desc` holds the
//     v2 title / legacy desc.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isStaffRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');

const MAX_SNAGS = 100;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!(await isFlagEnabled('defects', me))) return res.status(404).json({ error: 'not found' });
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
  const legacySnags = Array.isArray(data.snags) ? data.snags : [];
  const v2Snags = Array.isArray(data.snagsV2) ? data.snagsV2 : [];

  const legacyById = {};
  for (const s of legacySnags) if (s && s.id) legacyById[s.id] = s;
  const v2ById = {};
  for (const s of v2Snags) if (s && s.id) v2ById[s.id] = s;

  const closed = [];
  const failed = [];
  const nowIso = new Date().toISOString();
  const actorName = me.name || me.username || 'Unknown';

  for (const sid of ids) {
    if (!sid) {
      failed.push({ snagId: sid || null, error: 'missing id' });
      continue;
    }

    const v2 = v2ById[sid];
    if (v2) {
      if (v2.status === 'closed') {
        failed.push({ snagId: sid, error: 'already closed' });
        continue;
      }
      if (v2.status === 'rejected') {
        failed.push({ snagId: sid, error: 'rejected — reopen it first' });
        continue;
      }
      // Mirror api/snags.js applyTransition('closed') stamps.
      v2.status = 'closed';
      v2.closedAt = nowIso;
      v2.closedById = me.id;
      v2.closedByName = actorName;
      v2.updatedAt = nowIso;
      if (note) v2.closeNote = note;
      closed.push({ snagId: sid, source: 'v2', desc: v2.title || '' });
      continue;
    }

    const s = legacyById[sid];
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
    closed.push({ snagId: sid, source: 'legacy', desc: s.desc || '' });
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
