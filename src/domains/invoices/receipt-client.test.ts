import { describe, expect, it } from "vitest";
import { formatReceiptCents, receiptOutcomeText, type ReceiptResult } from "./receipt-client";

/** The one line a worker reads after sending a receipt — true to what happened (P7), site language (P11). */
const base: ReceiptResult = { id: "i1", status: "matched", duplicate: false, read: true, storeName: "Bunnings Warehouse", totalCents: 8450, receiptDate: "2026-09-24", lineCount: 2, job: { id: "birdwood", name: "Birdwood", code: "IV3232" }, paidPersonally: false };

describe("receiptOutcomeText", () => {
  it("says what was read and where it went", () => {
    expect(receiptOutcomeText(base)).toEqual({ title: "Receipt logged", body: "Bunnings Warehouse · $84.50 · 2 items → IV3232 · Birdwood.", tone: "success" });
  });
  it("names the payback when the worker paid, and never claims a figure it couldn't read", () => {
    expect(receiptOutcomeText({ ...base, paidPersonally: true }).body).toContain("the office sorts the payback");
    const unread = receiptOutcomeText({ ...base, read: false, totalCents: null, storeName: null, lineCount: 0 });
    expect(unread.title).toBe("Receipt saved");
    expect(unread.body).toContain("couldn't be read");
    expect(unread.body).not.toContain("$");
  });
  it("a resend is called out, not counted twice", () => {
    expect(receiptOutcomeText({ ...base, duplicate: true }).title).toBe("Already sent");
  });
  it("formats integer cents", () => {
    expect(formatReceiptCents(8450)).toBe("$84.50");
    expect(formatReceiptCents(123456)).toBe("$1,234.56");
    expect(formatReceiptCents(null)).toBe("—");
  });
});
