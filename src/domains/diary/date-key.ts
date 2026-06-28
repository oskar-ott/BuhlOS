/**
 * Site diary date keys (#210).
 *
 * A diary entry is keyed by the LOCAL (Sydney) calendar date the work happened
 * on, not the UTC instant it was saved. A 9pm-Sydney save in winter is still
 * 11am UTC the SAME day, but a 9am-Sydney save in summer is the PREVIOUS UTC
 * day at 22:00 — so deriving the date-key from `new Date().toISOString()` would
 * land late entries on the wrong day. We mirror site-visits.js `sydneyToday` so
 * the diary and the attendance lookup it snapshots agree on what "today" is.
 *
 * All functions are pure (an injectable `now`/instant for determinism) and live
 * away from the handler so the boundary behaviour is unit-tested directly.
 */

const SYDNEY_TZ = "Australia/Sydney";
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD date-key in the Australia/Sydney calendar for a given instant. */
export function sydneyDateKey(instant: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SYDNEY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Today's Sydney date-key (YYYY-MM-DD). */
export function sydneyToday(now: Date = new Date()): string {
  return sydneyDateKey(now);
}

/** Whether a string is a well-formed YYYY-MM-DD date-key (shape only). */
export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && DATE_KEY_RE.test(value);
}

/**
 * A diary entry's date must not be in the FUTURE relative to the Sydney day —
 * the diary is a CONTEMPORANEOUS record (delay-claim evidence), so you can
 * back-date (recording yesterday) but never pre-date tomorrow. Compares the
 * date-keys lexically, which is correct for the fixed-width ISO form.
 */
export function isFutureDate(dateKey: string, now: Date = new Date()): boolean {
  return dateKey > sydneyToday(now);
}

/** Inclusive [from, to] range filter on date-keys. Lexical compare is safe for
 *  the fixed-width ISO form. A missing bound is treated as unbounded. */
export function inDateRange(
  dateKey: string,
  fromDate?: string | null,
  toDate?: string | null,
): boolean {
  if (fromDate && dateKey < fromDate) return false;
  if (toDate && dateKey > toDate) return false;
  return true;
}
