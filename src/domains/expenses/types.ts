/**
 * Expenses (#536) — a field worker submits an out-of-pocket cost (receipt photo
 * + amount + category) for reimbursement; the office reviews → approves →
 * marks reimbursed. A structured, trackable record, NOT a lossy "send a photo
 * to the boss" observation.
 *
 * Money is ALWAYS integer cents (AUD). No floats cross the wire or land in the
 * store — the office must never see a fabricated or drifted total (P7).
 *
 * Boundary: BuhlOS captures + approves; actual payout runs through payroll/Xero
 * (#249) — out of scope here (payroll-boundary ADR #609).
 */

export const EXPENSE_CATEGORIES = ["fuel", "parking", "materials", "tolls", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * submitted → approved → reimbursed  (the happy path)
 * submitted → rejected               (declined at review)
 * approved  → rejected               (reversed before payout)
 * rejected / reimbursed are terminal — a worker re-claims by submitting anew.
 */
export const EXPENSE_STATUSES = ["submitted", "approved", "rejected", "reimbursed"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export interface ExpenseItem {
  id: string;
  /** Integer cents, AUD. The single source of truth for the amount. */
  amountCents: number;
  category: ExpenseCategory;
  note: string | null;
  /** Receipt photo (required) — id + public Blob URL from the upload step. */
  receiptPhotoId: string;
  receiptPhotoUrl: string;
  /** Optional job attribution (a hint for the office / future job-costing). */
  jobId: string | null;
  jobName: string | null;
  status: ExpenseStatus;
  submittedById: string;
  submittedByName: string;
  submittedByRole: string;
  reviewedById: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
  reimbursedAt: string | null;
}

export interface CreateExpensePayload {
  amountCents: number;
  category: ExpenseCategory;
  note?: string | null;
  receiptPhotoId: string;
  receiptPhotoUrl: string;
  jobId?: string | null;
  /** Replay-safety for the offline/retry path (#497). */
  idempotencyKey?: string;
}

export interface UpdateExpensePayload {
  id: string;
  status: ExpenseStatus;
  reviewNote?: string | null;
}

export interface ReceiptUploadResponse {
  id: string;
  url: string;
  capturedAt: string;
}

export interface ExpenseListResponse {
  expenses: ExpenseItem[];
}

export interface ExpenseMutationResponse {
  expense: ExpenseItem;
  idempotentReplay?: boolean;
}
