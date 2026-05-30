/**
 * Client-side validators for the Job Basics editor. These MIRROR the
 * authoritative server checks in api/jobs.js `validateJobBasics()` so the
 * form can give instant inline feedback — but the server always re-validates,
 * so these are a UX convenience, never the security boundary.
 *
 * Kept deliberately as a strict SUBSET of the server rules: anything these
 * accept, the server also accepts. We never reject input the API would take
 * (that would block a legitimate save with no server error to explain it).
 *
 * Cross-ref: api/jobs.js:63 validateJobBasics (phone regex line 76, date
 * regex lines 85/90, date cross-check line 102).
 */

/** Phone shape from api/jobs.js:76 — digits, spaces, +, -, (), / ; min 6 chars. */
export const PHONE_RE = /^[+\d\s\-()/]{6,}$/;

/** ISO calendar date from api/jobs.js:85 — YYYY-MM-DD. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidPhone(value: string): boolean {
  return PHONE_RE.test(value.trim());
}

export function isValidIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value.trim());
}

/**
 * True unless BOTH dates are present and start is after due. Mirrors the
 * server cross-check, which only runs when both fields are provided
 * (api/jobs.js:102). String comparison is correct for zero-padded
 * YYYY-MM-DD.
 */
export function dateOrderOk(startDate: string, dueDate: string): boolean {
  const s = startDate.trim();
  const d = dueDate.trim();
  if (!s || !d) return true;
  if (!isValidIsoDate(s) || !isValidIsoDate(d)) return true; // shape error reported separately
  return s <= d;
}

export type JobBasicsField =
  | "name"
  | "siteContactPhone"
  | "startDate"
  | "dueDate"
  | "programmedDurationDays";

export type JobFieldErrors = Partial<Record<JobBasicsField, string>>;

export interface JobBasicsValues {
  name?: string;
  siteContactPhone?: string;
  startDate?: string;
  dueDate?: string;
  /** Raw text from the number input — validated as a non-negative number. */
  programmedDurationDays?: string;
}

/**
 * Return a field→message map for the values that fail. An empty object means
 * the form is submittable. `requireName` is true in create mode (name is the
 * one required field) and in edit mode when the name input is shown.
 */
export function validateJobBasics(
  values: JobBasicsValues,
  opts: { requireName?: boolean } = {}
): JobFieldErrors {
  const errors: JobFieldErrors = {};

  if (opts.requireName && !(values.name ?? "").trim()) {
    errors.name = "Job name is required";
  }

  const phone = (values.siteContactPhone ?? "").trim();
  if (phone && !isValidPhone(phone)) {
    errors.siteContactPhone = "Enter a valid phone number";
  }

  const start = (values.startDate ?? "").trim();
  if (start && !isValidIsoDate(start)) {
    errors.startDate = "Use the date picker (YYYY-MM-DD)";
  }

  const due = (values.dueDate ?? "").trim();
  if (due && !isValidIsoDate(due)) {
    errors.dueDate = "Use the date picker (YYYY-MM-DD)";
  }

  if (!errors.startDate && !errors.dueDate && !dateOrderOk(start, due)) {
    errors.dueDate = "Due date must be on or after the start date";
  }

  const dur = (values.programmedDurationDays ?? "").trim();
  if (dur) {
    const n = Number(dur);
    if (!Number.isFinite(n) || n < 0) {
      errors.programmedDurationDays = "Enter a number of days (0 or more)";
    }
  }

  return errors;
}
