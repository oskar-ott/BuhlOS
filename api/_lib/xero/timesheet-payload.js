// Timesheet payload builder (#249) — PURE. No IO. Turns a locked payroll
// batch's items into Xero Payroll AU draft-timesheet payloads (one per
// employee), runs the pay-calendar alignment pre-flight, and computes a
// stable content hash the export layer keys idempotency off.
//
// Xero Payroll AU (payroll.xro/1.0) Timesheets contract — verified against the
// official docs + the #610 reference shapes (2026-07-13). Pinned in tests:
//   POST {PAYROLL_AU_BASE}/Timesheets
//   { "Timesheets": [ {
//       "EmployeeID": <guid>, "StartDate": "YYYY-MM-DD", "EndDate": "YYYY-MM-DD",
//       "Status": "DRAFT",
//       "TimesheetLines": [ { "EarningsRateID": <guid>,
//                             "NumberOfUnits": [ d0, d1, … dN ] } ] } ] }
//   StartDate/EndDate span the EMPLOYEE'S payroll-calendar period; NumberOfUnits
//   is one decimal PER DAY of that inclusive span (0 where nothing worked).
//   Status DRAFT only (ADR #609 — no APPROVED/PROCESSED writes here).
//
// Multi-job days MERGE to daily units per earnings rate — the job dimension is
// NOT carried onto Xero lines until #254 (the preview says so; the CSV keeps it).

const crypto = require('crypto');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Fixed-length AU calendar types we can auto-align a batch period to. Variable
// types (monthly/twice-monthly/quarterly) can't be derived from a length, so a
// batch against them is a named blocker (verify manually) — never fudged.
const PERIOD_DAYS = { WEEKLY: 7, FORTNIGHTLY: 14, FOURWEEKLY: 28 };

function parseDay(s) {
  // 'YYYY-MM-DD' → UTC ms at midnight (dates are calendar days, tz-free here).
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  return Date.parse(`${s}T00:00:00Z`);
}

function dayStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Inclusive list of 'YYYY-MM-DD' from start..end. [] if malformed/inverted. */
function daysInclusive(start, end) {
  const a = parseDay(start);
  const b = parseDay(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return [];
  const out = [];
  for (let t = a; t <= b; t += MS_PER_DAY) out.push(dayStr(t));
  return out;
}

/**
 * The calendar period (inclusive [start,end]) that CONTAINS `dateStr`, derived
 * from a fixed-length calendar anchored on its `startDate`. null when the type
 * has no fixed length or the inputs are malformed.
 */
function calendarPeriodContaining(calendar, dateStr) {
  const type = calendar && calendar.payload ? String(calendar.payload.calendarType || '').toUpperCase() : '';
  const len = PERIOD_DAYS[type];
  const anchor = parseDay(calendar && calendar.payload ? calendar.payload.startDate : null);
  const d = parseDay(dateStr);
  if (!len || !Number.isFinite(anchor) || !Number.isFinite(d)) return null;
  const n = Math.floor((d - anchor) / (len * MS_PER_DAY));
  const start = anchor + n * len * MS_PER_DAY;
  const end = start + (len - 1) * MS_PER_DAY;
  return { start: dayStr(start), end: dayStr(end), calendarType: type };
}

/**
 * Alignment verdict for a batch period against an employee's calendar. Aligned
 * only when the batch's [periodStart,periodEnd] EXACTLY equals a calendar
 * period — a partial period (a week against a fortnightly calendar) is a
 * blocker that shows the org's actual period, never a silently short timesheet.
 */
function alignmentFor(calendar, periodStart, periodEnd) {
  if (!calendar) {
    return { aligned: false, code: 'calendar_missing', message: 'The linked employee has no payroll calendar in the cached Xero reference data — refresh reference data or re-map.' };
  }
  const period = calendarPeriodContaining(calendar, periodStart);
  const type = calendar.payload ? String(calendar.payload.calendarType || '').toUpperCase() : '';
  if (!period) {
    return {
      aligned: false, code: 'calendar_unsupported',
      calendarType: type || null, calendarName: calendar.name || null,
      message: `The employee's Xero calendar "${calendar.name}" (${type || 'unknown type'}) has no fixed period length that a batch can be auto-aligned to — align the batch to the pay period manually.`,
    };
  }
  if (period.start !== periodStart || period.end !== periodEnd) {
    return {
      aligned: false, code: 'period_mismatch',
      calendarType: type, calendarName: calendar.name || null,
      calendarPeriod: { start: period.start, end: period.end },
      message: `Batch period ${periodStart} → ${periodEnd} does not match the employee's ${type.toLowerCase()} Xero pay period ${period.start} → ${period.end} — build the batch for the pay period.`,
    };
  }
  return { aligned: true, calendarType: type, calendarName: calendar.name || null, calendarPeriod: { start: period.start, end: period.end } };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Build one draft-timesheet payload per employee from a locked batch's items.
 *
 * @param {{
 *   items: Array<{ workerId: string, workerName: string, employeeId: string|null,
 *                  employeeName: string|null, earningsRateId: string|null,
 *                  earningsRateName: string|null, entryDate: string, hours: number }>,
 *   periodStart: string, periodEnd: string,
 *   employeesById: Map<string, { name: string, active: boolean, payload?: { payrollCalendarID?: string|null } }>,
 *   calendarsById: Map<string, { name: string, payload?: { calendarType?: string, startDate?: string } }>,
 * }} input
 * @returns {{ periodStart, periodEnd, workers: Array<{
 *   workerId, workerName, employeeId, employeeName, aligned: boolean,
 *   blocker: object|null, contentHash: string|null, timesheet: object|null,
 *   totalUnits: number, dayCount: number }> }}
 */
function buildTimesheets(input) {
  const { items = [], periodStart, periodEnd, employeesById, calendarsById } = input;

  // group items by employeeId, keeping worker identity for messaging
  const byEmployee = new Map();
  for (const it of items) {
    if (!it.employeeId) {
      // A locked batch has passed validation (all mapped), so this is
      // defensive — surface as a per-worker blocker rather than dropping.
      const key = `__unmapped__${it.workerId}`;
      if (!byEmployee.has(key)) byEmployee.set(key, { workerId: it.workerId, workerName: it.workerName, employeeId: null, employeeName: null, items: [] });
      byEmployee.get(key).items.push(it);
      continue;
    }
    if (!byEmployee.has(it.employeeId)) {
      byEmployee.set(it.employeeId, {
        workerId: it.workerId, workerName: it.workerName,
        employeeId: it.employeeId, employeeName: it.employeeName,
        items: [],
      });
    }
    byEmployee.get(it.employeeId).items.push(it);
  }

  const workers = [];
  for (const g of byEmployee.values()) {
    if (!g.employeeId) {
      workers.push(blockedWorker(g, { code: 'unmapped_worker', message: `${g.workerName} has no confirmed Xero employee link — map before exporting.` }));
      continue;
    }
    const employee = employeesById ? employeesById.get(g.employeeId) : null;
    const calendarId = employee && employee.payload ? employee.payload.payrollCalendarID : null;
    const calendar = calendarId && calendarsById ? calendarsById.get(calendarId) : null;

    const align = alignmentFor(calendar, periodStart, periodEnd);
    if (!align.aligned) {
      workers.push(blockedWorker(g, align));
      continue;
    }

    // any item missing an earnings-rate mapping blocks this worker (named)
    const unmappedType = g.items.find((it) => !it.earningsRateId);
    if (unmappedType) {
      workers.push(blockedWorker(g, { code: 'unmapped_earnings_rate', message: `${g.workerName} has hours with no confirmed Xero earnings-rate mapping — map before exporting.` }));
      continue;
    }

    const days = daysInclusive(align.calendarPeriod.start, align.calendarPeriod.end);
    const dayIndex = new Map(days.map((d, i) => [d, i]));

    // sum hours per earnings rate per day (multi-job merge)
    const byRate = new Map(); // rateId → { name, units: number[] }
    let outOfPeriod = 0;
    for (const it of g.items) {
      const idx = dayIndex.get(it.entryDate);
      if (idx === undefined) { outOfPeriod += 1; continue; }
      if (!byRate.has(it.earningsRateId)) {
        byRate.set(it.earningsRateId, { name: it.earningsRateName || null, units: days.map(() => 0) });
      }
      const line = byRate.get(it.earningsRateId);
      line.units[idx] = round2(line.units[idx] + Number(it.hours || 0));
    }
    if (outOfPeriod) {
      // items outside the aligned span — the batch validation should have
      // caught this; block loudly rather than silently truncate.
      workers.push(blockedWorker(g, { code: 'hours_outside_period', message: `${g.workerName} has ${outOfPeriod} hour row(s) outside the aligned pay period ${align.calendarPeriod.start} → ${align.calendarPeriod.end}.` }));
      continue;
    }

    const timesheetLines = [...byRate.entries()].map(([EarningsRateID, line]) => ({
      EarningsRateID,
      NumberOfUnits: line.units,
    }));
    const timesheet = {
      EmployeeID: g.employeeId,
      StartDate: align.calendarPeriod.start,
      EndDate: align.calendarPeriod.end,
      Status: 'DRAFT',
      TimesheetLines: timesheetLines,
    };
    const totalUnits = round2([...byRate.values()].reduce((n, l) => n + l.units.reduce((a, b) => a + b, 0), 0));

    workers.push({
      workerId: g.workerId, workerName: g.workerName,
      employeeId: g.employeeId, employeeName: g.employeeName || (employee ? employee.name : null),
      aligned: true, blocker: null,
      calendarName: align.calendarName,
      period: { start: align.calendarPeriod.start, end: align.calendarPeriod.end },
      dayCount: days.length,
      totalUnits,
      timesheet,
      contentHash: contentHashOf(timesheet),
    });
  }

  // stable worker order by name for deterministic previews/hashes
  workers.sort((a, b) => String(a.workerName).localeCompare(String(b.workerName)));
  return { periodStart, periodEnd, workers };
}

function blockedWorker(g, blocker) {
  return {
    workerId: g.workerId, workerName: g.workerName,
    employeeId: g.employeeId, employeeName: g.employeeName,
    aligned: false, blocker, contentHash: null, timesheet: null,
    totalUnits: 0, dayCount: 0,
  };
}

/**
 * Deterministic sha-256 over a timesheet's payload — stable across object key
 * order and line order, so an unchanged batch re-exports to the SAME hash
 * (idempotency) and a changed one differs.
 */
function contentHashOf(timesheet) {
  const lines = (timesheet.TimesheetLines || [])
    .map((l) => `${l.EarningsRateID}:${(l.NumberOfUnits || []).map((u) => round2(u)).join(',')}`)
    .sort();
  const canonical = JSON.stringify({
    e: timesheet.EmployeeID,
    s: timesheet.StartDate,
    d: timesheet.EndDate,
    st: timesheet.Status,
    l: lines,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

module.exports = {
  buildTimesheets,
  contentHashOf,
  alignmentFor,
  calendarPeriodContaining,
  daysInclusive,
  PERIOD_DAYS,
};
