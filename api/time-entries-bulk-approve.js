// Bulk approve submitted time-entries.
//
//   POST /api/time-entries-bulk-approve
//        body: { entries: [{ userId, date }, ...] }
//
// Approves up to 50 entries in one request. Each entry is processed
// independently — a failure on one (404, wrong status, LH-permission)
// doesn't block the others. Response itemises which approved and which
// didn't, so the front-end can re-render the inbox.
//
// Why this exists:
//   The single-approve endpoint takes one click → one request. When
//   Daniel sits down on Friday with twelve pending hours entries, that's
//   twelve sequential HTTP round-trips and a UI that flickers as each
//   row removes. Bulk approve collapses that to one call.
//
// Permissions per entry (same as the single endpoint):
//   - admin: any submitted entry — the Admin / Owner even their own
//            (canApproveOwnHours); the rest of the office never their own
//   - leadingHand: only entries where every allocation hits a job they
//                  run; LHs can't approve other LHs (admin-only)
//   - everyone else: 403 up front
//
// Why a new file (not a flag on the existing endpoint):
//   The existing endpoint reads a single { userId, date } from the body.
//   Adding a bulk path inline would have to fork response shape on a
//   query flag, and the single-entry version is currently being touched
//   by the pending Phase 07 work — a separate file avoids a merge knot.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canApproveHours, canApproveOwnHours, isLeadingHandRole } = require('./_lib/auth');
const { readEntryVerified, writeEntry, appendAuditMany } = require('./_lib/time-entries');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { buildHoursBulkAuditEntry } = require('./_lib/hours-audit');
const { notify } = require('./_lib/notify');

const MAX_ENTRIES = 50;

// How many days are decided at once. A week is at most 7; "Approve all clean"
// can send up to 50 — bounded so one request never fans out 50 store calls.
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
 * Decide ONE day: { approved, audit } or { failed }. Never throws — a failure
 * on one day never blocks the others.
 */
async function approveOne({ userId, date, me, userById, myJobs }) {
  if (!userId || !date) {
    return { failed: { userId: userId || null, date: date || null, error: 'userId and date required' } };
  }
  if (userId === me.id && !canApproveOwnHours(me.role)) {
    return { failed: { userId, date, error: 'cannot approve your own hours' } };
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

  // LH gating — same rules as the single endpoint.
  if (myJobs) {
    const submitter = userById[userId];
    if (!submitter || isLeadingHandRole(submitter.role)) {
      return { failed: { userId, date, error: 'leading hands cannot approve other leading hands' } };
    }
    const allOnMyJobs = (entry.allocations || []).every(a => a.jobId && myJobs.has(a.jobId));
    if (!allOnMyJobs) {
      return { failed: { userId, date, error: 'one or more allocations are on jobs you do not run' } };
    }
  }

  // Stamped PER ENTRY, immediately before its own write — never once for the
  // whole batch (2026-09-21: a batch-wide stamp hoisted over a slow loop left
  // the tail of the batch with a stamp a minute behind its own PUT, and the
  // payroll freshness guard refused the run for good). Still true in
  // parallel: each day stamps itself right before its own put.
  const now = new Date().toISOString();
  const updated = {
    ...entry,
    status: 'approved',
    approvedBy: me.id,
    approvedAt: now,
    rejectedReason: null,
    updatedAt: now,
  };
  try {
    await writeEntry(userId, updated, { basedOn: entry });
  } catch (e) {
    if (e && e.code === 'stale_write') {
      // #157: edited concurrently between read and write — report it as a
      // typed, retryable conflict (not a generic failure) so the caller knows.
      return { failed: { userId, date, error: 'conflict — edited while approving; retry', code: 'conflict', currentRev: e.currentRev } };
    }
    return { failed: { userId, date, error: 'write failed: ' + (e.message || 'unknown') } };
  }
  return {
    approved: { userId, date, totalHours: Number(entry.totalHours) || 0 },
    audit: { entryId: entry.id, action: 'approved', changedBy: me.id, at: now },
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

  const list = Array.isArray(req.body && req.body.entries) ? req.body.entries : null;
  if (!list) return res.status(400).json({ error: 'entries array required' });
  if (!list.length) return res.status(400).json({ error: 'entries cannot be empty' });
  if (list.length > MAX_ENTRIES) {
    return res.status(400).json({ error: `too many entries (max ${MAX_ENTRIES})` });
  }

  // Pre-load users so we can look up submitter roles without re-reading
  // for every iteration (LH-cannot-approve-LH check).
  let userById = {};
  try {
    const usersData = await readBlob('users.json', { users: [] });
    for (const u of (usersData.users || [])) userById[u.id] = u;
  } catch { /* fall through; LH check will defensively skip the lookup */ }

  const myJobs = isLeadingHandRole(me.role)
    ? new Set(me.assignedJobIds || [])
    : null;

  // PARALLEL per day (2026-10-12, owner: "seems unnecessary" — one person's
  // week took 11s at best and over a minute at worst on the last two pay runs,
  // measured from the stored approvedAt stamps: ~2.6s per day on 5 Oct, ~16s
  // per day for four of the crew on 28 Sep, each day waiting for the one
  // before). Every day is its own day-file with its own verified read and
  // compare-and-swap, so days never step on each other. The one thing they
  // DID share is the worker's audit file (users/<id>/time-entries-audit/
  // <yyyy-mm>.json, a read-modify-write) — appending to it from parallel
  // writers would lose rows, which is why this loop used to be sequential.
  // Those rows are now collected and appended ONCE per worker after the
  // writes (appendAuditMany). A duplicate {userId, date} in the list is
  // decided once — two parallel writes to the same day-file would race.
  const seen = new Set();
  const work = [];
  for (const ref of list) {
    const userId = ref && ref.userId;
    const date   = ref && ref.date;
    const key = userId && date ? userId + '|' + date : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    work.push({ userId, date });
  }

  const outcomes = await mapLimit(work, CONCURRENCY, ({ userId, date }) =>
    approveOne({ userId, date, me, userById, myJobs }),
  );

  const approved = [];
  const failed   = [];
  const auditByUser = new Map();
  for (const o of outcomes) {
    if (o.failed) { failed.push(o.failed); continue; }
    approved.push(o.approved);
    if (!auditByUser.has(o.approved.userId)) auditByUser.set(o.approved.userId, []);
    auditByUser.get(o.approved.userId).push(o.audit);
  }

  // One append per worker (their audit file), workers in parallel — each is
  // a different file. Best-effort, like every audit append: the approvals
  // above have landed whatever happens here.
  await Promise.all(
    [...auditByUser].map(([userId, rows]) => appendAuditMany(userId, rows)),
  );

  for (const a of approved) {
    // Fire-and-forget PER-ENTRY push via notify() (#162). Routing prefs are
    // applied per-recipient (the pre-loaded userById record carries
    // notificationPrefs), NOT per-batch — so muting `hoursApproved` suppresses
    // only that user's notifications while the rest of the batch still fire.
    // Same payload shape as the single endpoint so the recipient gets the same
    // notification regardless of how Daniel approved it.
    notify({
      kind: 'hoursApproved',
      audience: [userById[a.userId] || { id: a.userId }],
      payload: {
        title: 'Hours approved',
        body: `${Number(a.totalHours).toFixed(1)} hrs on ${a.date} approved by ${me.username}.`,
        url: '/phil/my-day',
        tag: 'buhl-hours-approved-' + a.date,
      },
    }).catch(() => {});
  }

  // #390: ONE summarising audit-log entry for the whole bulk decision (never N
  // rows — the decided days live in metadata.entries). Best-effort.
  if (approved.length) {
    appendAuditLog(
      buildHoursBulkAuditEntry({ action: 'hours.bulk_approved', actor: me, decided: approved }),
    ).catch(() => {});
  }

  return res.status(200).json({
    approvedCount: approved.length,
    failedCount:   failed.length,
    approved,
    failed,
  });
};
