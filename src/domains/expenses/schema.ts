import { z } from "zod";
import { EXPENSE_CATEGORIES, EXPENSE_STATUSES, type ExpenseStatus } from "./types";

/**
 * Zod schemas + pure money/transition helpers for expenses (#536).
 *
 * The schemas validate CLIENT payloads before they hit the network (same
 * pattern as snags/observations/evidence). The server re-validates everything
 * in plain JS in api/expenses.js — never trust the client, especially on money.
 */

export const EXPENSE_NOTE_MAX = 500;
/** Amount bounds in cents: > $0, and a $100,000 fat-finger ceiling. */
export const EXPENSE_AMOUNT_MIN_CENTS = 1;
export const EXPENSE_AMOUNT_MAX_CENTS = 10_000_000;

export const ExpenseCategorySchema = z.enum(EXPENSE_CATEGORIES);
export const ExpenseStatusSchema = z.enum(EXPENSE_STATUSES);

const noteField = z
  .string()
  .trim()
  .max(EXPENSE_NOTE_MAX)
  .nullish()
  .transform((v) => (v ? v : null));

export const CreateExpensePayloadSchema = z.object({
  amountCents: z
    .number()
    .int("amount must be whole cents")
    .min(EXPENSE_AMOUNT_MIN_CENTS, "amount must be more than $0")
    .max(EXPENSE_AMOUNT_MAX_CENTS, "amount looks too large — check it"),
  category: ExpenseCategorySchema,
  note: noteField,
  receiptPhotoId: z.string().trim().min(1, "a receipt photo is required"),
  receiptPhotoUrl: z.string().trim().url("receipt photo must have a URL"),
  jobId: z
    .string()
    .trim()
    .min(1)
    .nullish()
    .transform((v) => (v ? v : null)),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const UpdateExpensePayloadSchema = z.object({
  id: z.string().trim().min(1),
  status: ExpenseStatusSchema,
  reviewNote: noteField,
});

export const ReceiptUploadResponseSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  capturedAt: z.string(),
});

export const ExpenseItemSchema = z.object({
  id: z.string(),
  amountCents: z.number().int(),
  category: ExpenseCategorySchema,
  note: z.string().nullable(),
  receiptPhotoId: z.string(),
  receiptPhotoUrl: z.string(),
  jobId: z.string().nullable(),
  jobName: z.string().nullable(),
  status: ExpenseStatusSchema,
  submittedById: z.string(),
  submittedByName: z.string(),
  submittedByRole: z.string(),
  reviewedById: z.string().nullable(),
  reviewedByName: z.string().nullable(),
  reviewNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reimbursedAt: z.string().nullable(),
});

export const ExpenseListResponseSchema = z.object({
  // Lenient: drop rows that don't parse rather than failing the whole list.
  expenses: z.array(z.unknown()).transform((rows) =>
    rows.flatMap((r) => {
      const parsed = ExpenseItemSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
});

export const ExpenseMutationResponseSchema = z.object({
  expense: ExpenseItemSchema,
  idempotentReplay: z.boolean().optional(),
});

// ── Pure status-transition rules (mirrored byte-for-byte in api/expenses.js) ──
const TRANSITIONS: Record<ExpenseStatus, ExpenseStatus[]> = {
  submitted: ["approved", "rejected"],
  approved: ["reimbursed", "rejected"],
  rejected: [],
  reimbursed: [],
};

export function canTransition(from: ExpenseStatus, to: ExpenseStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatuses(from: ExpenseStatus): ExpenseStatus[] {
  return TRANSITIONS[from] ?? [];
}

// ── Money helpers (P7 — integer cents only, never floats) ────────────────────

/** Format integer cents as AUD, e.g. 4250 → "$42.50", 123456 → "$1,234.56". */
export function formatAud(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const c = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$${dollars}.${c}`;
}

/**
 * Parse a dollar text input ("42.50", "$1,234", "7") to integer cents, or null
 * if it isn't a valid non-negative money string with ≤2 decimals. The UI uses
 * this so what the worker types becomes exact cents before submit.
 */
export function centsFromDollarInput(input: string): number | null {
  const cleaned = String(input).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return Number.isFinite(cents) ? cents : null;
}
