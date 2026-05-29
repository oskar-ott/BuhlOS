// Snags CSV export — flatten a job's snags into one row each for handover
// docs, client punch-lists, and offline review.
//
//   GET /api/snags-export?jobId=<id>
//       &status=Open|Closed|all   (default: all)
//       &priority=High|Medium|Low (optional)
//       &format=csv|json          (default: csv)
//
// Columns: Snag ID, Dwelling, Stage, Priority, Status, Description,
//          Reported By, Reported At, Days Open, Resolved By, Resolved At,
//          Assigned To, Photo Count.
//
// Permissions: admin (any job) or leadingHand (assigned jobs only).
//
// Why this exists:
//   At handover, the client expects a punch-list — every snag, who raised
//   it, when it was opened/closed, how long it took. The admin /snags
//   page is great for triage but a CSV is what builders forward to
//   subcontractors and what gets filed alongside the certificate of
//   compliance. One endpoint, two formats, no other UI dependency.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isStaffRole } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isStaffRole(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const q = req.query || {};
  const jobId    = q.jobId || '';
  const status   = q.status   || 'all';   // 'Open' | 'Closed' | 'all'
  const priority = q.priority || '';      // 'High' | 'Medium' | 'Low' | ''
  const format   = (q.format  || 'csv').toLowerCase();
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  // Job lookup + access check.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'no access to job' });

  // Pull data + flatten snags. Area names looked up via the job's areaGroups
  // so the CSV is human-readable even if a snag references a dwelling-id only.
  const data = await readBlob(`jobs/${jobId}/data.json`, { snags: [] });
  const areaName = {};
  for (const g of (job.areaGroups || [])) {
    for (const a of (g.areas || [])) areaName[a.id] = a.name;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const rows = (data.snags || [])
    .filter(s => {
      if (status !== 'all' && (s.status || 'Open') !== status) return false;
      if (priority && (s.priority || 'Medium') !== priority) return false;
      return true;
    })
    .map(s => {
      const createdAt = s.createdAt || s.date || '';
      const closedAt  = s.closedAt  || '';
      const isOpen    = (s.status || 'Open') === 'Open';
      let daysOpen = '';
      if (createdAt) {
        const t = Date.parse(createdAt);
        if (Number.isFinite(t)) {
          // For closed snags: time from open to close. For open: time so far.
          const endT = (!isOpen && closedAt && Number.isFinite(Date.parse(closedAt)))
            ? Date.parse(closedAt) : now;
          daysOpen = Math.max(0, Math.floor((endT - t) / DAY_MS));
        }
      }
      return {
        id: s.id || '',
        dwelling: areaName[s.dwelling] || s.dwelling || '',
        stage: s.stage || '',
        priority: s.priority || 'Medium',
        status: s.status || 'Open',
        desc: s.desc || '',
        reportedBy: s.by || '',
        reportedAt: createdAt,
        daysOpen,
        resolvedBy: (s.status === 'Closed') ? (s.updatedBy || '') : '',
        resolvedAt: closedAt,
        assignedTo: s.assignedToName || '',
        photoCount: (s.photos || []).length,
      };
    })
    // High priority first, then Open before Closed, then oldest first
    .sort((a, b) => {
      const prio = { High: 0, Medium: 1, Low: 2 };
      const pa = prio[a.priority] ?? 1;
      const pb = prio[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      if (a.status !== b.status) return a.status === 'Open' ? -1 : 1;
      return (a.reportedAt || '').localeCompare(b.reportedAt || '');
    });

  // JSON path — useful for testing and for programmatic consumers.
  if (format === 'json') {
    return res.status(200).json({
      jobId, jobName: job.name,
      filters: { status, priority: priority || null },
      count: rows.length,
      snags: rows,
    });
  }

  // CSV path — the default.
  const cols = [
    'Snag ID', 'Dwelling', 'Stage',
    'Priority', 'Status',
    'Description',
    'Reported By', 'Reported At',
    'Days Open',
    'Resolved By', 'Resolved At',
    'Assigned To', 'Photo Count',
  ];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.dwelling, r.stage,
      r.priority, r.status,
      r.desc,
      r.reportedBy, r.reportedAt,
      r.daysOpen,
      r.resolvedBy, r.resolvedAt,
      r.assignedTo, r.photoCount,
    ].map(csvCell).join(','));
  }
  const csv = lines.join('\n') + '\n';

  const safeJobName = String(job.name || jobId).replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60);
  const today = new Date().toISOString().slice(0, 10);
  const filename = 'buhl-snags_' + safeJobName + '_' + today + '.csv';
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
