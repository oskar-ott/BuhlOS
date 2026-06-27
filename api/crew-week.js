// Weekly crew availability (#337, Epic 15). ADMIN-TIER ONLY.
//
//   GET /api/crew-week?weekStart=YYYY-MM-DD   → { weekStart, weekDays, workers[] }
//
// Read-only week view of the active crew: per worker, per day → on leave (with
// type) / assigned (current job names) / free. Composed server-side in one
// endpoint (no client fan-out). Approved leave only; pending is omitted (the AC
// — one behaviour, documented). Assignment is CURRENT-state (assignedJobIds),
// not a dated forward schedule. No hours / cost numbers (that's Epic 14).

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isHoursTrackedWorker } = require('./_lib/auth');
const { readLeave } = require('./_lib/leave');
const { mondayOf, weekDays, buildCrewWeek } = require('./_lib/crew-week');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  const q = req.query || {};
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(q.weekStart || '')
    ? mondayOf(q.weekStart)
    : mondayOf(new Date().toISOString().slice(0, 10));
  const days = weekDays(weekStart);

  const [usersBlob, jobsBlob, leaveData] = await Promise.all([
    readBlob('users.json', { users: [] }),
    readBlob('jobs.json', { jobs: [] }),
    readLeave(),
  ]);

  const jobNameById = {};
  (jobsBlob.jobs || []).forEach((j) => { jobNameById[j.id] = j.name || j.id; });

  // Active tracked workers only (field + LH, not disabled/archived/non-field).
  const tracked = (usersBlob.users || []).filter((u) => isHoursTrackedWorker(u));
  const workers = tracked.map((u) => ({
    id: u.id,
    name: u.username || u.id,
    role: u.role,
    assignedJobNames: (u.assignedJobIds || [])
      .map((jid) => jobNameById[jid])
      .filter(Boolean),
  }));

  // Approved leave only, grouped by user, narrowed to the week.
  const weekFrom = days[0];
  const weekTo = days[days.length - 1];
  const leaveByUser = {};
  for (const r of (leaveData.requests || [])) {
    if (r.status !== 'approved') continue;
    if (r.toDate < weekFrom || r.fromDate > weekTo) continue;
    (leaveByUser[r.userId] ||= []).push({ type: r.type, fromDate: r.fromDate, toDate: r.toDate });
  }

  return res.status(200).json({
    weekStart,
    weekDays: days,
    workers: buildCrewWeek({ weekDays: days, workers, leaveByUser }),
  });
};
