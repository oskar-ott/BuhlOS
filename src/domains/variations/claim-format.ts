import type { VariationApprovalMethod, VariationClaimStatus } from "./claim-types";

/** Display helpers for the variation-claim pipeline — pure, no state. Site
 *  language (P11): plain words an admin and a builder both read. */

export function variationClaimStatusLabel(status: VariationClaimStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "quoted":
      return "Quoted";
    case "submitted":
      return "Submitted";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "invoiced":
      return "Invoiced";
  }
}

export function variationApprovalMethodLabel(method: VariationApprovalMethod): string {
  switch (method) {
    case "email":
      return "Email";
    case "verbal":
      return "Verbal";
    case "signed":
      return "Signed";
    case "portal":
      return "Portal";
  }
}

/**
 * Format integer cents as a plain dollar string ("$1,234.50"). Pure display —
 * the underlying value stays integer cents everywhere else. `null` → "—".
 */
export function formatClaimValue(valueCents: number | null | undefined): string {
  if (valueCents == null || !Number.isFinite(valueCents)) return "—";
  const negative = valueCents < 0;
  const abs = Math.abs(Math.trunc(valueCents));
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  const dollarStr = dollars.toLocaleString("en-AU");
  return `${negative ? "-" : ""}$${dollarStr}.${String(cents).padStart(2, "0")}`;
}
