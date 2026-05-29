// Reject a submitted time-entry with a required reason.
// Same gating as approve: admin always; LH only on jobs they're assigned to,
// and never against another LH's submission.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isStaffRole } = require('./_lib/auth');
const { readEntry, writeEntry, appendAudit } = require('./_lib/time-entries');
const { sendPushToUserId } = require('./_lib/push');
const { appendActivity } = require('./_lib/activity');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!isStaffRole(user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { userId, date, reason } = req.body || {};
  // ?undo=1 reverses a recent rejection. Requires:
  //   - entry currently 'rejected'
  //   - rejectedAt within the last 30 seconds
  //   - same actor that did the reject
  // (Brief §09 follow-up — safety net for accidental hits.)
  const isUndo = req.query && (req.query.undo === '1' || req.query.undo === 'true');
  if (!userId || !date) return res.status(400).json({ error: 'userId and date required' });
  if (!isUndo && (!reason || !String(reason).trim())) return res.status(400).json({ error: 'reason required' });

  const entry = await readEntry(userId, date);
  if (!entry) return res.status(404).json({ error: 'not found' });

  if (isUndo) {
    if (entry.status !== 'rejected') return res.status(400).json({ error: 'entry is not rejected — nothing to undo' });
    const rejectedAt = entry.rejectedAt ? Date.parse(entry.rejectedAt) : NaN;
    if (!Number.isFinite(rejectedAt)) return res.status(400).json({ error: 'no rejectedAt stamp — undo window expired' });
    const ageMs = Date.now() - rejectedAt;
    if (ageMs > 30 * 1000) return res.status(400).json({ error: 'undo window expired (30s)' });
    if (entry.rejectedBy && entry.rejectedBy !== user.id) {
      return res.status(403).json({ error: 'only the admin who rejected can undo' });
    }
    const nowIso = new Date().toISOString();
    const reverted = { ...entry, status: 'submitted', updatedAt: nowIso };
    delete reverted.rejectedReason;
    delete reverted.rejectedAt;
    delete reverted.rejectedBy;
    await writeEntry(userId, reverted);
    await appendAudit(userId, entry.id, 'reject-undone', user.id, null);
    await appendActivity({
      action: 'hours.reject-undone',
      scope:  'hours',
      actor:  user.id,
      actorName: user.username,
      target: `user:${userId}/${entry.date}`,
      targetLabel: `${entry.userName || userId} · ${entry.date}`,
      meta: {
        entryId: entry.id || null,
        totalHours: Number(entry.totalHours) || 0,
      },
    });
    return res.status(200).json({ entry: reverted });
  }

  if (entry.status !== 'submitted') return res.status(400).json({ error: 'entry is not submitted' });

  if (user.role === 'leadingHand') {
    const submitter = await readUser(userId);
    if (submitter && submitter.role === 'leadingHand') {
      return res.status(403).json({ error: 'leading hands cannot act on other leading hands — admin only' });
    }
    const myJobs = new Set(user.assignedJobIds || []);
    const allOnMyJobs = (entry.allocations || []).every(a => a.jobId && myJobs.has(a.jobId));
    if (!allOnMyJobs) {
      return res.status(403).json({ error: 'you can only reject hours for jobs you run' });
    }
  }

  const now = new Date().toISOString();
  const trimmedReason = String(reason).trim();
  const updated = {
    ...entry,
    status: 'rejected',
    rejectedReason: trimmedReason,
    rejectedAt: now,           // for the 30s undo window
    rejectedBy: user.id,
    updatedAt: now,
  };
  await writeEntry(userId, updated);
  await appendAudit(userId, entry.id, 'rejected', user.id, trimmedReason);
  // Phase 09 (brief §14): rejection event.
  await appendActivity({
    action: 'hours.rejected',
    scope:  'hours',
    actor:  user.id,
    actorName: user.username,
    target: `user:${userId}/${entry.date}`,
    targetLabel: `${entry.userName || userId} · ${entry.date}`,
    reason: trimmedReason,
    meta: {
      entryId: entry.id || null,
      totalHours: Number(entry.totalHours) || 0,
      jobIds: (entry.allocations || []).map(a => a.jobId).filter(Boolean),
    },
  });

  // Fire-and-forget push to the tradie with the rejection reason inline so
  // they don't have to open the app to find out why. ?fixDate=<iso> deep-links
  // to /my-day with BuhlLogHours auto-opened on that date — fix-and-resubmit
  // is one tap from the notification.
  sendPushToUserId(userId, {
    title: 'Hours rejected — needs fix',
    body: `${entry.date} (${Number(entry.totalHours).toFixed(1)} hrs): ${trimmedReason}`,
    url: '/my-day?fixDate=' + encodeURIComponent(entry.date),
    tag: 'buhl-hours-rejected-' + entry.date,
  }).catch(() => {});

  return res.status(200).json({ entry: updated });
};

async function readUser(userId) {
  const data = await readBlob('users.json', { users: [] });
  return (data.users || []).find(u => u.id === userId) || null;
}
