// Scheduled blob backup — daily snapshot + retention pruning (#151).
//
//   GET /api/backup-snapshot?action=run    → snapshot every canonical JSON
//                                            store to backups/<date>/… then
//                                            prune per the retention rule
//   GET /api/backup-snapshot?action=list   → snapshot dates currently held
//
// Auth: the Vercel cron calls with CRON_SECRET (Bearer or x-cron-secret).
// DELIBERATELY STRICTER than cash-watch's helper: a missing CRON_SECRET does
// NOT open the endpoint — pruning deletes data, so without a configured
// secret every call must authenticate as an admin-tier user instead.
//
// Failure visibility (per the issue's AC): any copy failure → HTTP 500 so the
// Vercel cron run shows red, and every run (good or bad) writes a
// backup.completed audit entry with the counts in metadata.
//
// Restore is intentionally NOT exposed over HTTP — it lives in
// scripts/backup-restore.js, in the hands of whoever holds the blob token.
// Runbook: docs/backups.md.

const { setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { append: appendAuditLog } = require('./_lib/audit-log');
const {
  runSnapshot,
  pruneSnapshots,
  listSnapshotDates,
  todayStamp,
} = require('./_lib/backup');

function cronAuthorised(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // no secret configured → admin auth required
  const hdr = (req.headers && req.headers['authorization']) || '';
  if (hdr === `Bearer ${expected}`) return true;
  if (((req.headers && req.headers['x-cron-secret']) || '') === expected) return true;
  return false;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const action = (req.query && req.query.action) || '';

  let me = null;
  if (!cronAuthorised(req)) {
    me = await requireAuth(req, res, { roles: ['admin'] });
    if (!me) return;
  }

  if (action === 'list') {
    try {
      const dates = await listSnapshotDates();
      return res.status(200).json({ dates });
    } catch (e) {
      return res.status(502).json({ error: 'list failed: ' + (e.message || 'unknown') });
    }
  }

  if (action !== 'run') return res.status(400).json({ error: 'unknown action' });

  const date = todayStamp();
  let snapshot = null;
  let prune = null;
  let fatal = null;

  try {
    snapshot = await runSnapshot({ date });
    prune = await pruneSnapshots();
  } catch (e) {
    fatal = (e && e.message) || 'backup failed';
  }

  const ok = !fatal && snapshot && snapshot.failed.length === 0;

  // Every run leaves an audit trail — success or failure — so a quiet cron
  // can't hide a broken backup. Best-effort: audit failure never masks the
  // run result.
  await appendAuditLog({
    action: 'backup.completed',
    actorId: me ? me.id : 'cron',
    actorName: me ? me.name || me.username || 'admin' : 'cron',
    actorRole: me ? me.role || null : 'system',
    jobId: null,
    targetType: 'system',
    targetId: `backup-${date}`,
    summary: ok
      ? `backup ${date} — ${snapshot.copied} documents snapshotted, ${prune.pruned.length} old dates pruned`
      : `backup ${date} FAILED — ${fatal || `${snapshot.failed.length} copy failures`}`,
    metadata: {
      ok,
      date,
      targets: snapshot ? snapshot.targets : 0,
      copied: snapshot ? snapshot.copied : 0,
      failedCount: snapshot ? snapshot.failed.length : 0,
      failedSample: snapshot ? snapshot.failed.slice(0, 5) : [],
      prunedDates: prune ? prune.pruned : [],
      deletedBlobs: prune ? prune.deletedBlobs : 0,
      durationMs: snapshot ? snapshot.durationMs : null,
      fatal,
    },
  }).catch(() => null);

  if (!ok) {
    return res.status(500).json({
      ok: false,
      date,
      fatal,
      snapshot,
      prune,
    });
  }
  return res.status(200).json({ ok: true, date, snapshot, prune });
};
