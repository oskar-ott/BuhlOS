// Type surface for the CommonJS NSW public-holiday table (api/_lib/public-holidays.js)
// so server components can share the office's holiday truth (My Day / week counts).
export const HOLIDAYS: Readonly<Record<string, string>>;
export function isPublicHoliday(date: string): boolean;
export function publicHolidayName(date: string): string | null;
/** Public holidays within [fromDate, toDate] inclusive, ascending. */
export function publicHolidaysInRange(
  fromDate: string,
  toDate: string
): Array<{ date: string; name: string }>;
