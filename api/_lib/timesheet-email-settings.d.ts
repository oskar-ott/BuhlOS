// Type declarations for the CommonJS timesheet-recipient store
// (api/_lib/timesheet-email-settings.js) so src/ pages and the vitest suite
// can import and type-check it.

export const KEY: string;
export const MAX_RECIPIENTS: number;

export function normalizeRecipients(
  input: unknown
): { ok: true; recipients: string[] } | { ok: false; error: string };

export function readTimesheetEmailSettings(): Promise<{
  recipients: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}>;

export function readTimesheetRecipients(): Promise<string[]>;

export function writeTimesheetRecipients(
  recipients: string[],
  actor?: { username?: string } | null
): Promise<{ recipients: string[]; updatedAt: string; updatedBy: string | null }>;
