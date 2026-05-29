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
//   - admin: any submitted entry
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
const { requireAuth, isStaffRole } = require('./_lib/auth');
const { readEntry, writeEntry, appendAudit } = require('./_lib/time-entries');
const { sendPushToUserId } = require('./_lib/push');

const MAX_ENTRIES = 50;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isStaffRole(me.role)) {
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

  const myJobs = me.role === 'leadingHand'
    ? new Set(me.assignedJobIds || [])
    : null;

  const approved = [];
  const failed   = [];
  const now = new Date().toISOString();

  // Process sequentially. The per-entry writeEntry/appendAudit pair is
  // cheap (single blob write + audit append) and serialising avoids any
  // chance of fanned-out writes stepping on each other when two entries
  // share a user (e.g. multiple dates for the same person in one batch).
  for (const ref of list) {
    const userId = ref && ref.userId;
    const date   = ref && ref.date;
    if (!userId || !date) {
      failed.push({ userId: userId || null, date: date || null, error: 'userId and date required' });
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

    // LH gating — same rules as the single endpoint.
    if (me.role === 'leadingHand') {
      const submitter = userById[userId];
      if (submitter && submitter.role === 'leadingHand') {
        failed.push({ userId, date, error: 'leading hands cannot approve other leading hands' });
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
      status: 'approved',
      approvedBy: me.id,
      approvedAt: now,
      rejectedReason: null,
      updatedAt: now,
    };
    try {
      await writeEntry(userId, updated);
      await appendAudit(userId, entry.id, 'approved', me.id);
    } catch (e) {
      failed.push({ userId, date, error: 'write failed: ' + (e.message || 'unknown') });
      continue;
    }
    approved.push({ userId, date, totalHours: Number(entry.totalHours) || 0 });

    // Fire-and-forget per-entry push. Same payload shape as the single
    // endpoint so the recipient gets the same notification regardless of
    // how Daniel approved it.
    sendPushToUserId(userId, {
      title: 'Hours approved',
      body: `${Number(entry.totalHours).toFixed(1)} hrs on ${date} approved by ${me.username}.`,
      url: '/my-day',
      tag: 'buhl-hours-approved-' + date,
    }).catch(() => {});
  }

  return res.status(200).json({
    approvedCount: approved.length,
    failedCount:   failed.length,
    approved,
    failed,
  });
};
