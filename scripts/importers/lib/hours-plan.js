// Hours parity dry-run planner — PURE. No I/O, no Supabase, no Blob.
//
// Input: parsed legacy sources —
//   users:       { users: [{ id, ... }] }            (user_profiles ref set)
//   jobs:        { jobs:  [{ id, ... }] }             (allocation job ref set)
//   entries:     [{ userId, date, entry }]            one per time-entry blob;
//                userId/date come from the BLOB PATH (authoritative), `entry`
//                is the parsed users/<id>/time-entries/<date>.json object
//   payrollRuns: { runs: [...] }                      payroll-runs.json
//
// Output: proposed inserts for the hours slice (time_entries,
// time_entry_allocations, payroll_runs) + parity numbers + the quarantine
// buckets the importer contract requires. timesheet_approvals is
// DELIBERATELY never proposed: weekly closeout is a projection over daily
// entries today (no durable store), so that table stays empty at import.
//
// Rules mirrored from production (NOT reinvented):
//   * one entry per user per day — schema unique (tenant_id,user_id,work_date)
//   * ordinary+overtime == total, total in (0,16] — schema CHECKs +
//     api/_lib/time-entries.js validateEntryShape
//   * allocation hours sum == total (±0.011) — validateEntryShape
//   * allocation jobId null == "Internal (no job)" — real, not an error
//   * week start = Monday (ISO) — src/domains/timesheets/service.ts weekStartOf
//   * statuses draft|submitted|approved|rejected — VALID_STATUSES
// Contract: docs/supabase-importer-plan.md · audit: docs/supabase-hours-dry-run-report.md.

const VALID_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];
const MAX_HOURS_PER_DAY = 16;
const TOLERANCE = 0.011; // matches schema CHECK abs(...) < 0.011

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ISO Monday week-start for a YYYY-MM-DD string. UTC arithmetic so it is
// timezone-independent — identical to service.ts weekStartOf.
function weekStartOf(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDay(); // 0 Sun … 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function isMonday(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date + 'T00:00:00Z');
  return d.getUTCDay() === 1;
}

function isValidISODate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === date; // rejects 2026-02-30 etc.
}

function addInc(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

function buildHoursImportPlan(sources) {
  const users = sources && sources.users;
  const jobs = sources && sources.jobs;
  const entryRecords = (sources && sources.entries) || [];
  const payrollRuns = sources && sources.payrollRuns;

  const plan = {
    tables: {
      time_entries: { inserts: 0, updates: 0 },
      time_entry_allocations: { inserts: 0, updates: 0 },
      payroll_runs: { inserts: 0, updates: 0 },
      timesheet_approvals: {
        inserts: 0,
        updates: 0,
        note: 'projection-only today (no durable closeout store) — stays empty at import by design',
      },
    },
    hardErrors: [],
    warnings: [],
    missingUserRefs: [],
    missingJobRefs: [],
    duplicateUserDate: [],
    invalidDates: [],
    invalidStatuses: [],
    invalidHourTotals: [],
    ordinaryOvertimeMismatch: [],
    over16Violations: [],
    allocationSumMismatch: [],
    weekStartNonMonday: [],
    reopenApprovalInconsistencies: [],
    quarantined: [],
    summary: {
      sources: { users: 0, jobs: 0, entryBlobs: 0, payrollRuns: 0 },
      usersDiscovered: 0,
      usersWithEntries: 0,
      datesDiscovered: 0,
      weekStartsDiscovered: 0,
      entriesByUser: {}, // userId → count (valid entries)
      entriesByDate: {}, // date → count
      entriesByStatus: { draft: 0, submitted: 0, approved: 0, rejected: 0 },
      totalHours: 0,
      ordinaryHours: 0,
      overtimeHours: 0,
      allocationTotal: 0,
      allocationByJob: {}, // jobId|"__internal__" → hours
      internalAllocationTotal: 0,
      hoursByUserWeek: {}, // `${userId}|${weekStart}` → hours
      hoursByJobWeek: {}, // `${jobId|__internal__}|${weekStart}` → hours
      statusHoursByWeek: {}, // weekStart → { submitted, approved, rejected }
      payrollRunCount: 0,
      payrollRunRowCountTotal: 0,
      updatesNote: 'target known-empty; idempotent re-runs match on (user_id,work_date)/legacy_id',
      clean: false,
    },
  };

  const userIds = new Set(
    users && Array.isArray(users.users) ? users.users.map((u) => u && u.id).filter(Boolean) : null
  );
  const haveUsers = users && Array.isArray(users.users);
  const jobIds = new Set(
    jobs && Array.isArray(jobs.jobs) ? jobs.jobs.map((j) => j && j.id).filter(Boolean) : []
  );
  if (!haveUsers) plan.hardErrors.push('users.json missing or not of shape { users: [] } — cannot validate user refs');
  plan.summary.sources.users = haveUsers ? users.users.length : 0;
  plan.summary.sources.jobs = jobs && Array.isArray(jobs.jobs) ? jobs.jobs.length : 0;
  plan.summary.usersDiscovered = userIds.size;

  const seenUserDate = new Set();
  const usersWithEntries = new Set();
  const datesSeen = new Set();
  const weekStartsSeen = new Set();

  for (const rec of entryRecords) {
    plan.summary.sources.entryBlobs += 1;
    const userId = rec && rec.userId;
    const pathDate = rec && rec.date;
    const e = (rec && rec.entry) || null;
    const ref = `${userId || '?'}|${pathDate || '?'}`;

    if (!e || typeof e !== 'object') {
      plan.hardErrors.push(`unreadable/empty entry blob at ${ref}`);
      plan.quarantined.push({ ref, reason: 'unreadable or empty JSON' });
      continue;
    }

    let quarantine = null;
    const q = (reason) => {
      if (!quarantine) quarantine = reason;
    };

    // date — path is authoritative; flag entry/path disagreement
    if (!isValidISODate(pathDate)) {
      plan.invalidDates.push({ ref, value: pathDate });
      q('invalid date key');
    }
    if (e.date && e.date !== pathDate) {
      plan.warnings.push(`entry.date "${e.date}" disagrees with blob path date "${pathDate}" (${ref}) — path wins`);
    }

    // duplicate (path guarantees uniqueness, but check defensively)
    if (seenUserDate.has(ref)) {
      plan.duplicateUserDate.push({ ref });
      q('duplicate user+date');
    }
    seenUserDate.add(ref);

    // user ref
    if (haveUsers && userId && !userIds.has(userId)) {
      plan.missingUserRefs.push({ ref, userId });
      q('user not in users.json');
    }

    // status
    const status = e.status || 'draft';
    if (!VALID_STATUSES.includes(status)) {
      plan.invalidStatuses.push({ ref, value: status });
      q('invalid status');
    }

    // hour totals
    const total = Number(e.totalHours);
    const ordinary = Number(e.ordinaryHours);
    const overtime = Number(e.overtimeHours);
    if (!(total > 0)) {
      plan.invalidHourTotals.push({ ref, reason: 'totalHours must be > 0', value: e.totalHours });
      q('invalid total hours');
    }
    if (total > MAX_HOURS_PER_DAY) {
      plan.over16Violations.push({ ref, total });
      q('total exceeds 16h/day');
    }
    if (!(ordinary >= 0) || !(overtime >= 0)) {
      plan.invalidHourTotals.push({ ref, reason: 'ordinary/overtime must be >= 0', ordinary: e.ordinaryHours, overtime: e.overtimeHours });
      q('invalid ordinary/overtime');
    } else if (total > 0 && Math.abs(ordinary + overtime - total) >= TOLERANCE) {
      plan.ordinaryOvertimeMismatch.push({ ref, ordinary, overtime, total });
      q('ordinary + overtime != total');
    }

    // allocations
    const allocations = Array.isArray(e.allocations) ? e.allocations : null;
    if (!allocations || allocations.length === 0) {
      plan.invalidHourTotals.push({ ref, reason: 'at least one allocation required' });
      q('no allocations');
    } else {
      let allocSum = 0;
      let badJobRef = false;
      allocations.forEach((a, i) => {
        const h = Number(a && a.hours);
        if (!(h > 0)) {
          plan.invalidHourTotals.push({ ref, reason: `allocation[${i}].hours must be > 0`, value: a && a.hours });
          q('allocation hours <= 0');
        } else {
          allocSum += h;
        }
        const jobId = a && a.jobId;
        if (jobId != null && jobIds.size && !jobIds.has(jobId)) {
          plan.missingJobRefs.push({ ref, allocationIndex: i, jobId });
          badJobRef = true;
        }
      });
      if (badJobRef) q('allocation references a job not in jobs.json');
      if (total > 0 && Math.abs(allocSum - total) >= TOLERANCE) {
        plan.allocationSumMismatch.push({ ref, allocSum: round2(allocSum), total });
        q('allocation hours do not sum to total');
      }
    }

    // week start must be Monday (data sanity; code computes it, so a non-Monday
    // would be a date bug — reported for completeness)
    const ws = weekStartOf(pathDate);
    if (ws && !isMonday(ws)) {
      plan.weekStartNonMonday.push({ ref, weekStart: ws });
    }

    // cross-field consistency (warnings — schema does not enforce these)
    if (status === 'approved' && !e.approvedAt && !e.approvedBy) {
      plan.reopenApprovalInconsistencies.push({ ref, reason: 'status approved but no approvedAt/approvedBy' });
    }
    if (status === 'rejected' && !e.rejectedReason) {
      plan.reopenApprovalInconsistencies.push({ ref, reason: 'status rejected but no rejectedReason' });
    }
    if (e.exportId && status !== 'approved') {
      plan.reopenApprovalInconsistencies.push({ ref, reason: `exportId set but status is "${status}" (expected approved)` });
    }

    if (quarantine) {
      plan.quarantined.push({ ref, reason: quarantine });
      continue;
    }

    // ── VALID entry → counts ────────────────────────────────────────────
    plan.tables.time_entries.inserts += 1;
    plan.tables.time_entry_allocations.inserts += allocations.length;
    usersWithEntries.add(userId);
    datesSeen.add(pathDate);
    if (ws) weekStartsSeen.add(ws);
    addInc(plan.summary.entriesByUser, userId);
    addInc(plan.summary.entriesByDate, pathDate);
    plan.summary.entriesByStatus[status] += 1;
    plan.summary.totalHours = round2(plan.summary.totalHours + total);
    plan.summary.ordinaryHours = round2(plan.summary.ordinaryHours + ordinary);
    plan.summary.overtimeHours = round2(plan.summary.overtimeHours + overtime);

    for (const a of allocations) {
      const h = Number(a.hours) || 0;
      const key = a.jobId == null ? '__internal__' : a.jobId;
      plan.summary.allocationTotal = round2(plan.summary.allocationTotal + h);
      addInc(plan.summary.allocationByJob, key, h);
      if (a.jobId == null) plan.summary.internalAllocationTotal = round2(plan.summary.internalAllocationTotal + h);
      if (ws) addInc(plan.summary.hoursByJobWeek, `${key}|${ws}`, h);
    }
    if (ws) {
      addInc(plan.summary.hoursByUserWeek, `${userId}|${ws}`, total);
      if (!plan.summary.statusHoursByWeek[ws]) {
        plan.summary.statusHoursByWeek[ws] = { submitted: 0, approved: 0, rejected: 0 };
      }
      if (status === 'submitted' || status === 'approved' || status === 'rejected') {
        plan.summary.statusHoursByWeek[ws][status] = round2(
          plan.summary.statusHoursByWeek[ws][status] + total
        );
      }
    }
  }

  // round the accumulator maps
  for (const k of Object.keys(plan.summary.allocationByJob)) plan.summary.allocationByJob[k] = round2(plan.summary.allocationByJob[k]);
  for (const k of Object.keys(plan.summary.hoursByUserWeek)) plan.summary.hoursByUserWeek[k] = round2(plan.summary.hoursByUserWeek[k]);
  for (const k of Object.keys(plan.summary.hoursByJobWeek)) plan.summary.hoursByJobWeek[k] = round2(plan.summary.hoursByJobWeek[k]);

  plan.summary.usersWithEntries = usersWithEntries.size;
  plan.summary.datesDiscovered = datesSeen.size;
  plan.summary.weekStartsDiscovered = weekStartsSeen.size;

  // ── payroll runs ──────────────────────────────────────────────────────
  const runs = payrollRuns && Array.isArray(payrollRuns.runs) ? payrollRuns.runs : null;
  if (payrollRuns && !runs) {
    plan.warnings.push('payroll-runs.json present but not of shape { runs: [] }');
  }
  if (runs) {
    plan.summary.sources.payrollRuns = runs.length;
    const seenExportIds = new Set();
    for (const r of runs) {
      if (!r || !r.exportId) {
        plan.warnings.push('payroll run missing exportId — would import without legacy_export_id');
      } else if (seenExportIds.has(r.exportId)) {
        plan.duplicateUserDate.push({ ref: `payroll_run:${r.exportId}`, reason: 'duplicate exportId' });
        continue;
      } else {
        seenExportIds.add(r.exportId);
      }
      if (r && r.range && (!isValidISODate(r.range.fromDate) || !isValidISODate(r.range.toDate))) {
        plan.warnings.push(`payroll run ${r.exportId || '(no id)'} has a non-ISO range`);
      }
      plan.tables.payroll_runs.inserts += 1;
      plan.summary.payrollRunCount += 1;
      plan.summary.payrollRunRowCountTotal += Number(r && r.rowCount) || 0;
    }
  }

  plan.summary.clean =
    plan.hardErrors.length === 0 &&
    plan.quarantined.length === 0 &&
    plan.missingUserRefs.length === 0 &&
    plan.missingJobRefs.length === 0 &&
    plan.duplicateUserDate.length === 0 &&
    plan.invalidDates.length === 0 &&
    plan.invalidStatuses.length === 0 &&
    plan.invalidHourTotals.length === 0 &&
    plan.ordinaryOvertimeMismatch.length === 0 &&
    plan.over16Violations.length === 0 &&
    plan.allocationSumMismatch.length === 0 &&
    plan.weekStartNonMonday.length === 0;
  return plan;
}

module.exports = {
  buildHoursImportPlan,
  weekStartOf,
  isMonday,
  isValidISODate,
  VALID_STATUSES,
  MAX_HOURS_PER_DAY,
};
