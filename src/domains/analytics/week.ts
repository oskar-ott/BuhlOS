/**
 * Canonical week window (#329) — ONE Monday-anchored week definition, pure.
 *
 * The repo has ~8 copy-pasted week-bounds variants across api/*.js (the hours
 * weekly board, compare-weeks, the cron, …). This is the single definition the
 * KPI engine builds on. It works on a LOCAL date string (`YYYY-MM-DD`) — the
 * caller supplies the Australia/Sydney local date (the app already formats it
 * elsewhere), so this module does pure calendar arithmetic with NO timezone /
 * DST offset inversion: UTC date-only math on the date components is DST-safe
 * (a calendar day has no offset). The api/*.js variants are a documented
 * follow-up to migrate onto this — not this slice.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function toUtc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  // Callers pass an ISO_DATE_RE-validated string, so all three parts exist.
  return new Date(Date.UTC(y!, m! - 1, d!));
}
function fmt(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}
function assertIso(date: string): void {
  if (!ISO_DATE_RE.test(date)) throw new Error(`week: invalid local date "${date}" (want YYYY-MM-DD)`);
}

/** The Monday (`YYYY-MM-DD`) of the week containing `date`. Monday-anchored:
 *  a Sunday belongs to the week that STARTED the previous Monday. */
export function mondayOfLocalDate(date: string): string {
  assertIso(date);
  const dt = toUtc(date);
  const dow = dt.getUTCDay(); // 0=Sun … 6=Sat
  const sinceMonday = (dow + 6) % 7; // Mon→0 … Sun→6
  return fmt(new Date(dt.getTime() - sinceMonday * DAY_MS));
}

export interface WeekWindow {
  /** Monday, `YYYY-MM-DD` (inclusive start). */
  monday: string;
  /** Sunday, `YYYY-MM-DD` (inclusive end). */
  sunday: string;
  /** All seven days Mon→Sun, `YYYY-MM-DD`. */
  days: string[];
}

/** The Mon–Sun window containing `date`. */
export function weekWindowForLocalDate(date: string): WeekWindow {
  const monday = mondayOfLocalDate(date);
  const mdt = toUtc(monday);
  const days = Array.from({ length: 7 }, (_, i) => fmt(new Date(mdt.getTime() + i * DAY_MS)));
  return { monday, sunday: days[6]!, days };
}

/** Is a `YYYY-MM-DD` date within the (inclusive) window? Lexicographic compare
 *  is exact for zero-padded ISO dates. */
export function isInWeek(date: string, window: Pick<WeekWindow, "monday" | "sunday">): boolean {
  return ISO_DATE_RE.test(date) && date >= window.monday && date <= window.sunday;
}
