// Time-entry CRUD — per-user, per-day, with status workflow + multi-job allocations.
//
//   GET    /api/time-entries                     → my entries (newest first)
//   GET    /api/time-entries?userId=X            → admin/LH viewing someone else
//   GET    /api/time-entries?status=submitted&scope=approver
//                                                → all submitted (admin) or only those
//                                                  with at least one allocation on a job
//                                                  the LH is assigned to
//   POST   /api/time-entries     body: entry     → create draft or submit
//   PATCH  /api/time-entries?date=YYYY-MM-DD     → edit (own draft/rejected, or admin any)
//   DELETE /api/time-entries?date=YYYY-MM-DD     → delete own draft

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const {
  newId,
  validateEntryShape,
  readEntry,
  writeEntry,
  deleteEntry,
  listUserEntries,
  listAllEntriesForApprovers,
  appendAudit,
  diffOf,
} = require('./_lib/time-entries');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return; // requireAuth already wrote 401

  if (req.method === 'GET')    return handleGet(req, res, user);
  if (req.method === 'POST')   return handleCreate(req, res, user);
  if (req.method === 'PATCH')  return handlePatch(req, res, user);
  if (req.method === 'DELETE') return handleDelete(req, res, user);
  return res.status(405).json({ error: 'method not allowed' });
};

async function handleGet(req, res, user) {
  const q = req.query || {};

  // ── Approver scope: walks every user's entries, gates by LH membership ──
  if (q.scope === 'approver') {
    if (!['admin', 'leadingHand'].includes(user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const status = q.status || 'submitted';
    const all = await listAllEntriesForApprovers({ status });
    const enriched = await enrichEntries(all, user);
    const visible = user.role === 'admin'
      ? enriched
      // LH: at least one allocation must be on a job they're assigned to AND submitter must not be another LH
      : enriched.filter(e =>
          e.userRole !== 'leadingHand' &&
          e.allocations.some(a => a._jobLedByMe)
        );
    return res.status(200).json({ entries: visible });
  }

  // ── Otherwise: my entries (or another user's, with admin/LH override) ──
  let targetUserId = user.id;
  if (q.userId && q.userId !== user.id) {
    if (!['admin', 'leadingHand'].includes(user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    targetUserId = q.userId;
  }

  const entries = await listUserEntries(targetUserId, {
    fromDate: q.fromDate,
    toDate:   q.toDate,
    status:   q.status,
  });
  return res.status(200).json({ entries });
}

async function handleCreate(req, res, user) {
  const body = req.body || {};
  const errors = validateEntryShape(body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  if (user.role === 'client') return res.status(403).json({ error: 'clients cannot log hours' });

  // ── On-behalf creation ────────────────────────────────────────────
  // Admin can create on behalf of anyone (except clients).
  // LH can create on behalf of crew that share at least one assigned job.
  // Self-creation is the default.
  let targetUserId  = user.id;
  let targetUserName = user.username;
  let targetUserRole = user.role;
  const overrideUserId = (req.query && req.query.userId) || (body && body.targetUserId) || null;
  let onBehalf = false;
  if (overrideUserId && overrideUserId !== user.id) {
    if (user.role !== 'admin' && user.role !== 'leadingHand') {
      return res.status(403).json({ error: 'forbidden — only admin or leading hand can log on behalf' });
    }
    const usersBlob = await readBlob('users.json', { users: [] });
    const target = (usersBlob.users || []).find(u => u.id === overrideUserId);
    if (!target) return res.status(404).json({ error: 'target user not found' });
    if (target.role === 'client') return res.status(400).json({ error: 'cannot log hours for clients' });
    if (user.role === 'leadingHand') {
      const myJobs = new Set(user.assignedJobIds || []);
      const sharesJob = (target.assignedJobIds || []).some(j => myJobs.has(j));
      if (!sharesJob) return res.status(403).json({ error: 'forbidden — target is not on a job you run' });
    }
    targetUserId   = target.id;
    targetUserName = target.username;
    targetUserRole = target.role;
    onBehalf = true;
  }

  // Refuse if entry for that user+date already exists — caller should PATCH instead
  const existing = await readEntry(targetUserId, body.date);
  if (existing) return res.status(409).json({ error: 'entry already exists for that date — edit it instead' });

  const now = new Date().toISOString();
  const entry = {
    id: newId(),
    userId: targetUserId,
    userName: targetUserName,
    userRole: targetUserRole,
    date: body.date,
    startTime: body.startTime || null,
    endTime: body.endTime || null,
    breakMinutes: body.breakMinutes ?? 30,
    totalHours: body.totalHours,
    ordinaryHours: body.ordinaryHours,
    overtimeHours: body.overtimeHours,
    otOverridden: !!body.otOverridden,
    notes: body.notes || null,
    status: body.status === 'submitted' ? 'submitted' : 'draft',
    submittedAt: body.status === 'submitted' ? now : null,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    allocations: body.allocations.map((a, i) => ({
      jobId: a.jobId || null,
      hours: Number(a.hours),
      notes: a.notes || null,
      sortOrder: i,
    })),
    createdAt: now,
    updatedAt: now,
  };

  await writeEntry(targetUserId, entry);
  const auditAction = entry.status === 'submitted' ? 'submitted' : 'created';
  const auditNote = onBehalf ? `${auditAction} on behalf by ${user.username}` : null;
  await appendAudit(targetUserId, entry.id, auditAction, user.id, auditNote);

  return res.status(201).json({ entry });
}

async function handlePatch(req, res, user) {
  const date = (req.query && req.query.date) || '';
  if (!date) return res.status(400).json({ error: 'date query param required' });

  const body = req.body || {};
  const targetUserId = (req.query && req.query.userId) || user.id;

  // Only admin can edit someone else's entry
  if (targetUserId !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const existing = await readEntry(targetUserId, date);
  if (!existing) return res.status(404).json({ error: 'not found' });

  // Ownership / status gates
  if (existing.userId !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (existing.status === 'approved' && user.role !== 'admin') {
    return res.status(403).json({ error: 'cannot edit approved entry — ask admin' });
  }

  // Build merged shape and validate
  const merged = {
    ...existing,
    ...body,
    allocations: body.allocations || existing.allocations,
  };
  const errors = validateEntryShape(merged);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const now = new Date().toISOString();
  const wasRejected = existing.status === 'rejected';
  const transitioningToSubmitted = body.status === 'submitted' && existing.status !== 'submitted';

  const updated = {
    ...existing,
    ...body,
    // Preserve immutable fields
    id: existing.id,
    userId: existing.userId,
    userName: existing.userName,
    userRole: existing.userRole,
    createdAt: existing.createdAt,
    updatedAt: now,
    submittedAt: transitioningToSubmitted ? now : existing.submittedAt,
    rejectedReason: wasRejected && body.status === 'submitted' ? null : existing.rejectedReason,
    allocations: (body.allocations || existing.allocations).map((a, i) => ({
      jobId: a.jobId || null,
      hours: Number(a.hours),
      notes: a.notes || null,
      sortOrder: i,
    })),
  };

  await writeEntry(targetUserId, updated);
  await appendAudit(
    targetUserId,
    updated.id,
    transitioningToSubmitted ? 'submitted' : 'edited',
    user.id,
    null,
    diffOf(existing, updated)
  );

  return res.status(200).json({ entry: updated });
}

async function handleDelete(req, res, user) {
  const date = (req.query && req.query.date) || '';
  if (!date) return res.status(400).json({ error: 'date query param required' });

  const targetUserId = (req.query && req.query.userId) || user.id;
  if (targetUserId !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const existing = await readEntry(targetUserId, date);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.status !== 'draft' && user.role !== 'admin') {
    return res.status(400).json({ error: 'only drafts can be deleted' });
  }

  await deleteEntry(targetUserId, date);
  await appendAudit(targetUserId, existing.id, 'deleted', user.id);
  return res.status(204).end();
}

// Enrich an entry list with user names + per-allocation job info + LH-leadership flag.
// Done in a single users.json + jobs.json read regardless of N entries.
async function enrichEntries(entries, viewer) {
  const users = await readBlob('users.json', { users: [] });
  const jobs  = await readBlob('jobs.json',  { jobs: [] });
  const userById = {};
  (users.users || []).forEach(u => { userById[u.id] = u; });
  const jobById = {};
  (jobs.jobs || []).forEach(j => { jobById[j.id] = j; });

  const viewerJobs = new Set(viewer.assignedJobIds || []);

  return entries.map(e => {
    const submitter = userById[e.userId];
    return {
      ...e,
      userName: e.userName || (submitter && submitter.username) || e.userId,
      userRole: e.userRole || (submitter && submitter.role) || null,
      allocations: (e.allocations || []).map(a => {
        const job = a.jobId ? jobById[a.jobId] : null;
        return {
          ...a,
          jobName: job ? job.name : null,
          // For LH view: every allocation's job must be one this LH is assigned to.
          // (Internal/no-job allocations require admin approval — represented as false.)
          _jobLedByMe: viewer.role === 'leadingHand'
            ? !!(a.jobId && viewerJobs.has(a.jobId))
            : true,
        };
      }),
    };
  });
}
