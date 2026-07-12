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

const crypto = require('crypto');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { writeEntry, appendAudit } = require('./_lib/time-entries');
const { appendActivity } = require('./_lib/activity');
// #894 seam: the row engine moved VERBATIM to api/_lib/payroll-inputs.js so
// the payroll-batch foundation (#893) reads the SAME rows — no second engine.
const { collectRows } = require('./_lib/payroll-inputs');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  if (req.method === 'GET')  return handleGet(req, res, me);
  if (req.method === 'POST') return handleFinalise(req, res, me);
  return res.status(405).json({ error: 'method not allowed' });
};

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
    let stampFailures = 0;
    await Promise.all([...touched.values()].map(async ({ userId: uid, date: d }) => {
      const e = entries.find(x => x.userId === uid && x.date === d);
      if (!e) return;
      const updated = { ...e, exportedAt: stampedAt, exportId, updatedAt: stampedAt };
      try {
        await writeEntry(uid, updated);
        await appendAudit(uid, e.id, 'exported', me.id, exportId, null);
      } catch {
        // Don't swallow silently (P7): a concurrent edit left this row
        // unstamped. Surfaced via the X-Stamp-Failures header below; the
        // hardened POST /finalise path additionally drops it from the CSV.
        stampFailures += 1;
      }
    }));
    res.setHeader('X-Export-Id', exportId);
    if (stampFailures) res.setHeader('X-Stamp-Failures', String(stampFailures));

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

  // Stamp the eligible entries FIRST, then build the committed CSV from only the
  // rows that actually stamped. A concurrent edit (#157 stale-write) between the
  // read and the stamp must NOT leave a row in the committed CSV that wasn't
  // marked exported — the next finalise would re-include that row and double-pay
  // it. Failed rows stay UNEXPORTED (self-healing: the next run picks them up)
  // and are surfaced, never silently swallowed (P7).
  const exportId = 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const stampedAt = new Date().toISOString();
  const touched = new Map();
  for (const r of eligibleRows) {
    const k = r.workerId + '|' + r.date;
    if (!touched.has(k)) touched.set(k, { userId: r.workerId, date: r.date });
  }
  const stampedKeys = new Set();
  const stampFailures = [];
  await Promise.all([...touched.values()].map(async ({ userId: uid, date: d }) => {
    const e = entries.find((x) => x.userId === uid && x.date === d);
    if (!e || e.exportId) return; // defensive: never re-stamp a row already in a run
    const updated = { ...e, exportedAt: stampedAt, exportId, updatedAt: stampedAt };
    try {
      await writeEntry(uid, updated);
      await appendAudit(uid, e.id, 'exported', me.id, exportId, null);
      stampedKeys.add(uid + '|' + d);
    } catch (err) {
      // Leave the entry UNEXPORTED so the next finalise re-includes it; never
      // claim a row was paid when its stamp didn't land.
      const conflict = !!(err && err.code === 'stale_write');
      stampFailures.push({
        userId: uid, date: d,
        code: conflict ? 'conflict' : 'error',
        error: conflict ? 'edited during export' : 'write failed',
      });
    }
  }));

  // BLOCK: nothing committed (every eligible row hit a concurrent edit). Emit no
  // CSV that claims otherwise — the entries are untouched, so the operator retries.
  if (!stampedKeys.size) {
    return res.status(409).json({
      error: 'Could not commit any rows — they were edited during the export. Nothing was stamped; try again.',
      code: 'stamp_conflict',
      stampFailures,
    });
  }

  // THIS run's CSV = only the rows that actually stamped, in the requested shape.
  // The hash is tamper-evident over exactly the committed rows.
  const committedRows = eligibleRows.filter((r) => stampedKeys.has(r.workerId + '|' + r.date));
  const { cols, toCells, csvFilename } = csvShape(shape, fromDate, toDate, status);
  const lines = [cols.map(csvCell).join(',')];
  for (const r of committedRows) lines.push(toCells(r).map(csvCell).join(','));
  const csv = lines.join('\n') + '\n';
  const csvHash = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');

  await appendRun({
    exportId, hash: csvHash, me, stampedAt,
    fromDate, toDate, status, userId: ctx.userId, jobId: ctx.jobId,
    rowCount: committedRows.length, summary: summarise(committedRows),
    extra: { newlyStamped: stampedKeys.size, stampFailures: stampFailures.length, alreadyExportedRows: alreadyRows.length, shape, via: 'finalise' },
  });
  await appendActivity({
    action: 'payroll.exported', scope: 'payroll', actor: me.id, actorName: me.username,
    target: `payroll/${exportId}`, targetLabel: `${fromDate} → ${toDate}`,
    meta: {
      exportId, hash: csvHash, rowCount: committedRows.length, via: 'finalise', shape,
      stampFailures: stampFailures.length,
      range: { fromDate, toDate, status }, summary: summarise(committedRows),
    },
  });

  res.setHeader('X-Export-Id', exportId);
  res.setHeader('X-Export-Hash', csvHash);
  res.setHeader('X-Row-Count', String(committedRows.length));
  res.setHeader('X-Already-Exported-Rows', String(alreadyRows.length));
  res.setHeader('X-Stamp-Failures', String(stampFailures.length));
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
