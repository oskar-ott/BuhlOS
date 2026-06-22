import type { ExpenseCategory, ExpenseItem, ExpenseStatus } from "./types";

/**
 * Pure read-model helpers for expenses (#536) — queue ordering, the office
 * roll-up, and the worker-language labels (P11: one dialect for tile + form +
 * messaging, no accounting jargon on the Phil side).
 */

/** Worker-facing entry-point copy (P11 — site language, not "expense claim"). */
export const EXPENSE_OPTION = {
  key: "reimbursement",
  label: "Submit a receipt",
  hint: "Claim money back for something you paid for",
} as const;

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  fuel: "Fuel",
  parking: "Parking",
  materials: "Materials",
  tolls: "Tolls",
  other: "Other",
};

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  submitted: "Awaiting review",
  approved: "Approved",
  rejected: "Declined",
  reimbursed: "Reimbursed",
};

const REVIEW_ORDER: Record<ExpenseStatus, number> = {
  submitted: 0,
  approved: 1,
  // Both terminal — one "settled" band, sorted newest-first below.
  reimbursed: 2,
  rejected: 2,
};

/**
 * Office review order: the work to do first. Submitted (oldest first — fairest
 * to whoever's been waiting), then approved-awaiting-payout, then the settled
 * ones (newest first).
 */
export function sortForReview(expenses: ReadonlyArray<ExpenseItem>): ExpenseItem[] {
  return [...expenses].sort((a, b) => {
    const band = REVIEW_ORDER[a.status] - REVIEW_ORDER[b.status];
    if (band !== 0) return band;
    const settled = a.status === "reimbursed" || a.status === "rejected";
    return settled
      ? b.createdAt.localeCompare(a.createdAt) // newest settled first
      : a.createdAt.localeCompare(b.createdAt); // oldest open first
  });
}

export interface ExpenseSummary {
  total: number;
  counts: Record<ExpenseStatus, number>;
  /** Awaiting review. */
  pendingCount: number;
  pendingTotalCents: number;
  /** Approved but not yet reimbursed — the office's payout backlog. */
  approvedUnpaidCount: number;
  approvedUnpaidTotalCents: number;
}

export function summariseExpenses(expenses: ReadonlyArray<ExpenseItem>): ExpenseSummary {
  const counts: Record<ExpenseStatus, number> = {
    submitted: 0,
    approved: 0,
    rejected: 0,
    reimbursed: 0,
  };
  let pendingTotalCents = 0;
  let approvedUnpaidTotalCents = 0;
  for (const e of expenses) {
    counts[e.status] += 1;
    if (e.status === "submitted") pendingTotalCents += e.amountCents;
    if (e.status === "approved") approvedUnpaidTotalCents += e.amountCents;
  }
  return {
    total: expenses.length,
    counts,
    pendingCount: counts.submitted,
    pendingTotalCents,
    approvedUnpaidCount: counts.approved,
    approvedUnpaidTotalCents,
  };
}
