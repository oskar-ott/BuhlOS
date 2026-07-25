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

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isClientRole, isHoursTrackedWorker } = require('./_lib/auth');
const { sendPushToUserId } = require('./_lib/push');
const { LEAVE_TYPES, readLeave, mutateLeave, rangesOverlap } = require('./_lib/leave');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { covers } = require('./_lib/leave');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function newId() {
  return 'lv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function auditLeave(me, action, request, summary) {
  await appendAuditLog({
    action,
    actorId: me.id,
    actorName: me.username || 'Unknown',
    actorRole: me.role || null,
    jobId: null,
    targetType: 'leave',
    targetId: request.id,
    summary,
    metadata: { userId: request.userId, type: request.type, fromDate: request.fromDate, toDate: request.toDate },
  }).catch(() => {});
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
    const outcome = await mutateLeave((data) => {
      const found = data.requests.find(x => x.id === id);
      if (!found) return { abort: { status: 404, body: { error: 'request not found' } } };
      if (found.status !== 'pending') return { abort: { status: 409, body: { error: `already ${found.status}` } } };
      found.status = approve ? 'approved' : 'declined';
      found.decidedAt = new Date().toISOString();
      found.decidedBy = me.id;
      found.decidedByName = me.username;
      found.decisionNote = note ? String(note).trim().slice(0, 500) : null;
      return { request: found };
    });
    if (outcome.abort) return res.status(outcome.abort.status).json(outcome.abort.body);
    const r = outcome.request;
    await auditLeave(me, 'leave.decided', r, `${approve ? 'approved' : 'declined'} ${r.type} leave for ${r.userName || r.userId} (${r.fromDate}${r.toDate !== r.fromDate ? ` → ${r.toDate}` : ''})`);
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

  // #127: admin "undo" of a marked not-worked day, by worker + date. Cancels
  // the approved leave covering that date so the cell flips back to missing.
  if (req.method === 'POST' && action === 'clear') {
    if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });
    const { userId, date } = req.body || {};
    if (!userId || !ISO.test(date || '')) {
      return res.status(400).json({ error: 'userId and a YYYY-MM-DD date required' });
    }
    const outcome = await mutateLeave((data) => {
      const found = data.requests.find(x =>
        x.userId === userId &&
        (x.status === 'approved' || x.status === 'pending') &&
        covers(x, date)
      );
      if (!found) return { abort: { status: 404, body: { error: 'no marked leave covering that day' } } };
      found.status = 'cancelled';
      found.decidedAt = new Date().toISOString();
      found.decidedBy = me.id;
      found.decidedByName = me.username;
      return { request: found };
    });
    if (outcome.abort) return res.status(outcome.abort.status).json(outcome.abort.body);
    const r = outcome.request;
    await auditLeave(me, 'leave.cancelled', r, `cleared ${r.type} leave for ${r.userName || r.userId} on ${date}`);
    return res.status(200).json({ request: r });
  }

  if (req.method === 'POST' && action === 'cancel') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const outcome = await mutateLeave((data) => {
      const found = data.requests.find(x => x.id === id);
      if (!found) return { abort: { status: 404, body: { error: 'request not found' } } };
      if (found.userId !== me.id) return { abort: { status: 403, body: { error: 'not your request' } } };
      if (found.status !== 'pending') return { abort: { status: 409, body: { error: `already ${found.status} — ask the office` } } };
      found.status = 'cancelled';
      found.decidedAt = new Date().toISOString();
      return { request: found };
    });
    if (outcome.abort) return res.status(outcome.abort.status).json(outcome.abort.body);
    return res.status(200).json({ request: outcome.request });
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
    // A worker's OWN request can't start in the past — you don't request leave
    // you've already taken. (Admin recording on-behalf above CAN back-date, for
    // retroactive sick.) Compared in the business timezone.
    if (!onBehalf) {
      const todaySyd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
      if (fromDate < todaySyd) {
        return res.status(400).json({ error: "leave can't start in the past — ask the office to record past leave" });
      }
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
    // Clash check lives INSIDE the mutator so a concurrency retry re-checks
    // against the fresh snapshot (the row it clashes with may have appeared
    // between attempts).
    const outcome = await mutateLeave((data) => {
      const clash = data.requests.find(r =>
        r.userId === target.id &&
        (r.status === 'pending' || r.status === 'approved') &&
        rangesOverlap(fromDate, toDate, r.fromDate, r.toDate)
      );
      if (clash) {
        return {
          abort: {
            status: 409,
            body: { error: `overlaps an existing ${clash.status} request (${clash.fromDate} → ${clash.toDate})` },
          },
        };
      }
      data.requests.push(request);
      return { request };
    });
    if (outcome.abort) return res.status(outcome.abort.status).json(outcome.abort.body);
    if (onBehalf) {
      await auditLeave(me, 'leave.recorded', request, `recorded ${type} leave for ${target.username || target.id} (${fromDate}${toDate !== fromDate ? ` → ${toDate}` : ''})`);
    }
    return res.status(201).json({ request });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
