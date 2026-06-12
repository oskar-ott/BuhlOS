// Approve a submitted time-entry.
// Admin: can approve anyone's. LH: can approve a tradie's entry only if every
// allocation is on a job they're assigned to. LH cannot approve another LH's
// entries (admin-only). Internal/no-job allocations are admin-only.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canApproveHours, isLeadingHandRole } = require('./_lib/auth');
const { readEntry, writeEntry, appendAudit } = require('./_lib/time-entries');
const { notify } = require('./_lib/notify');
const { appendActivity } = require('./_lib/activity');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!canApproveHours(user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { userId, date } = req.body || {};
  if (!userId || !date) return res.status(400).json({ error: 'userId and date required' });
  if (userId === user.id) return res.status(403).json({ error: 'cannot approve your own hours' });

  const entry = await readEntry(userId, date);
  if (!entry) return res.status(404).json({ error: 'not found' });
  if (entry.status !== 'submitted') return res.status(400).json({ error: 'entry is not submitted' });

  // LH gating ─────────────────────────────────────────────────────────
  if (isLeadingHandRole(user.role)) {
    const submitter = await readUser(userId);
    if (!submitter || isLeadingHandRole(submitter.role)) {
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
  try {
    await writeEntry(userId, updated);
  } catch (e) {
    if (e && e.code === 'stale_write') {
      // #157: the day-file changed underneath this decision (concurrent
      // approve/edit). Retryable — the client re-reads and re-decides.
      return res.status(409).json({ error: 'conflict', currentRev: e.currentRev });
    }
    throw e;
  }
  await appendAudit(userId, entry.id, 'approved', user.id);
  // Phase 09 (brief §14): global activity log row. Best-effort —
  // failure here doesn't fail the approval. The per-entry audit
  // above remains the primary record.
  await appendActivity({
    action: 'hours.approved',
    scope:  'hours',
    actor:  user.id,
    actorName: user.username,
    target: `user:${userId}/${entry.date}`,
    targetLabel: `${entry.userName || userId} · ${entry.date}`,
    meta: {
      entryId: entry.id || null,
      totalHours: Number(entry.totalHours) || 0,
      jobIds: (entry.allocations || []).map(a => a.jobId).filter(Boolean),
    },
  });

  // Fire-and-forget push to the tradie, now routed through the platform
  // notify() engine (#162) so the recipient's `hoursApproved` pref is honoured
  // — muting that type suppresses THIS push for THAT user only. Audience +
  // payload are unchanged from the direct sendPushToUserId call. Failures don't
  // affect the response. Lands on Phil My Day — the live field home — where the
  // approved status shows on the week strip + status line.
  // Resolve the recipient's record so notify() can read their notificationPrefs
  // (the LH branch above only loaded it for jobs it runs).
  const recipient = await readUser(userId);
  notify({
    kind: 'hoursApproved',
    audience: [recipient || { id: userId }],
    payload: {
      title: 'Hours approved',
      body: `${Number(entry.totalHours).toFixed(1)} hrs on ${entry.date} approved by ${user.username}.`,
      url: '/phil/my-day',
      tag: 'buhl-hours-approved-' + entry.date,
    },
  }).catch(() => {});

  return res.status(200).json({ entry: updated });
};

async function readUser(userId) {
  const data = await readBlob('users.json', { users: [] });
  return (data.users || []).find(u => u.id === userId) || null;
}
