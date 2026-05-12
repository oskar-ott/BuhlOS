// Crew CSV / JSON export for admin.
//
//   GET /api/crew-export?role=tradie|leadingHand|all&format=csv|json
//
// Flat per-person export of crew details — the master list Karen wants
// alongside the payroll CSV (see /api/time-entries-export). Columns:
// ID, Username, Role, Email, Hourly Rate, Xero Employee ID, Assigned
// Jobs (count + names), Push Enabled, Archived, Created At.
//
// Why this exists:
//   The payroll CSV exports the *hours* for a pay run. Bookkeepers also
//   periodically need the *crew* — who is on the payroll, what's their
//   rate, what's their Xero employee ID, which jobs are they on.
//   Existing /api/users returns JSON for the admin UI; this endpoint
//   wraps the same data into a CSV that drops straight into Xero,
//   spreadsheets, or HR systems.
//
// Permissions: admin only — includes hourly rates and Xero IDs.
//
// Default: role=all (tradies + LHs + admins; clients excluded by default),
//          format=csv.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const STAFF_ROLES = new Set(['admin', 'leadingHand', 'tradie']);

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const q = req.query || {};
  const roleFilter = q.role || 'all';
  const format     = (q.format || 'csv').toLowerCase();
  const includeArchived = q.includeArchived === '1' || q.includeArchived === 'true';

  const usersBlob = await readBlob('users.json', { users: [] });
  const jobsBlob  = await readBlob('jobs.json',  { jobs:  [] });
  const jobNameById = {};
  for (const j of (jobsBlob.jobs || [])) jobNameById[j.id] = j.name;

  let users = (usersBlob.users || []).filter(u => {
    if (!STAFF_ROLES.has(u.role)) return false;
    if (!includeArchived && u.archived) return false;
    if (roleFilter !== 'all' && u.role !== roleFilter) return false;
    return true;
  });

  // Stable sort: role (admin → LH → tradie), then username.
  const roleRank = { admin: 0, leadingHand: 1, tradie: 2 };
  users.sort((a, b) => {
    const ra = roleRank[a.role] ?? 9, rb = roleRank[b.role] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.username || '').localeCompare(b.username || '');
  });

  const rows = users.map(u => {
    const assignedIds   = Array.isArray(u.assignedJobIds) ? u.assignedJobIds : [];
    const assignedNames = assignedIds.map(id => jobNameById[id] || id);
    return {
      id: u.id,
      username: u.username || '',
      role: u.role,
      email: u.email || '',
      hourlyRate: typeof u.hourlyRate === 'number' ? u.hourlyRate.toFixed(2) : '',
      xeroEmployeeId: u.xeroEmployeeId || '',
      assignedJobCount: assignedIds.length,
      assignedJobs: assignedNames.join('; '),
      pushEnabled: Array.isArray(u.pushSubscriptions) && u.pushSubscriptions.length ? 'yes' : '',
      archived: u.archived ? 'yes' : '',
      createdAt: u.createdAt || '',
    };
  });

  if (format === 'json') {
    return res.status(200).json({
      filters: { role: roleFilter, includeArchived },
      count: rows.length,
      crew: rows,
    });
  }

  const cols = [
    'ID', 'Username', 'Role',
    'Email',
    'Hourly Rate', 'Xero Employee ID',
    'Assigned Job Count', 'Assigned Jobs',
    'Push Enabled', 'Archived', 'Created At',
  ];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.username, r.role,
      r.email,
      r.hourlyRate, r.xeroEmployeeId,
      r.assignedJobCount, r.assignedJobs,
      r.pushEnabled, r.archived, r.createdAt,
    ].map(csvCell).join(','));
  }
  const csv = lines.join('\n') + '\n';

  const today = new Date().toISOString().slice(0, 10);
  const tagged = roleFilter === 'all' ? '' : '_' + roleFilter;
  const filename = 'buhl-crew' + tagged + '_' + today + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.setHeader('X-Row-Count', String(rows.length));
  res.status(200).send(csv);
};

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
