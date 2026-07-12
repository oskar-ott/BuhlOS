// Payroll validation engine (#894) — PURE. No IO: callers assemble the
// inputs (rows from the shared collector, mapping readiness, the reference
// cache) and this module answers ONE question two ways at once:
//
//   machine-readable:  { ready, errors: [{code, ...}], warnings: [...] }
//   human-readable:    every finding carries a `message` an office manager
//                      can act on without a translator
//
// ERRORS block a batch from becoming ready/locked. WARNINGS are visible but
// don't block (e.g. a terminated employee receiving final pay — #248's
// recorded decision). Nothing is ever silently dropped: every rule that
// excludes or flags something NAMES what it flagged.
//
// The same engine runs at preview, at batch creation and again at lock time
// (#893) — one rule set, no drift.

const STALE_REFERENCE_DAYS = 7; // matches reference-sync STALE_AFTER_DAYS

function finding(code, message, extra) {
  return { code, message, ...(extra || {}) };
}

/**
 * @param {{
 *   rows: Array<object>,            // ALL-status rows for the period (shared collector, status:'all')
 *   periodStart: string, periodEnd: string,
 *   workerReadiness: Array<{workerId: string, employeeId: string|null, mapped: boolean}>,
 *   worktypeReadiness: Array<{workType: string, label: string, rateId: string|null, mapped: boolean}>,
 *   employeesById: Map<string, {name: string, active: boolean, payload?: {status?: string, payrollCalendarID?: string|null}}>,
 *   ratesById: Map<string, {name: string, active: boolean}>,
 *   referenceSyncs: { employees?: {status: string, at: string}|null, pay_items?: {status: string, at: string}|null },
 *   connectionOrg: { batchOrg?: string|null, currentOrg: string },
 *   allowExported?: boolean,        // correction batches may include exported rows
 *   now?: number,
 * }} input
 */
function validatePayroll(input) {
  const errors = [];
  const warnings = [];
  const now = input.now || Date.now();
  const rows = input.rows || [];
  const approvedRows = rows.filter((r) => r.status === 'approved');

  // ── Hours approved: every entry in the period must be decided ─────────────
  const undecided = rows.filter((r) => r.status !== 'approved' && r.status !== 'rejected');
  if (undecided.length) {
    const workers = [...new Set(undecided.map((r) => r.workerName))].sort();
    errors.push(finding(
      'unapproved_entries',
      `${workers.length} worker(s) still have undecided hours in this period (${workers.join(', ')}) — approve or reject them on the weekly board first.`,
      { workers, count: undecided.length }
    ));
  }

  if (!approvedRows.length) {
    errors.push(finding('no_rows', 'No approved hours in this period — nothing to batch.'));
  }

  // ── Duplicate source entries (defensive — one entry per worker+date) ──────
  const seenEntry = new Map();
  const dupes = new Set();
  for (const r of approvedRows) {
    // rows are per-allocation; a worker+date+job+split appearing twice means a
    // duplicated SOURCE entry, which must never double-pay
    const k = `${r.workerId}|${r.date}|${r.jobId}|${r.hours}|${r.ordinaryHours}|${r.overtimeHours}`;
    if (seenEntry.has(k)) dupes.add(`${r.workerName} on ${r.date}`);
    seenEntry.set(k, true);
  }
  if (dupes.size) {
    errors.push(finding(
      'duplicate_source',
      `Duplicate hour rows detected (${[...dupes].sort().join('; ')}) — the source data needs fixing before payroll.`,
      { duplicates: [...dupes].sort() }
    ));
  }

  // ── Hours sanity: no negative/zero, ordinary+overtime must equal total ────
  const badHours = [];
  for (const r of approvedRows) {
    const total = Number(r.hours);
    const ord = Number(r.ordinaryHours);
    const ot = Number(r.overtimeHours);
    if (!(total > 0) || ord < 0 || ot < 0 || Math.abs(ord + ot - total) > 0.011) {
      badHours.push(`${r.workerName} ${r.date} (${r.hours}h = ${r.ordinaryHours} + ${r.overtimeHours})`);
    }
  }
  if (badHours.length) {
    errors.push(finding(
      'invalid_hours',
      `Hour splits don't add up on ${badHours.length} row(s): ${badHours.slice(0, 5).join('; ')}${badHours.length > 5 ? '…' : ''}.`,
      { rows: badHours }
    ));
  }

  // ── Dates inside the period (defensive against collector drift) ───────────
  const outOfRange = approvedRows.filter((r) => r.date < input.periodStart || r.date > input.periodEnd);
  if (outOfRange.length) {
    errors.push(finding(
      'date_out_of_period',
      `${outOfRange.length} row(s) fall outside ${input.periodStart} → ${input.periodEnd}.`,
      { count: outOfRange.length }
    ));
  }

  // ── Already exported (correction batches may include them, deliberately) ──
  if (!input.allowExported) {
    const exported = approvedRows.filter((r) => r.exportId);
    if (exported.length) {
      const ids = [...new Set(exported.map((r) => r.exportId))].sort();
      errors.push(finding(
        'already_exported',
        `${exported.length} row(s) are already in committed run(s) ${ids.join(', ')} — a normal batch must not pay them twice. Use a correction batch if they genuinely need re-processing.`,
        { count: exported.length, exportIds: ids }
      ));
    }
  }

  // ── Worker mapping (who gets paid) ─────────────────────────────────────────
  const readinessByWorker = new Map((input.workerReadiness || []).map((w) => [w.workerId, w]));
  const workersInPeriod = [...new Map(approvedRows.map((r) => [r.workerId, r.workerName])).entries()];
  const unmapped = workersInPeriod.filter(([id]) => !(readinessByWorker.get(id) || {}).mapped);
  if (unmapped.length) {
    const names = unmapped.map(([, name]) => name).sort();
    errors.push(finding(
      'unmapped_workers',
      `${names.length} worker(s) have no confirmed Xero employee link (${names.join(', ')}) — link them on the Xero settings page.`,
      { workers: names }
    ));
  }

  // mapped-but-broken links: employee vanished / no payroll calendar / terminated
  const missingEmployee = [];
  const noCalendar = [];
  const terminated = [];
  for (const [workerId, workerName] of workersInPeriod) {
    const r = readinessByWorker.get(workerId);
    if (!r || !r.mapped) continue;
    const emp = input.employeesById ? input.employeesById.get(r.employeeId) : null;
    if (!emp) {
      missingEmployee.push(workerName);
      continue;
    }
    if (!((emp.payload && emp.payload.payrollCalendarID) || null)) noCalendar.push(workerName);
    if (!emp.active) terminated.push(workerName);
  }
  if (missingEmployee.length) {
    errors.push(finding(
      'employee_missing',
      `${missingEmployee.length} linked Xero employee(s) no longer exist in the connected org (${missingEmployee.sort().join(', ')}) — re-link or refresh the reference data.`,
      { workers: missingEmployee.sort() }
    ));
  }
  if (noCalendar.length) {
    errors.push(finding(
      'employee_no_calendar',
      `${noCalendar.length} linked employee(s) have no payroll calendar in Xero (${noCalendar.sort().join(', ')}) — assign one in Xero, then refresh.`,
      { workers: noCalendar.sort() }
    ));
  }
  if (terminated.length) {
    warnings.push(finding(
      'employee_terminated',
      `${terminated.length} linked employee(s) are terminated in Xero (${terminated.sort().join(', ')}) — allowed for a final pay, but check it's intended.`,
      { workers: terminated.sort() }
    ));
  }

  // ── Work-type mapping (what kind of hours) ─────────────────────────────────
  const usedWorkTypes = new Set();
  for (const r of approvedRows) {
    if (Number(r.ordinaryHours) > 0) usedWorkTypes.add('ordinary');
    if (Number(r.overtimeHours) > 0) usedWorkTypes.add('overtime');
  }
  const wtByKey = new Map((input.worktypeReadiness || []).map((w) => [w.workType, w]));
  const unmappedTypes = [...usedWorkTypes].filter((k) => !(wtByKey.get(k) || {}).mapped).sort();
  if (unmappedTypes.length) {
    errors.push(finding(
      'unmapped_work_types',
      `Work type(s) in this period have no confirmed Xero earnings rate: ${unmappedTypes.join(', ')} — a work type never silently defaults to ordinary. Map them on the Xero settings page.`,
      { workTypes: unmappedTypes }
    ));
  }
  const brokenRates = [];
  for (const k of usedWorkTypes) {
    const wt = wtByKey.get(k);
    if (!wt || !wt.mapped) continue;
    const rate = input.ratesById ? input.ratesById.get(wt.rateId) : null;
    if (!rate) brokenRates.push(`${k} → ${wt.rateName || wt.rateId} (rate no longer in Xero)`);
    else if (!rate.active) brokenRates.push(`${k} → ${rate.name} (rate inactive in Xero)`);
  }
  if (brokenRates.length) {
    errors.push(finding(
      'earnings_rate_broken',
      `Earnings-rate mapping(s) are broken: ${brokenRates.sort().join('; ')} — remap before payroll.`,
      { mappings: brokenRates.sort() }
    ));
  }

  // ── Reference freshness (the cache validation runs against) ───────────────
  const staleCutoff = now - STALE_REFERENCE_DAYS * 24 * 60 * 60 * 1000;
  for (const [group, label] of [['employees', 'employees'], ['pay_items', 'pay items']]) {
    const sync = input.referenceSyncs ? input.referenceSyncs[group] : null;
    const okAt = sync && sync.status === 'ok' ? new Date(sync.at).getTime() : null;
    if (okAt === null || okAt < staleCutoff) {
      errors.push(finding(
        'stale_reference',
        `The Xero ${label} reference data ${okAt === null ? 'has never been imported' : `is older than ${STALE_REFERENCE_DAYS} days`} — refresh it before batching payroll.`,
        { group }
      ));
      break; // one honest stale finding is enough to act on
    }
  }

  // ── Organisation match (batch snapshots vs the live connection) ───────────
  if (input.connectionOrg && input.connectionOrg.batchOrg
      && input.connectionOrg.batchOrg !== input.connectionOrg.currentOrg) {
    errors.push(finding(
      'org_mismatch',
      'This batch was built against a different Xero organisation than the one currently connected — recreate it.',
    ));
  }

  return {
    ready: errors.length === 0,
    errors,
    warnings,
    summary: {
      approvedRowCount: approvedRows.length,
      workerCount: workersInPeriod.length,
      totalHours: Math.round(approvedRows.reduce((n, r) => n + Number(r.hours || 0), 0) * 100) / 100,
      ordinaryHours: Math.round(approvedRows.reduce((n, r) => n + Number(r.ordinaryHours || 0), 0) * 100) / 100,
      overtimeHours: Math.round(approvedRows.reduce((n, r) => n + Number(r.overtimeHours || 0), 0) * 100) / 100,
    },
  };
}

module.exports = { validatePayroll, STALE_REFERENCE_DAYS };
