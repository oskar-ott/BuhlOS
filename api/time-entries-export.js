// Payroll CSV export — flattens approved (or any-status) time-entries
// across all users into one row per allocation, with the columns Karen +
// Daniel need for Xero or any payroll system: week, date, worker,
// worker ID, job, job ID, hours, OT, notes, status, approved-by/at,
// rate (admin-only), and Xero IDs when set.
//
// Default behaviour: export STATUS=approved, range = current ISO week.
// Override with ?fromDate=&toDate=&status=&userId=&jobId=
//
// Side-effect: stamps each exported entry with exportedAt + exportId so
// the same payroll run isn't accidentally double-exported. Admin can
// override by passing &dryRun=1 to preview without stamping.
//
// Admin only — payroll data, hourly rates exposed.

const { list, put } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { writeEntry, appendAudit } = require('./_lib/time-entries');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const q = req.query || {};
  const status   = q.status || 'approved';
  const userId   = q.userId || '';
  const jobId    = q.jobId  || '';
  const dryRun   = q.dryRun === '1' || q.dryRun === 'true';
  const format   = q.format || 'csv'; // 'csv' | 'json' for debugging

  // Default range = current ISO week (Mon..Sun)
  let fromDate = q.fromDate || '';
  let toDate   = q.toDate   || '';
  if (!fromDate || !toDate) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const dow = t.getDay() || 7;
    const monday = new Date(t); monday.setDate(t.getDate() - (dow - 1));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    fromDate = fromDate || monday.toISOString().slice(0, 10);
    toDate   = toDate   || sunday.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return res.status(400).json({ error: 'fromDate / toDate must be YYYY-MM-DD' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ error: 'fromDate must be <= toDate' });
  }

  // Reference data — users (rates, Xero IDs), jobs (names)
  const [usersBlob, jobsBlob] = await Promise.all([
    readBlob('users.json', { users: [] }),
    readBlob('jobs.json',  { jobs: [] }),
  ]);
  const userById = {};
  for (const u of (usersBlob.users || [])) userById[u.id] = u;
  const jobById = {};
  for (const j of (jobsBlob.jobs || [])) jobById[j.id] = j;

  // Walk every user's time-entries (date-prefix filter applied at the
  // pathname level so we don't fetch entries outside the range).
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let entryBlobs = [];
  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    entryBlobs = (r.blobs || []).filter(b => {
      if (!b.pathname.includes('/time-entries/')) return false;
      if (b.pathname.includes('/time-entries-audit/')) return false;
      if (!b.pathname.endsWith('.json')) return false;
      const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) return false;
      const d = m[1];
      if (d < fromDate || d > toDate) return false;
      // Optional userId filter (path: users/<id>/time-entries/...)
      if (userId && !b.pathname.startsWith('users/' + userId + '/')) return false;
      return true;
    });
  } catch (e) {
    return res.status(502).json({ error: 'blob list failed: ' + e.message });
  }

  const entries = (await Promise.all(entryBlobs.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }))).filter(Boolean);

  // Status filter — 'all' means everything, otherwise exact match.
  const filtered = entries.filter(e => status === 'all' ? true : e.status === status);

  // Build payroll rows. One row per allocation (so a multi-job day
  // produces multiple rows with the same date + worker but different
  // job + hours). This is what payroll systems expect.
  const rows = [];
  for (const e of filtered) {
    const u = userById[e.userId] || {};
    const rate = (u.role === 'tradie' || u.role === 'leadingHand') ? Number(u.hourlyRate) || 0 : 0;
    const allocations = (e.allocations || []).filter(a => !jobId || a.jobId === jobId);
    if (!allocations.length) continue;
    for (const a of allocations) {
      const j = a.jobId ? jobById[a.jobId] : null;
      const hours = Number(a.hours) || 0;
      rows.push({
        weekStart: weekMondayOf(e.date),
        weekEnd:   weekSundayOf(e.date),
        date:      e.date,
        workerName: e.userName || u.username || e.userId,
        workerId:   e.userId,
        xeroEmployeeId: u.xeroEmployeeId || '',
        jobName:    j ? j.name : (a.jobId ? '(unknown job)' : 'Internal — no job'),
        jobId:      a.jobId || '',
        hours:      hours,
        ordinaryHours: e.ordinaryHours != null ? Math.min(hours, Number(e.ordinaryHours)) : Math.min(hours, 8),
        overtimeHours: e.overtimeHours != null ? Math.max(0, hours - Math.min(hours, Number(e.ordinaryHours) || 8)) : Math.max(0, hours - 8),
        rateExGst:  rate,
        lineCostExGst: Math.round(hours * rate * 100) / 100,
        notes:      String(a.notes || e.notes || '').replace(/\r?\n/g, ' ').trim(),
        status:     e.status,
        approvedBy: e.approvedBy ? (userById[e.approvedBy] || {}).username || e.approvedBy : '',
        approvedAt: e.approvedAt || '',
        exportedAt: e.exportedAt || '',
        exportId:   e.exportId || '',
      });
    }
  }
  // Stable sort: date, worker, job
  rows.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.workerName.localeCompare(b.workerName) ||
    a.jobName.localeCompare(b.jobName));

  if (format === 'json') {
    return res.status(200).json({
      range: { fromDate, toDate, status, userId: userId || null, jobId: jobId || null, dryRun },
      rows,
      summary: summarise(rows),
    });
  }

  // ── CSV ───────────────────────────────────────────────────────────────
  const cols = [
    'Week Start', 'Week End', 'Date',
    'Worker', 'Worker ID', 'Xero Employee ID',
    'Job', 'Job ID',
    'Hours', 'Ordinary Hours', 'Overtime Hours',
    'Rate ex-GST', 'Line cost ex-GST',
    'Notes', 'Status',
    'Approved By', 'Approved At',
    'Exported At', 'Export ID',
  ];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.weekStart, r.weekEnd, r.date,
      r.workerName, r.workerId, r.xeroEmployeeId,
      r.jobName, r.jobId,
      r.hours, r.ordinaryHours, r.overtimeHours,
      r.rateExGst, r.lineCostExGst,
      r.notes, r.status,
      r.approvedBy, r.approvedAt,
      r.exportedAt, r.exportId,
    ].map(csvCell).join(','));
  }
  const csv = lines.join('\n') + '\n';

  // Stamp the entries with exportedAt + exportId so the same payroll run
  // isn't double-exported. Skipped for dryRun previews.
  if (!dryRun && rows.length) {
    const exportId = 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const stampedAt = new Date().toISOString();
    // Group rows by entry (userId + date) so we update each entry once.
    const touched = new Map();
    for (const r of rows) {
      const k = r.workerId + '|' + r.date;
      if (!touched.has(k)) touched.set(k, { userId: r.workerId, date: r.date });
    }
    await Promise.all([...touched.values()].map(async ({ userId: uid, date: d }) => {
      const e = entries.find(x => x.userId === uid && x.date === d);
      if (!e) return;
      const updated = { ...e, exportedAt: stampedAt, exportId, updatedAt: stampedAt };
      try {
        await writeEntry(uid, updated);
        await appendAudit(uid, e.id, 'exported', me.id, exportId, null);
      } catch {}
    }));
    res.setHeader('X-Export-Id', exportId);
  }

  const filename = 'buhl-payroll_' + fromDate + '_to_' + toDate + (status === 'approved' ? '' : '_' + status) + '.csv';
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

function weekMondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay() || 7;
  const m = new Date(d); m.setDate(d.getDate() - (dow - 1));
  return m.toISOString().slice(0, 10);
}
function weekSundayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay() || 7;
  const s = new Date(d); s.setDate(d.getDate() + (7 - dow));
  return s.toISOString().slice(0, 10);
}

function summarise(rows) {
  let totalHours = 0, totalCost = 0;
  const byWorker = {}, byJob = {};
  for (const r of rows) {
    totalHours += r.hours;
    totalCost  += r.lineCostExGst;
    if (!byWorker[r.workerId]) byWorker[r.workerId] = { name: r.workerName, hours: 0, cost: 0 };
    byWorker[r.workerId].hours += r.hours;
    byWorker[r.workerId].cost  += r.lineCostExGst;
    if (!byJob[r.jobId || '__internal__']) byJob[r.jobId || '__internal__'] = { name: r.jobName, hours: 0, cost: 0 };
    byJob[r.jobId || '__internal__'].hours += r.hours;
    byJob[r.jobId || '__internal__'].cost  += r.lineCostExGst;
  }
  return {
    rowCount: rows.length,
    totalHours: Math.round(totalHours * 100) / 100,
    totalCostExGst: Math.round(totalCost * 100) / 100,
    workerCount: Object.keys(byWorker).length,
    jobCount: Object.keys(byJob).length,
    byWorker, byJob,
  };
}
