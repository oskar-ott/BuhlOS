/**
 * Workshop Stock — barcodes read on the phone (live code reading), compared
 * the way the server compares them. Pure.
 *
 * Mirrors api/_lib/workshop-stock/codes.js (gs1CheckOk / cleanBarcode /
 * barcodeKey): a barcode is digits with a valid GS1 check digit or it is
 * nothing, and GTIN-8/12/13/14 compare on their 14-digit form.
 * client-logic.test.ts runs both copies over the same cases.
 */

import type { StockIdentifier } from "./schema";

function gs1CheckOk(digits: string): boolean {
  let sum = 0;
  const body = digits.slice(0, -1);
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(digits.length - 1) - 48;
}

/** A GTIN-8/12/13/14 as read (digits kept as printed), or null. */
export function cleanBarcode(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const raw = String(v).replace(/[\s-]/g, "");
  if (!/^\d+$/.test(raw)) return null;
  if (![8, 12, 13, 14].includes(raw.length)) return null;
  if (/^0+$/.test(raw)) return null;
  return gs1CheckOk(raw) ? raw : null;
}

/** Comparison key: the 14-digit GTIN form (left-padded with zeroes). */
export function barcodeKey(v: unknown): string | null {
  const b = cleanBarcode(v);
  return b ? b.padStart(14, "0") : null;
}

export interface BarcodeHit<T> {
  item: T;
  identifier: StockIdentifier;
}

/**
 * Which live items carry this barcode. One hit is a match; several (the same
 * barcode on two items — the office can see why) is a short list to pick from;
 * none is "not matched in the workshop". An unreadable or invalid code is no
 * hit, never a near-miss.
 */
export function findByBarcode<T extends { identifiers: StockIdentifier[]; archivedAt?: string | null }>(items: readonly T[], raw: string): Array<BarcodeHit<T>> {
  const key = barcodeKey(raw);
  if (!key) return [];
  const hits: Array<BarcodeHit<T>> = [];
  for (const item of items) {
    if (item.archivedAt) continue;
    const identifier = item.identifiers.find((i) => i.kind === "barcode" && (i.valueKey === key || barcodeKey(i.value) === key));
    if (identifier) hits.push({ item, identifier });
  }
  return hits;
}
