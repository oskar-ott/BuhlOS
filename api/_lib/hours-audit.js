'use strict';

// Pure payload builders for hours / time-entry audit-log entries (#390).
//
// The office approvals pass (approve / reject / reject-undo / reopen, plus the
// two bulk variants) was absent from the canonical audit journal
// (api/_lib/audit-log.js), so the cross-job activity feed (#220) and per-job
// history could not honestly show it. These builders shape the `append` payload;
// the handlers call appendAuditLog(builder(...)).catch(() => {}) AFTER the
// payroll mutation lands, so a journal failure never blocks the decision.
//
// Privacy line: a timesheet decision records who/when, the target worker + day,
// the resulting status and TOTAL HOURS, and the job ids touched — never any
// dollar amount or pay rate.

/** The job ids an entry's allocations touch (deduped, falsy dropped). */
function jobIdsOf(entry) {
  const ids = ((entry && entry.allocations) || []).map((a) => a && a.jobId).filter(Boolean);
  return [...new Set(ids)];
}

/**
 * Build the audit-log payload for a SINGLE time-entry decision.
 * @param {{ action: string, actor: {id:string, username?:string, role?:string},
 *           entry: object, reason?: string|null }} input
 */
function buildHoursAuditEntry({ action, actor, entry, reason }) {
  const jobIds = jobIdsOf(entry);
  const totalHours = Number(entry && entry.totalHours) || 0;
  const userName = (entry && entry.userName) || null;
  return {
    action,
    actorId: (actor && actor.id) || '',
    actorName: (actor && actor.username) || '',
    actorRole: (actor && actor.role) || null,
    // Top-level jobId is the first touched job so the per-job feed surfaces it;
    // every touched job is in metadata.jobIds.
    jobId: jobIds[0] || null,
    targetType: 'time_entry',
    targetId: (entry && entry.id) || `${entry && entry.userId}:${entry && entry.date}`,
    // /_/g (not a single replace): hours.edited_while_submitted has two
    // underscores; existing single-underscore actions render identically.
    summary: `${(actor && actor.username) || 'someone'} ${action.replace('hours.', '').replace(/_/g, ' ')} ${userName || (entry && entry.userId)}'s hours for ${entry && entry.date}`.slice(0, 240),
    metadata: {
      userId: (entry && entry.userId) || null,
      userName,
      date: (entry && entry.date) || null,
      status: (entry && entry.status) || null,
      totalHours,
      jobIds,
      ...(reason ? { reason: String(reason).slice(0, 240) } : {}),
    },
  };
}

/**
 * Build ONE summarising audit-log payload for a BULK decision — never N rows
 * (the decided days live in metadata.entries). targetId is a synthetic
 * bulk:<actor>:<count> key.
 * @param {{ action: string, actor: object,
 *           decided: Array<{userId:string, date:string, totalHours?:number, reason?:string}> }} input
 */
function buildHoursBulkAuditEntry({ action, actor, decided }) {
  const list = Array.isArray(decided) ? decided : [];
  const verb = action === 'hours.bulk_rejected' ? 'rejected' : 'approved';
  return {
    action,
    actorId: (actor && actor.id) || '',
    actorName: (actor && actor.username) || '',
    actorRole: (actor && actor.role) || null,
    jobId: null, // a bulk decision spans workers/jobs
    targetType: 'time_entry',
    targetId: `bulk:${(actor && actor.id) || 'unknown'}:${list.length}`,
    summary: `${(actor && actor.username) || 'someone'} ${verb} ${list.length} timesheet day${list.length === 1 ? '' : 's'}`.slice(0, 240),
    metadata: {
      count: list.length,
      entries: list.map((d) => ({
        userId: d.userId,
        date: d.date,
        ...(d.totalHours != null ? { totalHours: Number(d.totalHours) || 0 } : {}),
      })),
    },
  };
}

module.exports = { buildHoursAuditEntry, buildHoursBulkAuditEntry, jobIdsOf };
