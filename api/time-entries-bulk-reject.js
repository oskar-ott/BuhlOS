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
// rejection. Days are decided in PARALLEL (same lanes + per-worker audit
// batching as bulk-approve, 2026-10-15) — a five-day send-back used to be
// five serial store round trips inside the one request.
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
const { readEntryVerified, writeEntry, appendAuditMany } = require('./_lib/time-entries');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { buildHoursBulkAuditEntry } = require('./_lib/hours-audit');
const { sendPushToUserId } = require('./_lib/push');

const MAX_ENTRIES = 50;

// How many days are decided at once — the same bound as bulk-approve, so one
// request never fans out 50 store calls.
const CONCURRENCY = 6;

/** Run fn over items, at most `limit` at a time; results in input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/**
 * Decide ONE day: { rejected, audit } or { failed }. Never throws — a failure
 * on one day never blocks the others. Mirrors approveOne in bulk-approve.
 */
async function rejectOne({ userId, date, reason, me, userById, myJobs }) {
  if (!userId || !date) {
    return { failed: { userId: userId || null, date: date || null, error: 'userId and date required' } };
  }
  if (userId === me.id) {
    return { failed: { userId, date, error: 'cannot reject your own hours' } };
  }
  if (!reason) {
    return { failed: { userId, date, error: 'reason required (per-entry or defaultReason)' } };
  }

  let entry;
  // Decide on a version PROVEN current (never a stale CDN copy), and use
  // it as the CAS baseline for the write below.
  try { entry = await readEntryVerified(userId, date); }
  catch (e) {
    if (e && e.code === 'stale_write') {
      // The day changed moments ago and its new version couldn't be
      // confirmed yet — retryable, like a conflict; never decided on.
      return { failed: { userId, date, error: 'changed moments ago — try again in a minute', code: 'conflict' } };
    }
    return { failed: { userId, date, error: 'read failed: ' + (e.message || 'unknown') } };
  }
  if (!entry) {
    return { failed: { userId, date, error: 'not found' } };
  }
  if (entry.status !== 'submitted') {
    return { failed: { userId, date, error: 'entry is not submitted (status: ' + entry.status + ')' } };
  }

  if (myJobs) {
    const submitter = userById[userId];
    if (!submitter || isLeadingHandRole(submitter.role)) {
      return { failed: { userId, date, error: 'leading hands cannot reject other leading hands' } };
    }
    const allOnMyJobs = (entry.allocations || []).every(a => a.jobId && myJobs.has(a.jobId));
    if (!allOnMyJobs) {
      return { failed: { userId, date, error: 'one or more allocations are on jobs you do not run' } };
    }
  }

  // Per entry, immediately before its own write — see the note in
  // time-entries-bulk-approve.js: a batch-wide stamp drifts behind the
  // writes and trips the payroll freshness guard permanently. It also makes
  // each undo window start when THAT entry was rejected.
  const now = new Date().toISOString();
  const updated = {
    ...entry,
    status: 'rejected',
    rejectedReason: reason,
    rejectedAt: now,      // parity with single reject: powers the 30s undo window
    rejectedBy: me.id,    // and the audit chain (who rejected)
    updatedAt: now,
  };
  try {
    await writeEntry(userId, updated, { basedOn: entry });
  } catch (e) {
    if (e && e.code === 'stale_write') {
      // #157: edited concurrently between read and write — report it as a
      // typed, retryable conflict (not a generic failure) so the caller knows.
      return { failed: { userId, date, error: 'conflict — edited while rejecting; retry', code: 'conflict', currentRev: e.currentRev } };
    }
    return { failed: { userId, date, error: 'write failed: ' + (e.message || 'unknown') } };
  }
  return {
    rejected: { userId, date, totalHours: Number(entry.totalHours) || 0, reason },
    audit: { entryId: entry.id, action: 'rejected', changedBy: me.id, note: reason, at: now },
  };
}

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

  // A duplicate {userId, date} is decided once — two parallel writes to the
  // same day-file would race (same rule as bulk-approve).
  const seen = new Set();
  const work = [];
  for (const ref of list) {
    const userId = ref && ref.userId;
    const date   = ref && ref.date;
    const reason = (ref && ref.reason ? String(ref.reason).trim() : '') || defaultReason;
    const key = userId && date ? userId + '|' + date : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    work.push({ userId, date, reason });
  }

  const outcomes = await mapLimit(work, CONCURRENCY, ({ userId, date, reason }) =>
    rejectOne({ userId, date, reason, me, userById, myJobs }),
  );

  const rejected = [];
  const failed   = [];
  const auditByUser = new Map();
  for (const o of outcomes) {
    if (o.failed) { failed.push(o.failed); continue; }
    rejected.push(o.rejected);
    if (!auditByUser.has(o.rejected.userId)) auditByUser.set(o.rejected.userId, []);
    auditByUser.get(o.rejected.userId).push(o.audit);
  }

  // One append per worker (their audit file — a read-modify-write that
  // parallel writers would corrupt), workers in parallel. Best-effort, like
  // every audit append: the rejections above have landed whatever happens.
  await Promise.all(
    [...auditByUser].map(([userId, rows]) => appendAuditMany(userId, rows)),
  );

  for (const r of rejected) {
    // Fire-and-forget push. Same payload as single reject so the tradie's
    // experience is identical regardless of how it was rejected.
    sendPushToUserId(r.userId, {
      title: 'Hours rejected — needs fix',
      body: `${r.date} (${Number(r.totalHours).toFixed(1)} hrs): ${r.reason}`,
      url: '/phil/my-day?fixDate=' + encodeURIComponent(r.date),
      tag: 'buhl-hours-rejected-' + r.date,
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
