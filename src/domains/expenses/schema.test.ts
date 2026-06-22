import { describe, expect, it } from "vitest";
import {
  CreateExpensePayloadSchema,
  canTransition,
  centsFromDollarInput,
  formatAud,
  nextStatuses,
} from "./schema";

describe("expenses money helpers (#536)", () => {
  it("formatAud renders integer cents as AUD with grouping", () => {
    expect(formatAud(0)).toBe("$0.00");
    expect(formatAud(5)).toBe("$0.05");
    expect(formatAud(4250)).toBe("$42.50");
    expect(formatAud(123456)).toBe("$1,234.56");
    expect(formatAud(-4250)).toBe("-$42.50");
  });

  it("centsFromDollarInput parses valid money to exact cents (no float drift)", () => {
    expect(centsFromDollarInput("42.50")).toBe(4250);
    expect(centsFromDollarInput("7")).toBe(700);
    expect(centsFromDollarInput("$1,234.5")).toBe(123450);
    expect(centsFromDollarInput("0.05")).toBe(5);
    // the classic float trap — 0.1+0.2 style — stays exact
    expect(centsFromDollarInput("0.30")).toBe(30);
  });

  it("centsFromDollarInput rejects junk and >2 decimals", () => {
    for (const bad of ["", "abc", "1.234", "-5", "1.2.3", "$"]) {
      expect(centsFromDollarInput(bad), bad).toBeNull();
    }
  });
});

describe("expenses status machine (#536)", () => {
  it("allows the real transitions and refuses the rest", () => {
    expect(canTransition("submitted", "approved")).toBe(true);
    expect(canTransition("submitted", "rejected")).toBe(true);
    expect(canTransition("approved", "reimbursed")).toBe(true);
    expect(canTransition("approved", "rejected")).toBe(true);
    // illegal
    expect(canTransition("submitted", "reimbursed")).toBe(false);
    expect(canTransition("reimbursed", "approved")).toBe(false);
    expect(canTransition("rejected", "approved")).toBe(false);
    expect(canTransition("approved", "submitted")).toBe(false);
  });

  it("nextStatuses lists the moves a reviewer can make; terminals are empty", () => {
    expect(nextStatuses("submitted").sort()).toEqual(["approved", "rejected"]);
    expect(nextStatuses("approved").sort()).toEqual(["reimbursed", "rejected"]);
    expect(nextStatuses("rejected")).toEqual([]);
    expect(nextStatuses("reimbursed")).toEqual([]);
  });
});

describe("CreateExpensePayloadSchema (#536)", () => {
  const base = { amountCents: 4250, category: "fuel", receiptPhotoId: "r1", receiptPhotoUrl: "https://b/r.jpg" };

  it("accepts a valid payload and normalises an empty note to null", () => {
    const parsed = CreateExpensePayloadSchema.safeParse({ ...base, note: "  " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.note).toBeNull();
  });

  it("rejects zero/negative/fractional amounts, bad category, missing receipt", () => {
    expect(CreateExpensePayloadSchema.safeParse({ ...base, amountCents: 0 }).success).toBe(false);
    expect(CreateExpensePayloadSchema.safeParse({ ...base, amountCents: -1 }).success).toBe(false);
    expect(CreateExpensePayloadSchema.safeParse({ ...base, amountCents: 1.5 }).success).toBe(false);
    expect(CreateExpensePayloadSchema.safeParse({ ...base, category: "nope" }).success).toBe(false);
    expect(CreateExpensePayloadSchema.safeParse({ ...base, receiptPhotoId: "" }).success).toBe(false);
    expect(CreateExpensePayloadSchema.safeParse({ ...base, receiptPhotoUrl: "x" }).success).toBe(false);
  });
});
