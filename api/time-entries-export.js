// Payroll CSV export — READ-ONLY preview / download (#895 convergence).
//
// This endpoint no longer commits anything. The ONLY path that records a
// payroll run is now the immutable batch flow (Hours → Payroll period → Create
// batch → Validate → Lock → Export to Xero / Download CSV). Retiring the legacy
// stamp-based committed run removes the double-pay trap of a MUTATING GET that a
// browser could prefetch, bookmark, crawl or retry, and the parallel POST
// finalise path (payroll-boundary ADR #609, amended 2026-07-13 for export
// convergence — the locked batch is the single export source).
//
//   GET  — DOWNLOAD / PREVIEW only. `format=json` feeds the /hours/period
//          rollup; `format=csv` (default) streams a shape-selectable CSV
//          (payroll | review | xero); `format=pdf` streams the printable hours
//          sheet off the same rows. NEVER stamps entries, never logs a run.
//   POST — GONE (410). Finalise moved to the payroll-batch flow; the response
//          points there rather than silently no-op'ing.
//
// Default range = current ISO week. Override with ?fromDate=&toDate=&status=&userId=&jobId=
// Admin only — payroll data, hourly rates exposed.

const crypto = require('crypto');
const { setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
// #894 seam: the row engine lives in api/_lib/payroll-inputs.js so the payroll-
// batch foundation (#893) reads the SAME rows — no second engine.
const { collectRows } = require('./_lib/payroll-inputs');
// #895: CSV shaping + escaping is shared with the locked-batch CSV download
// (api/xero/timesheet-export.js) so the two payroll CSV surfaces can't drift.
const { csvShape, toCsv } = require('./_lib/payroll-csv');
// Same rows, printable container — the PDF composer is pure (no I/O).
const { composePayrollPdf } = require('./_lib/payroll-pdf');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  if (req.method === 'GET') return handleGet(req, res, me);
  if (req.method === 'POST') {
    // #895: the committed-run finalise is retired. A payroll run is recorded
    // only by locking a payroll batch and exporting it. Honest 410, not a
    // silent no-op — a caller that expected to stamp must LEARN it didn't.
    return res.status(410).json({
      error:
        'The payroll finalise endpoint has been retired. Record a payroll run by creating, ' +
        'validating and locking a batch on Hours → Payroll period, then Export to Xero or Download CSV.',
      code: 'gone',
      replacement: '/api/xero/payroll-batches',
    });
  }
  return res.status(405).json({ error: 'method not allowed' });
};

// ── GET — read-only download / preview (never stamps) ─────────────────────────
async function handleGet(req, res, me) {
  const q = req.query || {};
  const format = q.format || 'csv'; // 'csv' | 'json' (feeds the /hours/period rollup) | 'pdf'
  // #131 CSV shape: 'payroll' (default, full Karen/Daniel columns incl. rate
  // /cost), 'review' (human/admin, no rate/cost) or 'xero' (lean payroll BRIDGE;
  // NOT a Xero API push). Shape changes only the column set + filename.
  const shape = q.shape || 'payroll';

  const ctx = await collectRows({
    status: q.status || 'approved',
    userId: q.userId || '',
    jobId:  q.jobId  || '',
    fromDate: q.fromDate || '',
    toDate:   q.toDate   || '',
  });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const { rows, fromDate, toDate, status, userId, jobId } = ctx;

  if (format === 'json') {
    return res.status(200).json({
      // dryRun is always true now — this endpoint never stamps. Kept in the
      // response shape for the existing rollup consumers.
      range: { fromDate, toDate, status, userId: userId || null, jobId: jobId || null, dryRun: true },
      rows,
      summary: summarise(rows),
    });
  }

  // PDF — the printable sibling of the CSV, off the SAME rows (owner pull
  // 2026-08-10: "export the hours as a pdf as well as csv"). Equally read-only:
  // composing a document stamps nothing.
  if (format === 'pdf') {
    const generatedAtLabel = new Date().toISOString().slice(0, 10);
    const pdf = await composePayrollPdf({
      rows, fromDate, toDate, statusLabel: status, generatedAtLabel,
      // ?detail=0 → the one-page summary sheet without the day breakdown.
      includeDetail: String(q.detail || '1') !== '0',
    });
    const body = Buffer.from(pdf);
    res.setHeader('X-Export-Hash', crypto.createHash('sha256').update(body).digest('hex'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="buhlos-hours-' + fromDate + '-to-' + toDate + '.pdf"',
    );
    res.setHeader('X-Row-Count', String(rows.length));
    return res.status(200).send(body);
  }

  // CSV (shape-selectable: payroll default | review | xero) — a REPORT, never a
  // commit. No stamping, no run log, no activity. The SHA-256 header stays as
  // tamper-evidence for a downloaded file.
  const { cols, toCells, csvFilename } = csvShape(shape, fromDate, toDate, status);
  const csv = toCsv(cols, rows, toCells);
  const csvHash = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');

  res.setHeader('X-Export-Hash', csvHash);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + csvFilename + '"');
  res.setHeader('X-Row-Count', String(rows.length));
  res.status(200).send(csv);
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
