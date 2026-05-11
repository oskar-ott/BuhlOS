// Reject a submitted time-entry with a required reason.
// Same gating as approve: admin always; LH only on jobs they're assigned to,
// and never against another LH's submission.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { readEntry, writeEntry, appendAudit } = require('./_lib/time-entries');
const { sendPushToUserId } = require('./_lib/push');
const { appendActivity } = require('./_lib/activity');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!['admin', 'leadingHand'].includes(user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { userId, date, reason } = req.body || {};
  if (!userId || !date) return res.status(400).json({ error: 'userId and date required' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason required' });

  const entry = await readEntry(userId, date);
  if (!entry) return res.status(404).json({ error: 'not found' });
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
