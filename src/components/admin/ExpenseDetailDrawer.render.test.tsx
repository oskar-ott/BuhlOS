import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ExpenseDetailDrawer } from "./ExpenseDetailDrawer";
import type { ExpenseItem, ExpenseStatus } from "@/domains/expenses/types";

/**
 * Expense receipt + summary detail (#536). Pins: the full receipt photo, the
 * real summary fields, the HONEST UC cells for GST + Paid by (not invented),
 * status-appropriate actions, and the payroll-boundary note.
 */

function ex(status: ExpenseStatus, over: Partial<ExpenseItem> = {}): ExpenseItem {
  return {
    id: "e1",
    amountCents: 3200,
    category: "parking",
    note: null,
    receiptPhotoId: "r1",
    receiptPhotoUrl: "https://blob.example/r1.jpg",
    jobId: null,
    jobName: null,
    status,
    submittedById: "w1",
    submittedByName: "Dave Tran",
    submittedByRole: "electrician",
    reviewedById: null,
    reviewedByName: null,
    reviewNote: null,
    createdAt: "2026-06-24T00:00:00Z",
    updatedAt: "2026-06-24T00:00:00Z",
    reimbursedAt: null,
    ...over,
  };
}

const render = (item: ExpenseItem | null, open = true) =>
  renderToString(
    createElement(ExpenseDetailDrawer, { item, open, busy: false, onClose: () => {}, onAction: () => {} }),
  );

describe("ExpenseDetailDrawer (#536)", () => {
  it("renders the full receipt photo + the real summary fields", () => {
    const html = render(ex("submitted"));
    expect(html).toContain('src="https://blob.example/r1.jpg"');
    expect(html).toContain("$32.00"); // exact amount, integer cents (P7)
    expect(html).toContain("Dave Tran");
    expect(html).toContain("electrician");
    expect(html).toContain("Submitted by");
    expect(html).toContain("Receipt on file");
  });

  it("marks GST and Paid by as honest UC — never invented", () => {
    const html = render(ex("submitted"));
    expect(html).toContain("GST incl.");
    expect(html).toContain("Paid by");
    expect(html).toContain("UC");
    expect(html).toContain("not captured");
  });

  it("shows 'No job' honestly when there is no attribution", () => {
    expect(render(ex("submitted"))).toContain("No job");
    expect(render(ex("submitted", { jobName: "Glebe Town Hall" }))).toContain("Glebe Town Hall");
  });

  it("offers status-appropriate actions and the payroll-boundary note", () => {
    const submitted = render(ex("submitted"));
    expect(submitted).toContain("Approve $32.00"); // amount is on the button
    expect(submitted).toContain("Decline");
    expect(submitted).toContain("Reimbursed through payroll");

    const reimbursed = render(ex("reimbursed"));
    expect(reimbursed).not.toContain("Approve $32.00");
  });

  it("renders nothing when closed or itemless", () => {
    expect(render(null)).toBe("");
    expect(render(ex("submitted"), false)).toBe("");
  });
});
