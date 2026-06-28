// Australian (national + NSW) public-holiday table (#137).
//
// Why a checked-in static table, not an API: holiday volume is tiny and the
// dates are gazetted years ahead, so an external dependency would add a
// network failure mode for no benefit. The consumers (missing-day detection
// in api/time-entries-overview.js, the payroll-reminder cron) need a cheap
// synchronous yes/no — exactly like the weekend check they sit beside.
//
// SCOPE: NSW. BuhlOS runs on Sydney time (Australia/Sydney), so this is the
// NSW gazetted list = national holidays + the NSW-specific ones, with the
// "additional day" substitutions NSW applies when New Year's Day, Australia
// Day, Christmas Day or Boxing Day fall on a weekend. ANZAC Day is NOT
// substituted in NSW, so it simply has no weekday impact in a year it lands
// on a weekend.
//
// MAINTENANCE — UPDATE YEARLY. This table runs out at the end of 2027; add
// the next year before then. Source of truth: NSW Government public holidays
// (industrelations.nsw.gov.au / nsw.gov.au/about-nsw/public-holidays).
// Weekday of every date is asserted in the unit test that exercises the
// projection, but the dates themselves are gazetted data — re-check against
// the official list when extending. Keys are YYYY-MM-DD (local Sydney date).

const HOLIDAYS = {
  // ── 2025 ──────────────────────────────────────────────────────────
  '2025-01-01': "New Year's Day",
  '2025-01-27': 'Australia Day (observed)', // 26 Jan 2025 = Sunday
  '2025-04-18': 'Good Friday',
  '2025-04-19': 'Easter Saturday',
  '2025-04-20': 'Easter Sunday',
  '2025-04-21': 'Easter Monday',
  '2025-04-25': 'Anzac Day',
  '2025-06-09': "King's Birthday",
  '2025-10-06': 'Labour Day',
  '2025-12-25': 'Christmas Day',
  '2025-12-26': 'Boxing Day',
  // ── 2026 ──────────────────────────────────────────────────────────
  '2026-01-01': "New Year's Day",
  '2026-01-26': 'Australia Day',
  '2026-04-03': 'Good Friday',
  '2026-04-04': 'Easter Saturday',
  '2026-04-05': 'Easter Sunday',
  '2026-04-06': 'Easter Monday',
  '2026-04-25': 'Anzac Day', // Saturday — no NSW substitution
  '2026-06-08': "King's Birthday",
  '2026-10-05': 'Labour Day',
  '2026-12-25': 'Christmas Day',
  '2026-12-26': 'Boxing Day', // Saturday
  '2026-12-28': 'Boxing Day (additional)', // Mon substitute for the Sat Boxing Day
  // ── 2027 ──────────────────────────────────────────────────────────
  '2027-01-01': "New Year's Day",
  '2027-01-26': 'Australia Day',
  '2027-03-26': 'Good Friday',
  '2027-03-27': 'Easter Saturday',
  '2027-03-28': 'Easter Sunday',
  '2027-03-29': 'Easter Monday',
  '2027-04-25': 'Anzac Day', // Sunday — no NSW substitution
  '2027-06-14': "King's Birthday",
  '2027-10-04': 'Labour Day',
  '2027-12-25': 'Christmas Day', // Saturday
  '2027-12-26': 'Boxing Day', // Sunday
  '2027-12-27': 'Christmas Day (additional)', // Mon substitute for the Sat Christmas
  '2027-12-28': 'Boxing Day (additional)', // Tue substitute for the Sun Boxing Day
};

/** True when YYYY-MM-DD is a gazetted NSW public holiday. */
function isPublicHoliday(date) {
  return Object.prototype.hasOwnProperty.call(HOLIDAYS, date);
}

/** Holiday name for YYYY-MM-DD, or null. */
function publicHolidayName(date) {
  return isPublicHoliday(date) ? HOLIDAYS[date] : null;
}

/**
 * Holidays whose date falls within [fromDate, toDate] inclusive, as
 * `[{ date, name }]` sorted ascending. Pure string compare — both bounds are
 * YYYY-MM-DD, which sorts lexicographically.
 */
function publicHolidaysInRange(fromDate, toDate) {
  return Object.keys(HOLIDAYS)
    .filter((d) => d >= fromDate && d <= toDate)
    .sort()
    .map((d) => ({ date: d, name: HOLIDAYS[d] }));
}

module.exports = { HOLIDAYS, isPublicHoliday, publicHolidayName, publicHolidaysInRange };
