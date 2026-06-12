// Leave requests (#333) — worker requests in Phil, office approves; approved
// leave feeds the missing-day computation so holidays stop reading as
// "missing hours". Creates NO time entries, touches NO payroll maths.
//
//   GET    /api/leave?mine=1            → own requests (any worker)
//   GET    /api/leave                   → all requests (admin tier)
//   POST   /api/leave                   → request leave (self) or, admin-only,
//          body: { type, fromDate, toDate, note?, userId? }
//          on a worker's behalf (userId set → auto-approved: the
//          "called in sick yesterday" reality)
//   POST   /api/leave?action=decide     → admin approve/decline
//          body: { id, approve: bool, note? }   (push to the worker)
//   POST   /api/leave?action=cancel     → worker cancels own PENDING request
//          body: { id }

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isClientRole, isHoursTrackedWorker } = require('./_lib/auth');
const { sendPushToUserId } = require('./_lib/push');
const { KEY, LEAVE_TYPES, readLeave, rangesOverlap } = require('./_lib/leave');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function newId() {
  return 'lv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;
  if (isClientRole(me.role)) return res.status(403).json({ error: 'forbidden' });

  const action = (req.query && req.query.action) || '';

  if (req.method === 'GET') {
    const data = await readLeave();
    if (req.query && req.query.mine === '1') {
      return res.status(200).json({
        requests: data.requests.filter(r => r.userId === me.id),
      });
    }
    if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });
    return res.status(200).json({ requests: data.requests });
  }

  if (req.method === 'POST' && action === 'decide') {
    if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });
    const { id, approve, note } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    if (typeof approve !== 'boolean') return res.status(400).json({ error: 'approve must be true or false' });
    const data = await readLeave();
    const r = data.requests.find(x => x.id === id);
    if (!r) return res.status(404).json({ error: 'request not found' });
    if (r.status !== 'pending') return res.status(409).json({ error: `already ${r.status}` });
    r.status = approve ? 'approved' : 'declined';
    r.decidedAt = new Date().toISOString();
    r.decidedBy = me.id;
    r.decidedByName = me.username;
    r.decisionNote = note ? String(note).trim().slice(0, 500) : null;
    await writeBlob(KEY, data);
    try {
      await sendPushToUserId(r.userId, {
        title: approve ? 'Leave approved ✓' : 'Leave declined',
        body: `${r.type} leave ${r.fromDate} → ${r.toDate}${r.decisionNote ? ` — ${r.decisionNote}` : ''}`,
        url: '/phil/leave',
        tag: 'buhl-leave',
      });
    } catch {}
    return res.status(200).json({ request: r });
  }

  if (req.method === 'POST' && action === 'cancel') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readLeave();
    const r = data.requests.find(x => x.id === id);
    if (!r) return res.status(404).json({ error: 'request not found' });
    if (r.userId !== me.id) return res.status(403).json({ error: 'not your request' });
    if (r.status !== 'pending') return res.status(409).json({ error: `already ${r.status} — ask the office` });
    r.status = 'cancelled';
    r.decidedAt = new Date().toISOString();
    await writeBlob(KEY, data);
    return res.status(200).json({ request: r });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const { type, fromDate, toDate } = body;
    if (!LEAVE_TYPES.includes(type)) {
      return res.status(400).json({ error: 'type must be one of: ' + LEAVE_TYPES.join(', ') });
    }
    if (!ISO.test(fromDate || '') || !ISO.test(toDate || '')) {
      return res.status(400).json({ error: 'fromDate / toDate must be YYYY-MM-DD' });
    }
    if (fromDate > toDate) return res.status(400).json({ error: 'fromDate must be <= toDate' });

    // Admin recording on a worker's behalf → auto-approved (retroactive sick).
    const onBehalf = body.userId && body.userId !== me.id;
    if (onBehalf && !isAdminRole(me.role)) {
      return res.status(403).json({ error: 'only the office can record leave for someone else' });
    }
    let target = me;
    if (onBehalf) {
      const usersBlob = await readBlob('users.json', { users: [] });
      target = (usersBlob.users || []).find(u => u.id === body.userId);
      if (!target) return res.status(404).json({ error: 'worker not found' });
    }
    // Leave only means something for workers missing-day detection tracks
    // (field tier + leading hands). For anyone else — office, admin — an
    // "approved" leave row would be a silent no-op, so refuse honestly.
    if (!isHoursTrackedWorker(target)) {
      return res.status(400).json({ error: 'leave applies to hours-tracked workers' });
    }

    const data = await readLeave();
    const clash = data.requests.find(r =>
      r.userId === target.id &&
      (r.status === 'pending' || r.status === 'approved') &&
      rangesOverlap(fromDate, toDate, r.fromDate, r.toDate)
    );
    if (clash) {
      return res.status(409).json({
        error: `overlaps an existing ${clash.status} request (${clash.fromDate} → ${clash.toDate})`,
      });
    }

    const request = {
      id: newId(),
      userId: target.id,
      userName: target.username,
      type,
      fromDate,
      toDate,
      note: body.note ? String(body.note).trim().slice(0, 500) : null,
      status: onBehalf ? 'approved' : 'pending',
      requestedAt: new Date().toISOString(),
      requestedBy: me.id,
      ...(onBehalf
        ? { decidedAt: new Date().toISOString(), decidedBy: me.id, decidedByName: me.username }
        : {}),
    };
    data.requests.push(request);
    await writeBlob(KEY, data);
    return res.status(201).json({ request });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
