// Type declarations for the CommonJS timesheets→accounts email renderer
// (api/_lib/timesheets-email.js) so the vitest suite in src/ can import and
// type-check it. Pure render module — no I/O, no env.

export interface TimesheetsEmailWorker {
  workerName: string;
  hours: number;
  overtimeHours: number;
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
}

export function renderTimesheetsEmail(ctx: TimesheetsEmailCtx): {
  subject: string;
  html: string;
  text: string;
};

export function periodLabel(fromISO: string, toISO: string): string;

export function hoursLabel(n: number): string;
