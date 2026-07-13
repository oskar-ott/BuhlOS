// Shared payroll CSV encoding + column shapes. ONE definition so every payroll
// CSV surface uses the same escaping and the same columns — the live pay-period
// preview (api/time-entries-export.js) and the locked-batch download
// (api/xero/timesheet-export.js `batchCsv`) can never drift (#895).
//
// PURE. No blob, no DB, no stamping. A CSV here is a report, never a commit —
// the only path that records a payroll run is the immutable batch flow.

// RFC-4180-ish cell: quote when the value contains a comma, quote or newline.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// header row + one row per record, each cell escaped. `toCells(row)` → array.
function toCsv(cols, rows, toCells) {
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(toCells(r).map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

// Short day-of-week label for the review CSV (Mon..Sun), local to the date.
function dayName(dateStr) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(dateStr + 'T00:00:00').getDay()];
}

// CSV column sets for the LIVE pay-period preview — payroll | review | xero.
// Period Start/End on review + xero = the REQUESTED range (the pay period the
// admin picked), not the per-row ISO week. area/stage/task are NOT on the row
// (allocations are jobId-only), so they are not invented. Moved verbatim from
// time-entries-export.js — the download shapes the office already relies on.
function csvShape(shape, fromDate, toDate, status) {
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

module.exports = { csvCell, toCsv, dayName, csvShape };
