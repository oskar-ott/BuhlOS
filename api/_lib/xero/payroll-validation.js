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
// Withhold-and-warn (2026-07-26 owner-ratified, lean-reset replica): workers
// with NO confirmed Xero employee link no longer block the whole batch — their
// rows are WITHHELD (excluded from the batch, named in a warning + the
// validation's `withheldWorkers` list) and everyone else pushes. Withheld rows
// keep no exportId stamp, so a follow-up batch picks them up once the worker
// is mapped. The old blocking `unmapped_workers` ERROR remains only for the
// degenerate case where NO payable worker is mapped (nothing to push).
// Mapped-but-broken links (employee_missing / employee_no_calendar) stay
// ERRORS — that is corruption, not onboarding lag.
//
// The same engine runs at preview, at batch creation and again at lock time
// (#893) — one rule set, no drift.

const STALE_REFERENCE_DAYS = 7; // matches reference-sync STALE_AFTER_DAYS

function finding(code, message, extra) {
  return { code, message, ...(extra || {}) };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * PURE partition of a period's rows into what a batch may pay and what it must
 * leave out. The batch service and validatePayroll both key off THIS function
 * so the snapshot and the findings can never drift.
 *
 * - `exportedRows` (normal batches only): approved rows already in a committed
 *   run — a normal batch NEVER pays them twice, so they are excluded up front
 *   (correction batches include them deliberately via `allowExported`).
 * - `withheldRows` / `withheldWorkers`: approved payable rows belonging to
 *   workers with no confirmed Xero employee link — withheld with a warning,
 *   UNLESS no payable worker is mapped at all (then nothing is withheld and
 *   validatePayroll raises the blocking `unmapped_workers` error instead).
 * - `includedRows`: what the batch snapshots, hashes and exports.
 *
 * @param {{ rows: Array<object>, workerReadiness: Array<{workerId: string, mapped: boolean}>, allowExported?: boolean }} input
 */
// Roles paid OUTSIDE Xero payroll (owner decision 2026-08-02): subbies invoice
// the business directly. Their approved hours stay in job costing but are
// excluded here BEFORE the mapped/unmapped maths — so an unmapped subbie never
// raises the "link them in Xero" warning and can never block a batch.
const OUTSIDE_PAYROLL_ROLES = new Set(['subcontractor']);

function isOutsidePayrollRow(r) {
  return OUTSIDE_PAYROLL_ROLES.has(String(r.workerRole || '').toLowerCase());
}

function partitionPayrollRows({ rows, workerReadiness, allowExported }) {
  const decidedRows = (rows || []).filter((r) => r.status === 'approved');
  const outsideRows = decidedRows.filter(isOutsidePayrollRow);
  const outsideWorkers = [...new Map(outsideRows.map((r) => [r.workerId, { workerId: r.workerId, workerName: r.workerName }])).values()];
  const approvedRows = decidedRows.filter((r) => !isOutsidePayrollRow(r));
  const exportedRows = allowExported ? [] : approvedRows.filter((r) => r.exportId);
  const payableRows = allowExported ? approvedRows : approvedRows.filter((r) => !r.exportId);

  const readinessByWorker = new Map((workerReadiness || []).map((w) => [w.workerId, w]));
  const isMapped = (workerId) => Boolean((readinessByWorker.get(workerId) || {}).mapped);
  const payableWorkerIds = [...new Set(payableRows.map((r) => r.workerId))];
  const mappedPayableCount = payableWorkerIds.filter(isMapped).length;
  // Degenerate case: payable workers exist but NONE is mapped — nothing to
  // push, so nothing is withheld; the validator blocks with `unmapped_workers`.
  const allUnmapped = payableWorkerIds.length > 0 && mappedPayableCount === 0;

  const includedRows = [];
  const withheldRows = allUnmapped ? [] : payableRows.filter((r) => !isMapped(r.workerId));
  for (const r of payableRows) {
    if (!allUnmapped && !isMapped(r.workerId)) continue;
    includedRows.push(r);
  }

  const withheldByWorker = new Map();
  for (const r of withheldRows) {
    const w = withheldByWorker.get(r.workerId) || { workerId: r.workerId, workerName: r.workerName, hours: 0 };
    w.hours = round2(w.hours + Number(r.hours || 0));
    withheldByWorker.set(r.workerId, w);
  }
  const withheldWorkers = [...withheldByWorker.values()]
    .sort((a, b) => String(a.workerName).localeCompare(String(b.workerName)));

  return { approvedRows, includedRows, withheldRows, withheldWorkers, exportedRows, allUnmapped, outsideRows, outsideWorkers };
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
  const partition = partitionPayrollRows({
    rows,
    workerReadiness: input.workerReadiness,
    allowExported: input.allowExported,
  });
  const { approvedRows, includedRows, withheldWorkers, exportedRows, allUnmapped, outsideRows, outsideWorkers } = partition;

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
    errors.push(finding(
      'no_rows',
      outsideRows.length
        ? 'Only subcontractor hours in this period — they stay in job costing (subbies invoice directly), so there is nothing to push to Xero.'
        : 'No approved hours in this period — nothing to batch.',
    ));
  }

  // ── Subcontractor hours (owner decision 2026-08-02) ───────────────────────
  // Tracked against jobs for costing; subbies invoice the business directly,
  // so these rows are never part of the push. Calm information — no action.
  if (approvedRows.length && outsideWorkers.length) {
    const names = outsideWorkers.map((w) => w.workerName).sort();
    const h = round2(outsideRows.reduce((s, r) => s + (Number(r.hours) || 0), 0));
    warnings.push(finding(
      'subcontractor_hours_excluded',
      `${names.join(', ')} — subcontractor hours (${h}h) stay in job costing and are never pushed to Xero. Nothing to do.`,
      { workers: names, hours: h }
    ));
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
  // A normal batch EXCLUDES committed rows rather than paying them twice. If
  // that leaves nothing else payable the batch is blocked (the old error); a
  // partial overlap (e.g. a follow-up batch after a withheld worker was
  // mapped) is a named warning and the rest pushes.
  if (exportedRows.length) {
    const ids = [...new Set(exportedRows.map((r) => r.exportId))].sort();
    const payableLeft = approvedRows.length - exportedRows.length;
    if (payableLeft === 0) {
      errors.push(finding(
        'already_exported',
        `${exportedRows.length} row(s) are already in committed run(s) ${ids.join(', ')} — a normal batch must not pay them twice. Use a correction batch if they genuinely need re-processing.`,
        { count: exportedRows.length, exportIds: ids }
      ));
    } else {
      warnings.push(finding(
        'already_exported_excluded',
        `${exportedRows.length} row(s) are already in committed run(s) ${ids.join(', ')} — they stay out of this batch so nothing is paid twice.`,
        { count: exportedRows.length, exportIds: ids }
      ));
    }
  }

  // ── Worker mapping (who gets paid) ─────────────────────────────────────────
  // 2026-07-26 owner-ratified (lean-reset replica): unmapped workers are
  // WITHHELD with a warning — the rest of the batch pushes. Blocking-error only
  // when NO payable worker is mapped (nothing to push).
  const readinessByWorker = new Map((input.workerReadiness || []).map((w) => [w.workerId, w]));
  const workersInPeriod = [...new Map(includedRows.map((r) => [r.workerId, r.workerName])).entries()];
  if (allUnmapped) {
    const names = [...new Map(includedRows.map((r) => [r.workerId, r.workerName])).values()].sort();
    errors.push(finding(
      'unmapped_workers',
      `${names.length} worker(s) have no confirmed Xero employee link (${names.join(', ')}) — link them on the Xero settings page.`,
      { workers: names }
    ));
  } else if (withheldWorkers.length) {
    const names = withheldWorkers.map((w) => w.workerName);
    warnings.push(finding(
      'unmapped_workers_withheld',
      `${names.join(', ')} — no Xero employee ID yet, so those hours stay out of this push. Link them on the Xero settings page, then run a follow-up batch.`,
      { workers: names, withheldWorkers }
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

  // ── Work-type mapping (what kind of hours) — scoped to the rows this batch
  // actually pushes: a withheld worker's overtime must not freeze a batch that
  // contains no overtime.
  const usedWorkTypes = new Set();
  for (const r of includedRows) {
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
    // What THIS batch pays (withheld/committed rows excluded) — the honest
    // numbers for "what goes to Xero". Withheld hours are itemised alongside.
    summary: {
      approvedRowCount: includedRows.length,
      workerCount: workersInPeriod.length,
      totalHours: Math.round(includedRows.reduce((n, r) => n + Number(r.hours || 0), 0) * 100) / 100,
      ordinaryHours: Math.round(includedRows.reduce((n, r) => n + Number(r.ordinaryHours || 0), 0) * 100) / 100,
      overtimeHours: Math.round(includedRows.reduce((n, r) => n + Number(r.overtimeHours || 0), 0) * 100) / 100,
    },
    // [{workerId, workerName, hours}] — unmapped workers whose hours this
    // batch withholds (empty when everyone payable is mapped). Persisted on
    // the batch via its validation snapshot; surfaced by preview + batch GET.
    withheldWorkers,
  };
}

module.exports = { validatePayroll, partitionPayrollRows, STALE_REFERENCE_DAYS };
