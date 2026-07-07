import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseLegendQty, normalizeLegendLabel } from "./legend-qty";

/**
 * #882 — the legend-quantity parser exists TWICE on purpose (TS for the
 * client, CJS inside the pure takeoff assembler) because api/_lib is CJS and
 * client code can't import it. This suite runs the SAME cases through BOTH so
 * the takeoff and the UI can never disagree about what counts as a legend
 * quantity.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS module under test
const ta: any = requireFromHere("../../../api/_lib/takeoff-assemble.js");

const CASES: Array<[string | null, { qty: number; unit: string } | null]> = [
  // The real Sansara legend forms (live-verified during the AI test session).
  ["49 EA", { qty: 49, unit: "ea" }],
  ["1 EA", { qty: 1, unit: "ea" }],
  ["2.34 m²", { qty: 2.34, unit: "m²" }],
  ["2.34 m2", { qty: 2.34, unit: "m²" }],
  ["12 LM", { qty: 12, unit: "lm" }],
  ["3 m", { qty: 3, unit: "m" }],
  // Embedded in longer legend text.
  ["DGPO C2000 Clipsal 49 EA", { qty: 49, unit: "ea" }],
  ["(17 EA) per schedule", { qty: 17, unit: "ea" }],
  // NOT quantities — never invented (P7).
  ["DGPO C2000 Clipsal", null],
  ["10A outlet", null], // amps, not a count
  ["2.5 EA", null], // fractional each is nonsense — refuse
  ["3 mm conduit", null], // mm is not a takeoff unit here
  ["EA", null],
  ["", null],
  [null, null],
];

describe("parseLegendQty — TS/CJS parity (#882)", () => {
  for (const [input, expected] of CASES) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)} (both parsers)`, () => {
      expect(parseLegendQty(input)).toEqual(expected);
      expect(ta.parseLegendQty(input)).toEqual(expected);
    });
  }
});

describe("normalizeLegendLabel — matches the store's dedupe key", () => {
  it("lower/trim/collapse, both implementations", () => {
    for (const raw of ["  DGPO   C2000 ", "Distribution Board", ""]) {
      expect(normalizeLegendLabel(raw)).toBe(ta.normalizeLabel(raw));
    }
  });
});
