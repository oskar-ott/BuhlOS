import { describe, expect, it } from "vitest";
import { sortForReview, summariseExpenses } from "./service";
import type { ExpenseItem, ExpenseStatus } from "./types";

function ex(id: string, status: ExpenseStatus, amountCents: number, createdAt: string): ExpenseItem {
  return {
    id,
    amountCents,
    category: "fuel",
    note: null,
    receiptPhotoId: "r_" + id,
    receiptPhotoUrl: "https://b/" + id + ".jpg",
    jobId: null,
    jobName: null,
    status,
    submittedById: "w1",
    submittedByName: "Sparky",
    submittedByRole: "electrician",
    reviewedById: null,
    reviewedByName: null,
    reviewNote: null,
    createdAt,
    updatedAt: createdAt,
    reimbursedAt: null,
  };
}

describe("sortForReview (#536)", () => {
  it("puts the work first: submitted (oldest first), then approved, then settled (newest first)", () => {
    const list = [
      ex("paid", "reimbursed", 100, "2026-06-01T00:00:00Z"),
      ex("new2", "submitted", 100, "2026-06-10T00:00:00Z"),
      ex("new1", "submitted", 100, "2026-06-05T00:00:00Z"),
      ex("appr", "approved", 100, "2026-06-02T00:00:00Z"),
      ex("rej", "rejected", 100, "2026-06-09T00:00:00Z"),
    ];
    expect(sortForReview(list).map((e) => e.id)).toEqual(["new1", "new2", "appr", "rej", "paid"]);
  });
});

describe("summariseExpenses (#536)", () => {
  it("counts by status and totals the pending + approved-unpaid backlogs", () => {
    const s = summariseExpenses([
      ex("a", "submitted", 4250, "2026-06-01T00:00:00Z"),
      ex("b", "submitted", 1000, "2026-06-02T00:00:00Z"),
      ex("c", "approved", 2000, "2026-06-03T00:00:00Z"),
      ex("d", "reimbursed", 5000, "2026-06-04T00:00:00Z"),
      ex("e", "rejected", 9999, "2026-06-05T00:00:00Z"),
    ]);
    expect(s.total).toBe(5);
    expect(s.counts).toEqual({ submitted: 2, approved: 1, rejected: 1, reimbursed: 1 });
    expect(s.pendingCount).toBe(2);
    expect(s.pendingTotalCents).toBe(5250);
    expect(s.approvedUnpaidCount).toBe(1);
    expect(s.approvedUnpaidTotalCents).toBe(2000);
  });

  it("is empty-safe", () => {
    const s = summariseExpenses([]);
    expect(s.total).toBe(0);
    expect(s.pendingTotalCents).toBe(0);
  });
});
