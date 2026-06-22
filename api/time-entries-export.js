// Payroll CSV export + finalise — flattens approved (or any-status) time-
// entries across all users into one row per allocation, with the columns
// Karen + Daniel need for Xero or any payroll system: week, date, worker,
// worker ID, job, job ID, hours, OT, notes, status, approved-by/at,
// rate (admin-only), and Xero IDs when set.
//
// TWO methods, ONE seam (payroll-boundary ADR #609 — the CSV stays the
// fallback path, it is not replaced):
//
//   GET  — DOWNLOAD / PREVIEW. ?dryRun=1 previews without stamping; format=json
//          feeds the /hours/period rollup; the non-dryRun GET is the LEGACY
//          committed run the weekly board's panel (#126) drives behind its own
//          preview→confirm→acknowledge flow + programmatic navigation. That
//          path is unchanged here (it re-stamps by design; the panel guards it).
//   POST — FINALISE (#131). Explicit admin action: stamps ONLY eligible rows
//          (approved AND not already in a run), NEVER re-stamps, appends the
//          run log, and returns the run's CSV. Blocks on no-rows / nothing-new
//          / a Xero-ready run with any unmapped worker. A payroll MUTATION must
//          not hang off a casual GET link — finalise is POST so it can't be
//          bookmarked, prefetched, crawled or retried into a double-export.
//
// Default range = current ISO week. Override with ?fromDate=&toDate=&status=&userId=&jobId=
// Admin only — payroll data, hourly rates exposed.

const { list, put } = require('@vercel/blob');
const crypto = require('crypto');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isLeadingHandRole, isFieldRole } = require('./_lib/auth');
const { writeEntry, appendAudit } = require('./_lib/time-entries');
const { appendActivity } = require('./_lib/activity');
const { prorateAllocations } = require('./_lib/payroll-rows');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  if (req.method === 'GET')  return handleGet(req, res, me);
  if (req.method === 'POST') return handleFinalise(req, res, me);
  return res.status(405).json({ error: 'method not allowed' });
};

// ── Shared: range + rows ─────────────────────────────────────────────────────
// Resolve the range, load reference data + every in-range entry, and build the
// one-row-per-allocation payroll rows (#380 OT proration applied BEFORE any
// jobId filter, so a filtered export never re-attributes overtime). Used by
// BOTH the GET download/preview and the POST finalise — one row model, no
// second engine. Returns { ok:false, status, error } on a bad range / blob
// failure, else { ok:true, fromDate, toDate, status, userId, jobId, rows,
// entries, userById, jobById }.
async function collectRows({ status, userId, jobId, fromDate, toDate }) {
  // Default range = current ISO week (Mon..Sun). NOTE: this is server-local
  // (UTC on Vercel); every UI caller passes explicit fromDate/toDate.
  if (!fromDate || !toDate) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const dow = t.getDay() || 7;
    const monday = new Date(t); monday.setDate(t.getDate() - (dow - 1));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    fromDate = fromDate || monday.toISOString().slice(0, 10);
    toDate   = toDate   || sunday.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { ok: false, status: 400, error: 'fromDate / toDate must be YYYY-MM-DD' };
  }
  if (fromDate > toDate) {
    return { ok: false, status: 400, error: 'fromDate must be <= toDate' };
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
      if (userId && !b.pathname.startsWith('users/' + userId + '/')) return false;
      return true;
    });
  } catch (e) {
    return { ok: false, status: 502, error: 'blob list failed: ' + e.message };
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

  // Build payroll rows. One row per allocation (a multi-job day produces
  // multiple rows with the same date + worker but different job + hours).
  const rows = [];
  for (const e of filtered) {
    const u = userById[e.userId] || {};
    const rate = (isFieldRole(u.role) || isLeadingHandRole(u.role)) ? Number(u.hourlyRate) || 0 : 0;
    const allAllocations = e.allocations || [];
    const prorated = prorateAllocations(e, allAllocations);
    const allocations = allAllocations
      .map((a, i) => ({ allocation: a, split: prorated[i] }))
      .filter(({ allocation: a }) => !jobId || a.jobId === jobId);
    if (!allocations.length) continue;
    for (const { allocation: a, split } of allocations) {
      const j = a.jobId ? jobById[a.jobId] : null;
      const hours = split.hours;
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
        ordinaryHours: split.ordinaryHours,
        overtimeHours: split.overtimeHours,
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

  return { ok: true, fromDate, toDate, status, userId, jobId, rows, entries, userById, jobById };
}

// ── GET — download / preview (+ legacy committed run for the weekly panel) ────
async function handleGet(req, res, me) {
  const q = req.query || {};
  const dryRun = q.dryRun === '1' || q.dryRun === 'true';
  const format = q.format || 'csv'; // 'csv' | 'json' for debugging / the rollup
  // #131 CSV shape: 'payroll' (default, full Karen/Daniel columns incl. rate
  // /cost — unchanged), 'review' (human/admin, rich context, no rate/cost), or
  // 'xero' (lean payroll BRIDGE; NOT a Xero API push or a guaranteed Xero-AU
  // import file). Shape changes only the column set + filename.
  const shape = q.shape || 'payroll';

  const ctx = await collectRows({
    status: q.status || 'approved',
    userId: q.userId || '',
    jobId:  q.jobId  || '',
    fromDate: q.fromDate || '',
    toDate:   q.toDate   || '',
  });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const { rows, entries, fromDate, toDate, status, userId, jobId } = ctx;

  if (format === 'json') {
    return res.status(200).json({
      range: { fromDate, toDate, status, userId: userId || null, jobId: jobId || null, dryRun },
      rows,
      summary: summarise(rows),
    });
  }

  // CSV (shape-selectable: payroll default | review | xero) — #131.
  const { cols, toCells, csvFilename } = csvShape(shape, fromDate, toDate, status);
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(toCells(r).map(csvCell).join(','));
  const csv = lines.join('\n') + '\n';

  // Brief §08: SHA-256 of the CSV → response header + run log. Deterministic.
  const csvHash = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');
  res.setHeader('X-Export-Hash', csvHash);

  // LEGACY committed run (no dryRun): stamps exportedAt + exportId. UNCHANGED —
  // only the weekly board's panel (#126) reaches this, behind its own confirm +
  // already-exported acknowledgement. The hardened, no-restamp path is POST
  // finalise. (Re-stamp behaviour here is intentionally preserved for #126.)
  let exportId = null;
  if (!dryRun && rows.length) {
    exportId = 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const stampedAt = new Date().toISOString();
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

    await appendRun({
      exportId, hash: csvHash, me, stampedAt,
      fromDate, toDate, status, userId, jobId,
      rowCount: rows.length, summary: summarise(rows),
    });
    await appendActivity({
      action: 'payroll.exported', scope: 'payroll', actor: me.id, actorName: me.username,
      target: `payroll/${exportId}`, targetLabel: `${fromDate} → ${toDate}`,
      meta: { exportId, hash: csvHash, rowCount: rows.length, range: { fromDate, toDate, status }, summary: summarise(rows) },
    });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + csvFilename + '"');
  res.setHeader('X-Row-Count', String(rows.length));
  res.status(200).send(csv);
}

// ── POST — finalise: explicit, eligible-only, no re-stamp (#131) ──────────────
async function handleFinalise(req, res, me) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const q = req.query || {};
  const pick = (k) => (body[k] != null ? body[k] : q[k]);
  const shape  = String(pick('shape')  || 'xero');
  const status = String(pick('status') || 'approved');

  const ctx = await collectRows({
    status,
    userId: String(pick('userId') || ''),
    jobId:  String(pick('jobId')  || ''),
    fromDate: String(pick('fromDate') || ''),
    toDate:   String(pick('toDate')   || ''),
  });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const { rows, entries, fromDate, toDate } = ctx;

  // BLOCK: nothing approved to finalise.
  if (!rows.length) {
    return res.status(422).json({
      error: 'No approved hours in this period — nothing to finalise.',
      code: 'no_rows',
    });
  }

  // Eligible = rows NOT already in a committed run. Already-exported rows keep
  // their ORIGINAL exportId; finalise never overwrites them. This is the real
  // double-export protection the legacy GET path lacks.
  const eligibleRows = rows.filter((r) => !r.exportId);
  const alreadyRows  = rows.filter((r) => r.exportId);
  const priorExportIds = [...new Set(alreadyRows.map((r) => r.exportId))].sort();

  // BLOCK: every approved row already exported — nothing new (idempotent: a
  // second finalise of the same range lands here, stamps nothing).
  if (!eligibleRows.length) {
    return res.status(409).json({
      error: 'Every approved row in this period is already in a committed run — nothing new to finalise.',
      code: 'all_exported',
      alreadyExportedRows: alreadyRows.length,
      priorExportIds,
    });
  }

  // BLOCK: a Xero-ready committed run with any unmapped worker. P7 — a named
  // blocker, never a silent blank id baked into a payroll run. (The dry-run
  // preview is where blanks are visible; the committed file must be complete.)
  if (shape === 'xero') {
    const unmappedWorkers = [...new Set(
      eligibleRows.filter((r) => !r.xeroEmployeeId).map((r) => r.workerName),
    )].sort();
    if (unmappedWorkers.length) {
      return res.status(422).json({
        error: `${unmappedWorkers.length} worker(s) have no Xero employee id — map them in Xero/BuhlOS before finalising a Xero-ready run, or use the Review CSV.`,
        code: 'unmapped_workers',
        unmappedWorkers,
      });
    }
  }

  // THIS run's CSV = the eligible (newly-paid) rows only, in the requested
  // shape. The hash is tamper-evident over exactly those rows.
  const { cols, toCells, csvFilename } = csvShape(shape, fromDate, toDate, status);
  const lines = [cols.map(csvCell).join(',')];
  for (const r of eligibleRows) lines.push(toCells(r).map(csvCell).join(','));
  const csv = lines.join('\n') + '\n';
  const csvHash = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');

  // Stamp ONLY eligible entries (skip — never overwrite — already-exported).
  const exportId = 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const stampedAt = new Date().toISOString();
  const touched = new Map();
  for (const r of eligibleRows) {
    const k = r.workerId + '|' + r.date;
    if (!touched.has(k)) touched.set(k, { userId: r.workerId, date: r.date });
  }
  await Promise.all([...touched.values()].map(async ({ userId: uid, date: d }) => {
    const e = entries.find((x) => x.userId === uid && x.date === d);
    if (!e || e.exportId) return; // defensive: never re-stamp a row already in a run
    const updated = { ...e, exportedAt: stampedAt, exportId, updatedAt: stampedAt };
    try {
      await writeEntry(uid, updated);
      await appendAudit(uid, e.id, 'exported', me.id, exportId, null);
    } catch {}
  }));

  await appendRun({
    exportId, hash: csvHash, me, stampedAt,
    fromDate, toDate, status, userId: ctx.userId, jobId: ctx.jobId,
    rowCount: eligibleRows.length, summary: summarise(eligibleRows),
    extra: { newlyStamped: touched.size, alreadyExportedRows: alreadyRows.length, shape, via: 'finalise' },
  });
  await appendActivity({
    action: 'payroll.exported', scope: 'payroll', actor: me.id, actorName: me.username,
    target: `payroll/${exportId}`, targetLabel: `${fromDate} → ${toDate}`,
    meta: {
      exportId, hash: csvHash, rowCount: eligibleRows.length, via: 'finalise', shape,
      range: { fromDate, toDate, status }, summary: summarise(eligibleRows),
    },
  });

  res.setHeader('X-Export-Id', exportId);
  res.setHeader('X-Export-Hash', csvHash);
  res.setHeader('X-Row-Count', String(eligibleRows.length));
  res.setHeader('X-Already-Exported-Rows', String(alreadyRows.length));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + csvFilename + '"');
  return res.status(200).send(csv);
}

// Append one entry to the append-only payroll-runs log (read by /api/payroll-
// runs + the weekly panel + #131). Failure is non-fatal: the per-entry audit
// rows are the primary record; we just lose the hash-indexed roll-up.
async function appendRun({ exportId, hash, me, stampedAt, fromDate, toDate, status, userId, jobId, rowCount, summary, extra }) {
  try {
    const runs = await readBlob('payroll-runs.json', { runs: [] });
    runs.runs = runs.runs || [];
    runs.runs.push({
      exportId, hash, actor: me.id, actorName: me.username || me.id, at: stampedAt,
      range: { fromDate, toDate, status },
      userId: userId || null, jobId: jobId || null,
      rowCount, summary,
      ...(extra || {}),
    });
    await writeBlob('payroll-runs.json', runs);
  } catch (e) {
    console.error('payroll-runs append failed', e);
  }
}

// CSV column sets — one definition, used by the GET download AND the POST
// finalise so the two can never drift. payroll | review | xero.
function csvShape(shape, fromDate, toDate, status) {
  // Period Start/End on review + xero = the REQUESTED range (the pay period the
  // admin picked), not the per-row ISO week. area/stage/task are NOT on the row
  // (allocations are jobId-only), so they are not invented.
  if (shape === 'review') {
    return {
      cols: [
        'Pay Period Start', 'Pay Period End', 'Worker Name', 'Date', 'Day', 'Job',
        'Ordinary Hours', 'Overtime Hours', 'Total Hours',
        'Approval Status', 'Exported', 'Export ID', 'Notes',
      ],
      toCells: (r) => [
        fromDate, toDate, r.workerName, r.date, dayName(r.date), r.jobName,
        r.ordinaryHours, r.overtimeHours, r.hours,
        r.status, r.exportedAt, r.exportId, r.notes,
      ],
      csvFilename: 'buhlos-review-hours-' + fromDate + '-to-' + toDate + '.csv',
    };
  }
  if (shape === 'xero') {
    return {
      cols: [
        'Pay Period Start', 'Pay Period End', 'Worker Name', 'Xero Employee ID',
        'Date', 'Ordinary Hours', 'Overtime Hours', 'Total Hours',
      ],
      toCells: (r) => [
        fromDate, toDate, r.workerName, r.xeroEmployeeId,
        r.date, r.ordinaryHours, r.overtimeHours, r.hours,
      ],
      csvFilename: 'buhlos-xero-ready-hours-' + fromDate + '-to-' + toDate + '.csv',
    };
  }
  // Default 'payroll' — the existing full Karen/Daniel shape (unchanged).
  return {
    cols: [
      'Week Start', 'Week End', 'Date',
      'Worker', 'Worker ID', 'Xero Employee ID',
      'Job', 'Job ID',
      'Hours', 'Ordinary Hours', 'Overtime Hours',
      'Rate ex-GST', 'Line cost ex-GST',
      'Notes', 'Status',
      'Approved By', 'Approved At',
      'Exported At', 'Export ID',
    ],
    toCells: (r) => [
      r.weekStart, r.weekEnd, r.date,
      r.workerName, r.workerId, r.xeroEmployeeId,
      r.jobName, r.jobId,
      r.hours, r.ordinaryHours, r.overtimeHours,
      r.rateExGst, r.lineCostExGst,
      r.notes, r.status,
      r.approvedBy, r.approvedAt,
      r.exportedAt, r.exportId,
    ],
    csvFilename: 'buhl-payroll_' + fromDate + '_to_' + toDate + (status === 'approved' ? '' : '_' + status) + '.csv',
  };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Short day-of-week label for the review CSV (Mon..Sun), local to the date.
function dayName(dateStr) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(dateStr + 'T00:00:00').getDay()];
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
