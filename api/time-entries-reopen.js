// Reopen an already-decided time-entry (admin only).
//
// Use cases: a payroll mistake was approved, OT got mis-classified, or the
// worker forgot a job allocation. Setting status back to 'submitted' or
// 'draft' lets the worker (or admin) fix it and re-submit.
//
// Hard rule: if the entry has been exported (exportId set), reopening is
// blocked unless ?force=1 is passed — exported weeks should not silently
// drift away from the payroll CSV that already went to Karen.
//
// Body: { userId, date, toStatus?: 'submitted' | 'draft', reason?: string, force?: boolean }
// Defaults: toStatus = 'submitted'.

const { setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { readEntry, writeEntry, appendAudit } = require('./_lib/time-entries');
const { sendPushToUserId } = require('./_lib/push');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;

  const { userId, date, toStatus = 'submitted', reason = '', force = false } = req.body || {};
  if (!userId || !date) return res.status(400).json({ error: 'userId and date required' });
  if (!['submitted', 'draft'].includes(toStatus)) {
    return res.status(400).json({ error: 'toStatus must be "submitted" or "draft"' });
  }

  const entry = await readEntry(userId, date);
  if (!entry) return res.status(404).json({ error: 'not found' });

  if (!['approved', 'rejected'].includes(entry.status)) {
    return res.status(400).json({
      error: `cannot reopen entry with status "${entry.status}" — only approved or rejected entries can be reopened`,
    });
  }

  // Guard: don't silently drift away from an already-exported payroll run.
  if (entry.exportId && !force) {
    return res.status(409).json({
      error: 'entry has been exported to payroll',
      exportId: entry.exportId,
      exportedAt: entry.exportedAt,
      hint: 'pass force=true to reopen anyway — but make sure to re-export and notify payroll',
    });
  }

  const now = new Date().toISOString();
  const updated = {
    ...entry,
    status: toStatus,
    // Clear approval/rejection state so the entry looks fresh in the worker's queue.
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectedReason: null,
    reopenedBy: user.id,
    reopenedAt: now,
    reopenReason: reason ? String(reason).slice(0, 500) : null,
    updatedAt: now,
  };

  // If reopening over an exported entry, keep the export stamp visible but
  // mark it as superseded so the next CSV pulls it again.
  if (entry.exportId && force) {
    updated.exportSupersededAt = now;
    updated.exportedAt = null;
    updated.exportId = null;
  }

  await writeEntry(userId, updated);
  await appendAudit(userId, entry.id, 'reopened', user.id, reason || null, {
    fromStatus: entry.status,
    toStatus,
    forcedOverExport: !!(entry.exportId && force),
  });

  // Tell the worker their entry is back on their plate.
  sendPushToUserId(userId, {
    title: 'Hours reopened',
    body: `Your hours for ${date} were reopened by ${user.username}${reason ? ' — ' + reason : '.'}`,
    url: '/my-day',
    tag: 'buhl-hours-reopened-' + date,
  }).catch(() => {});

  return res.status(200).json({ entry: updated });
};
