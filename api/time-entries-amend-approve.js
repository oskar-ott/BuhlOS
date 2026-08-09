// "Fix the hours and approve" — amend a SUBMITTED time-entry's hours and
// approve it in ONE atomic action (owner-directed).
//
// The incident: a worker typed 8h 22m for a day that was 8h 36m. The office's
// only tools were approve (wrong pay), reject (the worker has to re-do it) or
// reopen (same, one step longer). None of them is "fix the obvious typo and
// move on", so this endpoint is that motion — with the guardrails pay demands:
//
//   - ADMIN TIER ONLY (isAdminRole). Leading hands keep approve/reject; a
//     correction to someone's pay is the boss's call for v1. Server-enforced.
//   - A REASON is required, exactly as reject requires one.
//   - Only a SUBMITTED entry can be amended — never a draft (not sent yet),
//     an already-approved day (reopen it first) or a rejected one.
//   - ONE write: the corrected hours and the approval land together, so there
//     is no half-amended in-between state a second request could catch. The
//     write goes through writeEntry's existing CAS (`expectedRev: entry.__rev`)
//     — a concurrent decision on the same day-file 409s instead of clobbering.
//   - The WORKER sees it: the entry carries amendedBy/amendedAt/amendedReason
//     and amendedFrom{totalHours, ordinaryHours, overtimeHours, allocations},
//     which the Phil hours screen renders as an honest line on that day. Pay
//     never moves invisibly. v1 is display-only acknowledgement — no
//     worker-signature flow is claimed or built.
//   - The SAME validation the worker's own submission gets (totals 0 < t ≤ 16,
//     allocations sum to the total, jobs must be real + active), plus the OT
//     split recomputed from the new total (autoSplitOT).
//
// Body: { userId, date, reason, totalHours?, allocations? }
//   - allocations (preferred, and REQUIRED for a split day):
//       [{ jobId, hours, notes? }, …] — the full replacement set.
//   - totalHours alone is accepted for a SINGLE-allocation day: that one
//     allocation moves to the new total (its job attribution is untouched).
//   Sending both is fine as long as they agree (±0.01) — the shared validator
//   is what says so.
//
// Gated by the existing `hours` core flag along with the rest of the hours
// workflow — this is a capability inside a live feature, not a new one.

const { setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const {
  readEntry,
  writeEntry,
  appendAudit,
  entryView,
  autoSplitOT,
  validateEntryShape,
  inactiveJobAllocationError,
  diffOf,
} = require('./_lib/time-entries');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { buildHoursAuditEntry } = require('./_lib/hours-audit');
const { sendPushToUserId } = require('./_lib/push');
const { appendActivity } = require('./_lib/activity');

const MAX_REASON_LENGTH = 500;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  // Admin tier only — a leading hand can approve or send back, but changing
  // what someone gets paid is the office's call (v1).
  if (!isAdminRole(user.role)) {
    return res.status(403).json({ error: 'forbidden — only the office can change someone’s hours' });
  }

  const { userId, date, reason, totalHours, allocations } = req.body || {};
  if (!userId || !date) return res.status(400).json({ error: 'userId and date required' });
  if (userId === user.id) return res.status(403).json({ error: 'cannot amend your own hours' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason required' });
  const trimmedReason = String(reason).trim().slice(0, MAX_REASON_LENGTH);

  const entry = await readEntry(userId, date);
  if (!entry) return res.status(404).json({ error: 'not found' });
  // 409, not 400: the day-file is in a state this action cannot act on, and the
  // fix is for the caller to re-read it (the queue already refreshes on 409).
  if (entry.status !== 'submitted') {
    return res.status(409).json({
      error: 'entry is not submitted — only hours waiting on a decision can be fixed here',
      currentStatus: entry.status,
    });
  }

  // ── Build the corrected allocations ─────────────────────────────────
  const existingAllocations = Array.isArray(entry.allocations) ? entry.allocations : [];
  let nextAllocations;
  if (Array.isArray(allocations)) {
    if (allocations.length === 0) return res.status(400).json({ error: 'at least one allocation required' });
    nextAllocations = allocations.map((a, i) => ({
      jobId: (a && a.jobId) || null,
      hours: Number(a && a.hours),
      notes: (a && a.notes) || null,
      sortOrder: i,
    }));
  } else if (typeof totalHours === 'number') {
    // Single-allocation shorthand: the whole day is on one job, so a new total
    // IS the new allocation. A split day has no single right answer — refuse
    // rather than guess how to spread the change across jobs.
    if (existingAllocations.length !== 1) {
      return res.status(400).json({
        error: 'this day is split across jobs — send each job’s hours in allocations',
      });
    }
    nextAllocations = [{
      jobId: existingAllocations[0].jobId || null,
      hours: Number(totalHours),
      notes: existingAllocations[0].notes || null,
      sortOrder: 0,
    }];
  } else {
    return res.status(400).json({ error: 'totalHours or allocations required' });
  }

  const allocationSum = nextAllocations.reduce((s, a) => s + (Number(a.hours) || 0), 0);
  const nextTotal = typeof totalHours === 'number'
    ? Math.round(Number(totalHours) * 100) / 100
    : Math.round(allocationSum * 100) / 100;
  // OT is re-derived from the corrected total — an amended day must never keep
  // a split that belonged to the old number. Date-aware: a weekend day books
  // as all overtime (owner-directed 2026-08-10).
  const split = autoSplitOT(nextTotal, entry.date);

  const candidate = {
    ...entry,
    totalHours: nextTotal,
    ordinaryHours: split.ordinary,
    overtimeHours: split.overtime,
    allocations: nextAllocations,
  };
  // Same validator the worker's submission runs, minus the backdating window:
  // the date isn't changing, so "cannot log more than 14 days in the past"
  // would only block correcting an old timesheet (see validateEntryShape).
  const errors = validateEntryShape(candidate, { skipDateWindow: true });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  // Jobs must be real and active — the SAME rule the field write paths use.
  const jobError = await inactiveJobAllocationError(nextAllocations);
  if (jobError) return res.status(400).json({ error: jobError });

  const now = new Date().toISOString();
  const updated = {
    ...candidate,
    status: 'approved',
    approvedBy: user.id,
    approvedAt: now,
    rejectedReason: null,
    // The split is system-derived again after an amend, whatever it was before.
    otOverridden: false,
    // ── Amendment metadata: what the worker (and payroll) is owed ──────
    amendedBy: user.id,
    amendedByName: user.name || user.username || null,
    amendedAt: now,
    amendedReason: trimmedReason,
    amendedFrom: {
      totalHours: Number(entry.totalHours) || 0,
      ordinaryHours: Number(entry.ordinaryHours) || 0,
      overtimeHours: Number(entry.overtimeHours) || 0,
      allocations: existingAllocations.map((a, i) => ({
        jobId: a.jobId || null,
        hours: Number(a.hours) || 0,
        notes: a.notes || null,
        sortOrder: a.sortOrder ?? i,
      })),
    },
    updatedBy: user.id,
    updatedByName: user.name || user.username || null,
    updatedAt: now,
  };

  try {
    await writeEntry(userId, updated);
  } catch (e) {
    if (e && e.code === 'stale_write') {
      // The day-file changed underneath this decision (concurrent approve/edit
      // — including the worker's own "change these hours"). Retryable: the
      // client re-reads and re-decides. Same contract as approve/reject.
      return res.status(409).json({ error: 'conflict', currentRev: e.currentRev });
    }
    throw e;
  }

  // Per-user audit trail — the diff carries totals/OT/status, the note the why.
  await appendAudit(
    userId,
    entry.id,
    'amended-approved',
    user.id,
    trimmedReason,
    diffOf(entry, updated),
  );

  // Global activity row (best-effort, same as approve/reject).
  await appendActivity({
    action: 'hours.amended_approved',
    scope:  'hours',
    actor:  user.id,
    actorName: user.username,
    target: `user:${userId}/${entry.date}`,
    targetLabel: `${entry.userName || userId} · ${entry.date}`,
    reason: trimmedReason,
    meta: {
      entryId: entry.id || null,
      fromTotalHours: Number(entry.totalHours) || 0,
      totalHours: nextTotal,
      jobIds: nextAllocations.map((a) => a.jobId).filter(Boolean),
    },
  });

  // #390 canonical audit-log entry (best-effort) — carries the reason AND the
  // before-total, so the journal answers "what changed", not just "it changed".
  appendAuditLog(
    buildHoursAuditEntry({
      action: 'hours.amended_approved',
      actor: user,
      entry: entryView(updated),
      reason: trimmedReason,
      extraMetadata: { fromTotalHours: Number(entry.totalHours) || 0 },
    }),
  ).catch(() => {});

  // Tell the worker their pay moved. Sent through sendPushToUserId directly —
  // the same class as the reject/reopen pushes (see the alwaysOn note in
  // api/_lib/notify.js): a change to someone's hours is not a notification they
  // should be able to mute into a silent pay change. Best-effort; the deep link
  // lands on /phil/hours, the screen that renders the adjustment line.
  sendPushToUserId(userId, {
    title: 'Hours adjusted and approved',
    body: `Your ${weekdayShort(entry.date)} hours were adjusted and approved — ${durationLabel(Number(entry.totalHours) || 0)} → ${durationLabel(nextTotal)}. Tap to see it.`,
    url: '/phil/hours',
    tag: 'buhl-hours-amended-' + entry.date,
  }).catch(() => {});

  return res.status(200).json({ entry: entryView(updated) });
};

/** "Tue" for a YYYY-MM-DD work date (dates are stored as plain local days). */
function weekdayShort(date) {
  try {
    return new Date(date + 'T00:00:00Z').toLocaleDateString('en-AU', {
      weekday: 'short',
      timeZone: 'UTC',
    });
  } catch {
    return date;
  }
}

/** Site dialect for a duration — "8h 36m", never a decimal (mirrors
 *  formatHoursLabel in src/domains/timesheets/format.ts). */
function durationLabel(decimalHours) {
  if (!Number.isFinite(decimalHours) || decimalHours <= 0) return '0h';
  const totalMinutes = Math.round(decimalHours * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}
