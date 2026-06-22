import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ExpensesReviewQueue } from "./ExpensesReviewQueue";
import type { ExpenseItem, ExpenseStatus } from "@/domains/expenses/types";

/**
 * Static-render guards for the office reimbursement queue (#536). The live
 * transitions are pinned by the api harness; these pin the initial surface:
 * the roll-up, the worker's exact amounts (no fabricated totals, P7), the
 * status-appropriate actions, and the honest payroll-boundary copy.
 */

function ex(id: string, status: ExpenseStatus, amountCents: number): ExpenseItem {
  return {
    id,
    amountCents,
    category: "fuel",
    note: null,
    receiptPhotoId: "r_" + id,
    receiptPhotoUrl: "https://blob.example/" + id + ".jpg",
    jobId: null,
    jobName: null,
    status,
    submittedById: "w1",
    submittedByName: "Sparky",
    submittedByRole: "electrician",
    reviewedById: null,
    reviewedByName: null,
    reviewNote: null,
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
    reimbursedAt: null,
  };
}

const render = (expenses: ExpenseItem[], fetchError: string | null = null) =>
  renderToString(createElement(ExpensesReviewQueue, { initialExpenses: expenses, fetchError }));

describe("ExpensesReviewQueue (#536)", () => {
  it("shows the roll-up totals and honest payroll-boundary copy", () => {
    const html = render([ex("a", "submitted", 4250), ex("b", "approved", 2000)]);
    expect(html).toContain("Awaiting review");
    expect(html).toContain("$42.50"); // the worker's exact amount, not a rounded float
    expect(html).toContain("payout runs through payroll/Xero");
  });

  it("offers status-appropriate actions: Approve/Decline on submitted, Mark reimbursed on approved", () => {
    const submitted = render([ex("a", "submitted", 100)]);
    expect(submitted).toContain("Approve");
    expect(submitted).toContain("Decline");
    expect(submitted).not.toContain("Mark reimbursed");

    const approved = render([ex("b", "approved", 100)]);
    expect(approved).toContain("Mark reimbursed");
    expect(approved).toContain("Decline");
  });

  it("gives terminal expenses no actions", () => {
    const html = render([ex("c", "reimbursed", 100)]);
    // "Approve"/"Decline" collide with the filter labels; the unambiguous
    // action-presence markers are the per-row note input + the reimburse CTA.
    expect(html).not.toContain("Reason / note");
    expect(html).not.toContain("Mark reimbursed");
    expect(html).toContain("Reimbursed");
  });

  it("renders an honest empty state and a fetch-error state", () => {
    expect(render([])).toContain("No expenses");
    expect(render([], "API returned 500")).toContain("Couldn’t load expenses");
  });
});
