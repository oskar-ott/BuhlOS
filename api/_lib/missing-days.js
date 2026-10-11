'use strict';

// The ONE answer to "which weekdays should carry hours for this crew member but
// don't". Extracted VERBATIM from api/time-entries-overview.js (2026-10-09) so
// the payroll sheet's "Not on this sheet" list and the boards — weekly closeout,
// /hours, command centre, Phil week — can never disagree about a missing day.
// Never a second copy of the rule.
//
// The rule (unchanged):
//   · weekdays only — weekends are never required;
//   · NSW public holidays are never required (the caller passes the set);
//   · past/today only — a future day is not "missing" yet;
//   · never before the company go-live (HOURS_GO_LIVE) — no hours are asked
//     for from before the app existed in the field;
//   · an entry of ANY status on the day means it is not missing;
//   · a day covered by APPROVED leave is reported as leave, not missing.
//
// PURE — the caller supplies the crew, the entry lookup, the holiday set and
// the leave map, so it stays testable and I/O-free.

const { HOURS_GO_LIVE } = require('./hours-epoch');

/**
 * @param {{
 *   fromDate: string, toDate: string,      // inclusive YYYY-MM-DD
 *   todayISO: string,                      // the caller's "today" (YYYY-MM-DD)
 *   crew: Array<{ id: string }>,           // who is expected to log hours
 *   hasEntry: (userId: string, date: string) => boolean,
 *   holidaySet?: Set<string>,
 *   leaveByUserDate?: Record<string, string>, // 'userId|date' → leave type
 *   goLiveISO?: string,
 * }} input
 * @returns {{ missing: Array<{ date: string, user: object }>,
 *             leave: Array<{ date: string, user: object, type: string }> }}
 */
function missingWeekdays({
  fromDate,
  toDate,
  todayISO,
  crew,
  hasEntry,
  holidaySet,
  leaveByUserDate,
  goLiveISO = HOURS_GO_LIVE,
}) {
  const missing = [];
  const leave = [];
  const today0 = new Date(todayISO + 'T00:00:00');
  const goLive0 = new Date(goLiveISO + 'T00:00:00');
  const cursor = new Date(fromDate + 'T00:00:00');
  if (cursor < goLive0) cursor.setTime(goLive0.getTime());
  const end = new Date(toDate + 'T00:00:00');
  while (cursor <= end && cursor <= today0) {
    const dow = cursor.getDay();
    const isWeekend = dow === 0 || dow === 6;
    // Format from the cursor's own calendar components, NOT toISOString():
    // the cursor is local-midnight, so the UTC render shifted the emitted
    // date by a day on any non-UTC host — entry-suppression then never
    // matched. Invisible on UTC production, but wrong (and untestable)
    // everywhere else; this keeps the date consistent with the local
    // getDay() weekend check above.
    const iso =
      cursor.getFullYear() + '-' +
      String(cursor.getMonth() + 1).padStart(2, '0') + '-' +
      String(cursor.getDate()).padStart(2, '0');
    // A public holiday is not a required day — exempt it from "missing" just
    // like a weekend, or the board cries wolf for the whole crew every
    // holiday week and the office learns to ignore red.
    if (!isWeekend && !(holidaySet && holidaySet.has(iso))) {
      for (const u of crew || []) {
        if (hasEntry(u.id, iso)) continue;
        const leaveType = leaveByUserDate && leaveByUserDate[u.id + '|' + iso];
        if (leaveType) leave.push({ date: iso, user: u, type: leaveType });
        else missing.push({ date: iso, user: u });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return { missing, leave };
}

module.exports = { missingWeekdays };
