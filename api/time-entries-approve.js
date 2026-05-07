// Approve a submitted time-entry.
// Admin: can approve anyone's. LH: can approve a tradie's entry only if every
// allocation is on a job they're assigned to. LH cannot approve another LH's
// entries (admin-only). Internal/no-job allocations are admin-only.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { readEntry, writeEntry, appendAudit } = require('./_lib/time-entries');
const { sendPushToUserId } = require('./_lib/push');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!['admin', 'leadingHand'].includes(user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { userId, date } = req.body || {};
  if (!userId || !date) return res.status(400).json({ error: 'userId and date required' });

  const entry = await readEntry(userId, date);
  if (!entry) return res.status(404).json({ error: 'not found' });
  if (entry.status !== 'submitted') return res.status(400).json({ error: 'entry is not submitted' });

  // LH gating ─────────────────────────────────────────────────────────
  if (user.role === 'leadingHand') {
    const submitter = await readUser(userId);
    if (submitter && submitter.role === 'leadingHand') {
      return res.status(403).json({ error: 'leading hands cannot approve other leading hands — admin only' });
    }
    const myJobs = new Set(user.assignedJobIds || []);
    const allOnMyJobs = (entry.allocations || []).every(a => a.jobId && myJobs.has(a.jobId));
    if (!allOnMyJobs) {
      return res.status(403).json({ error: 'you can only approve hours for jobs you run' });
    }
    // (Internal/no-job allocations fail the check above — admin-only.)
  }

  const now = new Date().toISOString();
  const updated = {
    ...entry,
    status: 'approved',
    approvedBy: user.id,
    approvedAt: now,
    rejectedReason: null,
    updatedAt: now,
  };
  await writeEntry(userId, updated);
  await appendAudit(userId, entry.id, 'approved', user.id);

  // Fire-and-forget push to the tradie. Failures don't affect the response.
  sendPushToUserId(userId, {
    title: 'Hours approved',
    body: `${Number(entry.totalHours).toFixed(1)} hrs on ${entry.date} approved by ${user.username}.`,
    url: '/my-day',
    tag: 'buhl-hours-approved-' + entry.date,
  }).catch(() => {});

  return res.status(200).json({ entry: updated });
};

async function readUser(userId) {
  const data = await readBlob('users.json', { users: [] });
  return (data.users || []).find(u => u.id === userId) || null;
}
