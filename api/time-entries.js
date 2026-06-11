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
const { requireAuth, isStaffRole, isAdminRole, isLeadingHandRole, isFieldRole, canSubmitHours } = require('./_lib/auth');
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
    if (!isStaffRole(user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const status = q.status || 'submitted';
    const all = await listAllEntriesForApprovers({ status });
    const enriched = await enrichEntries(all, user);
    const visible = isAdminRole(user.role)
      ? enriched
      // LH (any alias): at least one allocation must be on a job they're assigned
      // to AND the submitter must not be another LH. Admin TIER sees the full queue.
      : enriched.filter(e =>
          !isLeadingHandRole(e.userRole) &&
          e.allocations.some(a => a._jobLedByMe)
        );
    return res.status(200).json({ entries: visible });
  }

  // ── Otherwise: my entries (or another user's, with admin/LH override) ──
  let targetUserId = user.id;
  if (q.userId && q.userId !== user.id) {
    if (!isStaffRole(user.role)) {
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

  const overrideUserId = (req.query && req.query.userId) || (body && body.targetUserId) || null;
  const isOnBehalfRequest = overrideUserId && overrideUserId !== user.id;
  if (!isOnBehalfRequest && !canSubmitHours(user.role)) {
    return res.status(403).json({ error: 'forbidden — this role cannot log hours' });
  }

  // ── On-behalf creation ────────────────────────────────────────────
  // Admin can create on behalf of anyone (except clients).
  // LH can create on behalf of crew that share at least one assigned job.
  // Self-creation is the default.
  let targetUserId  = user.id;
  let targetUserName = user.username;
  let targetUserRole = user.role;
  let onBehalf = false;
  if (overrideUserId && overrideUserId !== user.id) {
    if (!isStaffRole(user.role)) {
      return res.status(403).json({ error: 'forbidden — only staff (admin tier or leading hand) can log on behalf' });
    }
    const usersBlob = await readBlob('users.json', { users: [] });
    const target = (usersBlob.users || []).find(u => u.id === overrideUserId);
    if (!target) return res.status(404).json({ error: 'target user not found' });
    if (!canSubmitHours(target.role)) return res.status(400).json({ error: 'cannot log hours for this role' });
    if (isLeadingHandRole(user.role)) {
      const myJobs = new Set(user.assignedJobIds || []);
      const sharesJob = (target.assignedJobIds || []).some(j => myJobs.has(j));
      if (!sharesJob) return res.status(403).json({ error: 'forbidden — target is not on a job you run' });
    }
    targetUserId   = target.id;
    targetUserName = target.username;
    targetUserRole = target.role;
    onBehalf = true;
  }

  // ── Job attribution integrity (field self-submissions) ──────────────
  // A field worker logging their OWN hours may only attribute a non-null
  // allocation jobId to a job they are assigned to that is active (not draft
  // or archived). This closes the field-readiness gap where the create path
  // accepted any/arbitrary/unassigned/archived jobId with no check.
  //
  // Deliberately narrow: admin/LH and on-behalf flows keep their existing
  // latitude, and a null jobId is still accepted here for backward
  // compatibility (legacy submissions, overhead). The Phil UI is what blocks
  // a null jobId when the worker has active assigned jobs; a server-side
  // null-block for field roles is a documented follow-up.
  if (!onBehalf && isFieldRole(user.role)) {
    const gateError = await fieldAllocationGateError(user, body.allocations);
    if (gateError) return res.status(403).json({ error: gateError });
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
    // Delegated-entry fields. Per the LH-on-behalf brief, hours BELONG
    // to the worker (userId) but the system must record who entered them
    // so the tradie's My Day can show "Entered by Jack" and admin
    // payroll review can verify the chain of custody. `source` is the
    // role of the actor at write time so we can split self-entries from
    // delegated ones in analytics later.
    enteredByUserId: onBehalf ? user.id : targetUserId,
    enteredByName:   onBehalf ? user.username : targetUserName,
    source:          onBehalf ? user.role : 'self',
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

  // Permission: self-edit OR admin OR LH editing crew on a shared job.
  // The LH path is gated below (after we read the target + the existing
  // entry) so we can compare against the LH's assigned jobs.
  const isSelf  = (targetUserId === user.id);
  const isAdmin = isAdminRole(user.role);
  const isLH    = isLeadingHandRole(user.role);
  if (isSelf && !canSubmitHours(user.role)) {
    return res.status(403).json({ error: 'forbidden — this role cannot edit hours' });
  }
  if (!isSelf && !isAdmin && !isLH) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Approval transitions MUST go through dedicated endpoints. PATCH supports
  // only the narrow draft/rejected -> submitted workflow used when a worker
  // edits and submits or fixes rejected hours.
  if (body.status === 'approved' || body.status === 'rejected') {
    return res.status(403).json({
      error: 'use the approve/reject endpoints to change approval status',
    });
  }

  const existing = await readEntry(targetUserId, date);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const requestedStatus = body.status;
  const transitioningToSubmitted =
    requestedStatus === 'submitted' &&
    (existing.status === 'draft' || existing.status === 'rejected');
  if (
    requestedStatus !== undefined &&
    requestedStatus !== existing.status &&
    !transitioningToSubmitted
  ) {
    return res.status(403).json({
      error: 'status can only change to submitted after editing draft or rejected hours',
    });
  }

  // LH gate — must share at least one assigned job with the target worker.
  // We read the target's own assignedJobIds (not just the entry's
  // allocations) because an LH may need to correct hours that the tradie
  // misallocated to the wrong job.
  let isDelegated = false;   // is this LH/admin editing someone else's entry?
  if (!isSelf) {
    const usersBlob = await readBlob('users.json', { users: [] });
    const target = (usersBlob.users || []).find(u => u.id === targetUserId);
    if (!target) return res.status(404).json({ error: 'target user not found' });
    if (!canSubmitHours(target.role)) return res.status(400).json({ error: 'cannot edit hours for this role' });
    if (isLH) {
      const myJobs = new Set(user.assignedJobIds || []);
      const sharesJob = (target.assignedJobIds || []).some(j => myJobs.has(j));
      if (!sharesJob) return res.status(403).json({ error: 'forbidden — target is not on a job you run' });
    }
    isDelegated = true;
  }

  // Status gates — preserves payroll chain of custody. Only admin can
  // edit approved or exported entries; everyone else (including LH and
  // the worker themselves) gets a clear error so they ask admin to
  // reopen first.
  if (existing.status === 'approved' && !isAdmin) {
    return res.status(403).json({ error: 'cannot edit approved entry — ask admin to reopen it' });
  }
  if (existing.exportId && !isAdmin) {
    return res.status(403).json({ error: 'cannot edit entry already exported to payroll — ask admin to reopen it' });
  }

  // ── Job attribution integrity (field self-edits) ────────────────────
  // Parity with handleCreate: a field worker re-allocating their OWN hours
  // (the rejected→submitted fix path, or a draft edit) can only point them at
  // an active job they are assigned to. Until now the Phil UI was the sole
  // guard on this path. Scoped to PATCHes that actually send `allocations`, so
  // a notes-only edit of an entry whose job has since been archived still
  // works; delegated (admin/LH) edits keep their existing latitude; a null
  // jobId stays accepted for backward compatibility, exactly like create.
  if (isSelf && isFieldRole(user.role) && body.allocations !== undefined) {
    const gateError = await fieldAllocationGateError(user, body.allocations);
    if (gateError) return res.status(403).json({ error: gateError });
  }

  // Build merged shape from an explicit allowlist. Generic PATCH must not
  // spread caller-controlled metadata into payroll, approval or audit fields.
  const editable = editableEntryPatch(body);
  const nextStatus = transitioningToSubmitted ? 'submitted' : existing.status;
  const merged = {
    ...existing,
    ...editable,
    status: nextStatus,
    allocations: editable.allocations || existing.allocations,
  };
  const errors = validateEntryShape(merged);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const now = new Date().toISOString();
  const wasRejected = existing.status === 'rejected';

  const updated = {
    ...existing,
    ...editable,
    // Preserve immutable fields
    id: existing.id,
    userId: existing.userId,
    userName: existing.userName,
    userRole: existing.userRole,
    createdAt: existing.createdAt,
    updatedAt: now,
    status: nextStatus,
    submittedAt: transitioningToSubmitted ? now : existing.submittedAt,
    rejectedReason: wasRejected && transitioningToSubmitted ? null : existing.rejectedReason,
    // If a non-self user (LH or admin) is editing, refresh the
    // delegated-entry fields so the tradie's My Day reflects the latest
    // person who touched it. We never overwrite the original
    // enteredByUserId on a SELF edit — preserves the audit chain
    // (entry was originally created on-behalf by Jack, even if Sam
    // later edited the totals themselves).
    enteredByUserId: isDelegated
      ? user.id
      : (existing.enteredByUserId || existing.userId),
    enteredByName:   isDelegated
      ? user.username
      : (existing.enteredByName   || existing.userName),
    source: isDelegated
      ? user.role
      : (existing.source || 'self'),
    // Track the most-recent updater independently so admin payroll
    // review can see "last touched by" without losing the original
    // entered-by attribution.
    updatedBy:       user.id,
    updatedByName:   user.username,
    allocations: (editable.allocations || existing.allocations).map((a, i) => ({
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

/**
 * Shared field-attribution gate (create + self-edit paths). Returns an error
 * message when any non-null allocation jobId is not an ACTIVE job in the
 * worker's assignedJobIds, else null. Null jobIds pass (legacy/overhead
 * entries) — blocking new nulls stays a UI rule for now.
 */
async function fieldAllocationGateError(user, allocations) {
  const allocJobIds = [...new Set(
    (allocations || []).map((a) => a.jobId).filter(Boolean)
  )];
  if (!allocJobIds.length) return null;
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const jobById = {};
  (jobsBlob.jobs || []).forEach((j) => { jobById[j.id] = j; });
  const assigned = new Set(user.assignedJobIds || []);
  for (const jid of allocJobIds) {
    const job = jobById[jid];
    const activeForField = job && job.status !== 'archived' && job.status !== 'draft';
    if (!job || !assigned.has(jid) || !activeForField) {
      return 'forbidden — hours can only be logged against an active job you are assigned to';
    }
  }
  return null;
}

function editableEntryPatch(body) {
  const patch = {};
  for (const field of [
    'startTime',
    'endTime',
    'breakMinutes',
    'totalHours',
    'ordinaryHours',
    'overtimeHours',
    'otOverridden',
    'notes',
    'allocations',
  ]) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  return patch;
}

async function handleDelete(req, res, user) {
  const date = (req.query && req.query.date) || '';
  if (!date) return res.status(400).json({ error: 'date query param required' });

  const targetUserId = (req.query && req.query.userId) || user.id;
  if (targetUserId !== user.id && !isAdminRole(user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const existing = await readEntry(targetUserId, date);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.status !== 'draft' && !isAdminRole(user.role)) {
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
          _jobLedByMe: isLeadingHandRole(viewer.role)
            ? !!(a.jobId && viewerJobs.has(a.jobId))
            : true,
        };
      }),
    };
  });
}
