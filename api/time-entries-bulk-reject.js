// Bulk reject submitted time-entries.
//
//   POST /api/time-entries-bulk-reject
//        body: { entries: [{ userId, date, reason? }, ...], defaultReason? }
//
// Companion to /api/time-entries-bulk-approve (#74). Rejects up to 50
// submitted entries in one call. Each entry can carry its own reason;
// if missing, `defaultReason` from the top-level body is applied. At
// least one of (per-entry reason | defaultReason) must be present per
// entry — rejected hours always carry a reason so the tradie knows
// what to fix.
//
// Same per-entry semantics as bulk-approve: failures don't block the
// rest, response itemises both lists, fire-and-forget push per
// rejection.
//
// Permissions per entry (same as single endpoint):
//   - admin: any submitted entry
//   - leadingHand: only entries where every allocation hits an
//                  assigned job; LH can't reject another LH
//   - everyone else: 403 up front
//
// Why a new file (not a flag on time-entries-reject.js):
//   Same reasoning as bulk-approve — the single-reject endpoint is on
//   the Phase 07 path being concurrently edited, and forking response
//   shape on a query flag is a merge knot.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canApproveHours, isLeadingHandRole } = require('./_lib/auth');
const { readEntry, writeEntry, appendAudit } = require('./_lib/time-entries');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { buildHoursBulkAuditEntry } = require('./_lib/hours-audit');
const { sendPushToUserId } = require('./_lib/push');

const MAX_ENTRIES = 50;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!canApproveHours(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const body = req.body || {};
  const list = Array.isArray(body.entries) ? body.entries : null;
  if (!list) return res.status(400).json({ error: 'entries array required' });
  if (!list.length) return res.status(400).json({ error: 'entries cannot be empty' });
  if (list.length > MAX_ENTRIES) {
    return res.status(400).json({ error: `too many entries (max ${MAX_ENTRIES})` });
  }
  const defaultReason = body.defaultReason ? String(body.defaultReason).trim() : '';

  // Pre-load users for LH gating.
  let userById = {};
  try {
    const usersData = await readBlob('users.json', { users: [] });
    for (const u of (usersData.users || [])) userById[u.id] = u;
  } catch { /* defensive: LH check will skip lookup */ }

  const myJobs = isLeadingHandRole(me.role)
    ? new Set(me.assignedJobIds || [])
    : null;

  const rejected = [];
  const failed   = [];
  const now = new Date().toISOString();

  for (const ref of list) {
    const userId = ref && ref.userId;
    const date   = ref && ref.date;
    const reason = (ref && ref.reason ? String(ref.reason).trim() : '') || defaultReason;

    if (!userId || !date) {
      failed.push({ userId: userId || null, date: date || null, error: 'userId and date required' });
      continue;
    }
    if (userId === me.id) {
      failed.push({ userId, date, error: 'cannot reject your own hours' });
      continue;
    }
    if (!reason) {
      failed.push({ userId, date, error: 'reason required (per-entry or defaultReason)' });
      continue;
    }

    let entry;
    try { entry = await readEntry(userId, date); }
    catch (e) {
      failed.push({ userId, date, error: 'read failed: ' + (e.message || 'unknown') });
      continue;
    }
    if (!entry) {
      failed.push({ userId, date, error: 'not found' });
      continue;
    }
    if (entry.status !== 'submitted') {
      failed.push({ userId, date, error: 'entry is not submitted (status: ' + entry.status + ')' });
      continue;
    }

    if (isLeadingHandRole(me.role)) {
      const submitter = userById[userId];
      if (!submitter || isLeadingHandRole(submitter.role)) {
        failed.push({ userId, date, error: 'leading hands cannot reject other leading hands' });
        continue;
      }
      const allOnMyJobs = (entry.allocations || []).every(a => a.jobId && myJobs.has(a.jobId));
      if (!allOnMyJobs) {
        failed.push({ userId, date, error: 'one or more allocations are on jobs you do not run' });
        continue;
      }
    }

    const updated = {
      ...entry,
      status: 'rejected',
      rejectedReason: reason,
      rejectedAt: now,      // parity with single reject: powers the 30s undo window
      rejectedBy: me.id,    // and the audit chain (who rejected) — was missing here
      updatedAt: now,
    };
    try {
      await writeEntry(userId, updated);
      await appendAudit(userId, entry.id, 'rejected', me.id, reason);
    } catch (e) {
      if (e && e.code === 'stale_write') {
        // #157: edited concurrently between read and write — report it as a
        // typed, retryable conflict (not a generic failure) so the caller knows.
        failed.push({ userId, date, error: 'conflict — edited while rejecting; retry', code: 'conflict', currentRev: e.currentRev });
      } else {
        failed.push({ userId, date, error: 'write failed: ' + (e.message || 'unknown') });
      }
      continue;
    }
    rejected.push({ userId, date, totalHours: Number(entry.totalHours) || 0, reason });

    // Fire-and-forget push. Same payload as single reject so the tradie's
    // experience is identical regardless of how it was rejected.
    sendPushToUserId(userId, {
      title: 'Hours rejected — needs fix',
      body: `${date} (${Number(entry.totalHours).toFixed(1)} hrs): ${reason}`,
      url: '/phil/my-day?fixDate=' + encodeURIComponent(date),
      tag: 'buhl-hours-rejected-' + date,
    }).catch(() => {});
  }

  // #390: ONE summarising audit-log entry for the whole bulk decision (never N
  // rows — the decided days live in metadata.entries). Best-effort.
  if (rejected.length) {
    appendAuditLog(
      buildHoursBulkAuditEntry({ action: 'hours.bulk_rejected', actor: me, decided: rejected }),
    ).catch(() => {});
  }

  return res.status(200).json({
    rejectedCount: rejected.length,
    failedCount:   failed.length,
    rejected,
    failed,
  });
};
