import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  applicabilityReason as tsReason,
  isPointApplicable as tsApplicable,
} from "./applicability";
import { ITP_CONDITION_KEYS, ITP_SCOPES } from "./schema";
import type { ITPScope } from "./types";

/**
 * #293 — JS ↔ TS parity for conditional ("only-if") point evaluation.
 *
 * src/domains/itp/applicability.ts (TS) and api/_lib/itp-applicability.js
 * (CJS mirror) must agree byte-for-byte on the SAME truth table, because
 * Phil/admin/export evaluate in TS while the api/job-itps.js record
 * rejection + witnessed gate evaluate in JS. If they drift, a worker
 * could be shown a check the server then refuses (or vice versa).
 *
 * Same house pattern as the JS↔TS state-machine parity assertion in
 * itp.test.ts (allowedTransitionsList) — exercised over a shared matrix.
 */

const requireFromHere = createRequire(import.meta.url);
const js = requireFromHere("../../../api/_lib/itp-applicability.js") as {
  isPointApplicable: (point: unknown, ctx: { scope: string }) => boolean;
  applicabilityReason: (
    point: unknown,
    ctx: { scope: string },
  ) => string | null;
  CONDITION_KEYS: string[];
};

// A deliberately broad matrix: no condition, null, scalar match/mismatch,
// array forms, and several flavours of garbage that should all fail open.
const ONLY_IF_CASES: Array<unknown> = [
  undefined,
  null,
  "switchboard", // not an object
  {}, // empty object → no known key
  { scopeType: "switchboard" },
  { scopeType: "area" },
  { scopeType: ["switchboard", "level"] },
  { scopeType: ["job"] },
  { scopeType: [] }, // malformed → fail open
  { scopeType: 42 }, // non-string scalar → fail open
  { scopeType: [1, true, null] }, // junk array → fail open
  { scopeType: null }, // null value → no known key → fail open
  { jobAttribute: "two-phase" }, // unknown key → fail open
  { scopeType: "switchboard", jobAttribute: "x" }, // known + unknown
];

function makePoint(onlyIf: unknown) {
  return { id: "p", label: "x", type: "signoff", required: true, onlyIf };
}

describe("itp-applicability JS ↔ TS parity", () => {
  it("CONDITION_KEYS mirror ITP_CONDITION_KEYS", () => {
    expect([...js.CONDITION_KEYS].sort()).toEqual([...ITP_CONDITION_KEYS].sort());
  });

  it("isPointApplicable agrees across the full matrix", () => {
    for (const onlyIf of ONLY_IF_CASES) {
      for (const scope of ITP_SCOPES) {
        const point = makePoint(onlyIf);
        const ctx = { scope: scope as ITPScope };
        const jsVal = js.isPointApplicable(point, ctx);
        const tsVal = tsApplicable(point as never, ctx);
        expect(
          jsVal,
          `mismatch for onlyIf=${JSON.stringify(onlyIf)} scope=${scope}`,
        ).toBe(tsVal);
      }
    }
  });

  it("applicabilityReason agrees across the full matrix", () => {
    for (const onlyIf of ONLY_IF_CASES) {
      for (const scope of ITP_SCOPES) {
        const point = makePoint(onlyIf);
        const ctx = { scope: scope as ITPScope };
        const jsReason = js.applicabilityReason(point, ctx);
        const reason = tsReason(point as never, ctx);
        expect(
          jsReason,
          `reason mismatch for onlyIf=${JSON.stringify(onlyIf)} scope=${scope}`,
        ).toBe(reason);
      }
    }
  });
});
