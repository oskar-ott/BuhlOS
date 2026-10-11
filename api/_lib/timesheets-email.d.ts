// Type declarations for the CommonJS timesheets→accounts email renderer
// (api/_lib/timesheets-email.js) so the vitest suite in src/ can import and
// type-check it. Pure render module — no I/O, no env.

export interface TimesheetsEmailWorker {
  workerName: string;
  hours: number;
  overtimeHours: number;
}

/** One printed line of the sheet's "Not on this sheet" list (api/_lib/not-on-sheet.js). */
export interface NotOnSheetLine {
  workerName: string;
  reason: string;
  /** e.g. "Fri 2 Oct" or "Mon 28 Sep (7.6h), Tue 29 Sep (9.6h)". */
  days: string;
}

export interface NotOnSheet {
  lines: NotOnSheetLine[];
  /** Worker-days listed (a line can carry several days). */
  dayCount: number;
  leaveChecked?: boolean;
  periodComplete?: boolean;
}

export interface TimesheetsEmailCtx {
  fromDate: string;
  toDate: string;
  /** Greeting only, e.g. "Tia". */
  recipientName?: string;
  workers: TimesheetsEmailWorker[];
  totalHours: number;
  overtimeHours: number;
  attachmentName: string;
  sentByName?: string;
  /** What the sheet does NOT carry, and why — printed in the body + the PDF. */
  notOnSheet?: NotOnSheet;
}

export function renderTimesheetsEmail(ctx: TimesheetsEmailCtx): {
  subject: string;
  html: string;
  text: string;
};

export function periodLabel(fromISO: string, toISO: string): string;

export function hoursLabel(n: number): string;
