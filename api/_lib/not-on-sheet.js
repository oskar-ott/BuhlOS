'use strict';

// "Not on this sheet" — every worker-day the approved payroll sheet does NOT
// carry, and why. Printed on the sheet itself (the emailed PDF + its email
// body, and the Download PDF), so missing hours can never leave the building
// silently (owner, 2026-10-09: "it can't compromise the integrity of the app
// like timesheet missing hours that are missing").
//
// Why it exists: on 5 Oct the week was approved for everyone except two
// Fridays nobody had logged (Dylan, Stephen). The phone said "2 days never came
// in" — a count, no names — and nothing on the sheet told accounts that two
// people's Fridays weren't on it. A sheet that is complete OR names exactly what
// it is missing can't be short by surprise.
//
// Sources, all server-side and already in hand:
//   · the payroll read's own `entries` (collectRows: every in-range day-file,
//     every status, freshness-verified) — a non-approved entry is "waiting for
//     approval" / "sent back for a fix" / "not sent in (draft)";
//   · the ONE missing-day rule (api/_lib/missing-days.js — the same function
//     the boards use) over hours-tracked crew, with NSW public holidays and
//     approved leave — "nothing logged" / "on annual leave" etc.
// Names follow the payroll rows' rule (payroll-inputs: live name first) so a
// person is spelled the same way in the table and in this list.

const { isHoursTrackedWorker } = require('./auth');
const { publicHolidaysInRange } = require('./public-holidays');
const { readLeave, approvedLeaveByUserDate } = require('./leave');
const { missingWeekdays } = require('./missing-days');

const LEAVE_WORDS = {
  annual: 'annual leave',
  sick: 'sick leave',
  rdo: 'an RDO',
  unpaid: 'unpaid leave',
  other: 'leave',
};

const REASON_ORDER = ['waiting for approval', 'sent back for a fix', 'not sent in (draft)', 'nothing logged'];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 2 Oct" — UTC arithmetic on the calendar string, timezone-free. */
function shortDay(iso) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Build the list for [fromDate, toDate].
 *
 * @param {{ fromDate: string, toDate: string, entries: object[], userById: Record<string, object>,
 *           todayISO?: string, deps?: { readLeave?: Function } }} input
 * @returns {Promise<{ items: Array<{ workerId: string, workerName: string, date: string,
 *   kind: 'submitted'|'rejected'|'draft'|'missing'|'leave', reason: string, hours: number|null }>,
 *   leaveChecked: boolean, periodComplete: boolean }>}
 *   periodComplete — every day of the period is in the past, so "nothing
 *   listed" really means nothing is outstanding.
 */
async function buildNotOnSheet({ fromDate, toDate, entries, userById, todayISO, deps = {} }) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const users = userById || {};
  const nameOf = (userId, stamp) => {
    const u = users[userId] || {};
    return String(u.name || stamp || u.username || userId);
  };

  const items = [];
  const hasEntry = new Set();
  for (const e of entries || []) {
    if (!e || !e.userId || !e.date) continue;
    hasEntry.add(e.userId + '|' + e.date);
    if (e.date < fromDate || e.date > toDate) continue;
    if (e.status === 'approved') continue;
    const kind = e.status === 'submitted' || e.status === 'rejected' ? e.status : 'draft';
    const reason =
      kind === 'submitted' ? 'waiting for approval' : kind === 'rejected' ? 'sent back for a fix' : 'not sent in (draft)';
    items.push({
      workerId: e.userId,
      workerName: nameOf(e.userId, e.userName),
      date: e.date,
      kind,
      reason,
      hours: round2(e.totalHours),
    });
  }

  let leaveByUserDate = {};
  let leaveChecked = true;
  try {
    const leaveData = await (deps.readLeave || readLeave)();
    leaveByUserDate = approvedLeaveByUserDate((leaveData && leaveData.requests) || [], fromDate, toDate);
  } catch {
    leaveChecked = false; // say so on the sheet — never guess
  }
  const holidays = publicHolidaysInRange(fromDate, toDate);
  const crew = Object.values(users).filter((u) => isHoursTrackedWorker(u));
  const found = missingWeekdays({
    fromDate,
    toDate,
    todayISO: today,
    crew,
    hasEntry: (userId, date) => hasEntry.has(userId + '|' + date),
    holidaySet: new Set(holidays.map((h) => h.date)),
    leaveByUserDate,
  });
  for (const { date, user } of found.missing) {
    items.push({ workerId: user.id, workerName: nameOf(user.id, null), date, kind: 'missing', reason: 'nothing logged', hours: null });
  }
  for (const { date, user, type } of found.leave) {
    items.push({
      workerId: user.id,
      workerName: nameOf(user.id, null),
      date,
      kind: 'leave',
      reason: 'on ' + (LEAVE_WORDS[type] || 'leave'),
      hours: null,
    });
  }

  items.sort((a, b) => a.workerName.localeCompare(b.workerName) || a.date.localeCompare(b.date));
  return { items, leaveChecked, periodComplete: toDate < today };
}

/**
 * Group for printing: one line per worker per reason, days in date order —
 *   { workerName: 'Dylan Sinclair', reason: 'nothing logged', days: 'Fri 2 Oct' }
 *   { workerName: 'Louis Kane', reason: 'waiting for approval', days: 'Mon 28 Sep (7.6h), Tue 29 Sep (9.6h)' }
 * Outstanding work (approval / fixes / missing) sorts before leave.
 */
function notOnSheetLines(items) {
  const groups = new Map();
  for (const it of items || []) {
    const key = it.workerName + '\u0000' + it.reason;
    if (!groups.has(key)) groups.set(key, { workerName: it.workerName, reason: it.reason, kind: it.kind, parts: [] });
    groups
      .get(key)
      .parts.push(it.hours != null && it.hours > 0 ? `${shortDay(it.date)} (${it.hours}h)` : shortDay(it.date));
  }
  const rank = (reason) => {
    const i = REASON_ORDER.indexOf(reason);
    return i === -1 ? REASON_ORDER.length : i;
  };
  return [...groups.values()]
    .sort((a, b) => a.workerName.localeCompare(b.workerName) || rank(a.reason) - rank(b.reason))
    .map((g) => ({ workerName: g.workerName, reason: g.reason, kind: g.kind, days: g.parts.join(', ') }));
}

module.exports = { buildNotOnSheet, notOnSheetLines, shortDay };
