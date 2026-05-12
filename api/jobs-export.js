// Jobs CSV / JSON export.
//
//   GET /api/jobs-export?status=active|archived|all&format=csv|json
//
// Flat per-job export — the master list of every job with status, type,
// client, area count, open-snag count, assigned LHs, and created date.
// Companion to /api/crew-export — together they make the bookkeeping
// snapshot of "people + work" the office wants quarterly.
//
// Why this exists:
//   /api/jobs gives a JSON list for the admin UI. Office staff often want
//   the same set as a spreadsheet — to file a snapshot, build a board
//   pack, or hand to insurers. Walking per-job data once is OK because
//   the call is admin-initiated, not on a hot path.
//
// Columns:
//   ID, Name, Type, Status, Client, Areas Count, Open Snags,
//   Assigned Leading Hands, Created At.
//
// Permissions: admin only. Includes client identifiers and full active
// job list — same sensitivity as the payroll / crew exports.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const q = req.query || {};
  const statusFilter = q.status || 'all';   // 'active' | 'archived' | 'all'
  const format       = (q.format || 'csv').toLowerCase();

  const [jobsBlob, usersBlob] = await Promise.all([
    readBlob('jobs.json',  { jobs:  [] }),
    readBlob('users.json', { users: [] }),
  ]);
  const allJobs  = jobsBlob.jobs   || [];
  const allUsers = usersBlob.users || [];

  // Lookup tables.
  const userById = {};
  for (const u of allUsers) userById[u.id] = u;
  // Per-job LH assignments: walk users once, accumulate per assignedJobIds.
  const lhsByJobId = {};
  for (const u of allUsers) {
    if (u.role !== 'leadingHand' || u.archived) continue;
    for (const jid of (u.assignedJobIds || [])) {
      (lhsByJobId[jid] = lhsByJobId[jid] || []).push(u.username || u.id);
    }
  }

  // Apply status filter.
  let jobs = allJobs.filter(j => {
    if (statusFilter === 'all') return true;
    return (j.status || 'active') === statusFilter;
  });

  // Sort: active first, then by name.
  jobs.sort((a, b) => {
    const sa = (a.status || 'active') === 'active' ? 0 : 1;
    const sb = (b.status || 'active') === 'active' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Per-job: areas count + open snags. Snags walk is bounded by visible
  // job count; parallel per-job blob fetch.
  const rows = await Promise.all(jobs.map(async j => {
    const areasCount = (j.areaGroups || []).reduce(
      (s, g) => s + ((g.areas || []).length), 0);

    let openSnags = 0;
    try {
      const d = await readBlob(`jobs/${j.id}/data.json`, { snags: [] });
      for (const s of (d.snags || [])) {
        if ((s.status || 'Open') === 'Open') openSnags++;
      }
    } catch { /* missing data blob → 0 snags */ }

    const client = j.clientUserId ? (userById[j.clientUserId] || null) : null;
    return {
      id: j.id,
      name: j.name || '',
      type: j.type || '',
      status: j.status || 'active',
      client: client ? (client.username || client.id) : '',
      areasCount,
      openSnags,
      assignedLeadingHands: (lhsByJobId[j.id] || []).sort().join('; '),
      createdAt: j.createdAt || '',
    };
  }));

  if (format === 'json') {
    return res.status(200).json({
      filters: { status: statusFilter },
      count: rows.length,
      jobs: rows,
    });
  }

  const cols = [
    'ID', 'Name', 'Type', 'Status',
    'Client',
    'Areas Count', 'Open Snags',
    'Assigned Leading Hands',
    'Created At',
  ];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.name, r.type, r.status,
      r.client,
      r.areasCount, r.openSnags,
      r.assignedLeadingHands,
      r.createdAt,
    ].map(csvCell).join(','));
  }
  const csv = lines.join('\n') + '\n';

  const today = new Date().toISOString().slice(0, 10);
  const tagged = statusFilter === 'all' ? '' : '_' + statusFilter;
  const filename = 'buhl-jobs' + tagged + '_' + today + '.csv';
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
