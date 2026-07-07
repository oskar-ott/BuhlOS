/**
 * #882 — parse a quantity the LEGEND ITSELF tabulates from a legend entry's
 * own text ("49 EA", "2.34 m²", "12 LM"). Strict and never invented (P7):
 * only these unit forms count as a schedule quantity, `ea` must be a whole
 * number, and anything else returns null (the entry simply has no tabulated
 * quantity — detection/marker review stays its count path).
 *
 * KEEP IN PARITY with the CJS twin in api/_lib/takeoff-assemble.js
 * (parseLegendQty) — a shared test (legend-qty.test.ts) pins both to the
 * same cases so the takeoff and the UI can never disagree about what counts.
 */

export interface LegendQty {
  qty: number;
  unit: "ea" | "m²" | "lm" | "m";
}

const QTY_RE = /(?:^|[\s(])(\d{1,5}(?:\.\d{1,2})?)\s*(ea|m2|m²|lm|m)(?=$|[\s).,;:])/i;

export function parseLegendQty(text: string | null | undefined): LegendQty | null {
  if (text === null || text === undefined) return null;
  const m = String(text).match(QTY_RE);
  if (!m) return null;
  const qty = Number(m[1]);
  const unitRaw = m[2]!.toLowerCase();
  const unit = (unitRaw === "m2" ? "m²" : unitRaw) as LegendQty["unit"];
  if (unit === "ea" && !Number.isInteger(qty)) return null;
  return { qty, unit };
}

/** Same normalisation the store's dedupe key uses (lower/trim/collapse). */
export function normalizeLegendLabel(label: string | null | undefined): string {
  return String(label ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
