import { describe, expect, it } from "vitest";
import {
  applicabilityReason,
  applicablePoints,
  isPointApplicable,
} from "./applicability";
import { ITP_CONDITION_KEYS, ITP_SCOPES } from "./schema";
import type { ITPScope, ITPTemplatePoint } from "./types";

/**
 * #293 — conditional ("only-if") points, scope-type v1.
 *
 * The contract these tests pin:
 *   - no onlyIf → applies (byte-for-byte the pre-#293 behaviour);
 *   - unknown / garbage condition key → APPLIES (fail-open, P7 — a typo
 *     never silently drops a real check);
 *   - scopeType match / mismatch (scalar + array form);
 *   - the function is TOTAL (a boolean for every input) and
 *     DETERMINISTIC (same input → same output).
 */

function point(over: Partial<ITPTemplatePoint> = {}): ITPTemplatePoint {
  return {
    id: "p1",
    label: "Test point",
    type: "signoff",
    required: true,
    ...over,
  } as ITPTemplatePoint;
}

describe("ITP_CONDITION_KEYS — closed vocabulary v1", () => {
  it("is exactly ['scopeType']", () => {
    expect([...ITP_CONDITION_KEYS]).toEqual(["scopeType"]);
  });
});

describe("isPointApplicable — no condition", () => {
  it("applies when onlyIf is absent (legacy point)", () => {
    expect(isPointApplicable(point(), { scope: "area" })).toBe(true);
  });

  it("applies when onlyIf is null", () => {
    expect(
      isPointApplicable(point({ onlyIf: null }), { scope: "area" }),
    ).toBe(true);
  });

  it("applies when onlyIf is not an object (garbage)", () => {
    // Hand-rolled garbage that bypassed the save-time whitelist.
    const p = { ...point(), onlyIf: "switchboard" } as unknown as ITPTemplatePoint;
    expect(isPointApplicable(p, { scope: "area" })).toBe(true);
  });
});

describe("isPointApplicable — unknown / garbage key (FAIL-OPEN)", () => {
  it("applies when onlyIf carries only an unrecognised key", () => {
    const p = {
      ...point(),
      onlyIf: { jobAttribute: "two-phase" },
    } as unknown as ITPTemplatePoint;
    expect(isPointApplicable(p, { scope: "area" })).toBe(true);
  });

  it("applies when scopeType is present but malformed (empty array)", () => {
    const p = {
      ...point(),
      onlyIf: { scopeType: [] },
    } as unknown as ITPTemplatePoint;
    expect(isPointApplicable(p, { scope: "area" })).toBe(true);
  });

  it("applies when scopeType is a non-string scalar", () => {
    const p = {
      ...point(),
      onlyIf: { scopeType: 42 },
    } as unknown as ITPTemplatePoint;
    expect(isPointApplicable(p, { scope: "area" })).toBe(true);
  });

  it("applies when scopeType array contains only junk entries", () => {
    const p = {
      ...point(),
      onlyIf: { scopeType: [1, true, null] },
    } as unknown as ITPTemplatePoint;
    expect(isPointApplicable(p, { scope: "area" })).toBe(true);
  });
});

describe("isPointApplicable — scopeType (scalar)", () => {
  it("applies on a matching scope", () => {
    const p = point({ onlyIf: { scopeType: "switchboard" } });
    expect(isPointApplicable(p, { scope: "switchboard" })).toBe(true);
  });

  it("does NOT apply on a mismatching scope", () => {
    const p = point({ onlyIf: { scopeType: "switchboard" } });
    expect(isPointApplicable(p, { scope: "area" })).toBe(false);
  });
});

describe("isPointApplicable — scopeType (array)", () => {
  it("applies when the scope is in the allowed array", () => {
    const p = point({ onlyIf: { scopeType: ["switchboard", "level"] } });
    expect(isPointApplicable(p, { scope: "level" })).toBe(true);
  });

  it("does NOT apply when the scope is outside the allowed array", () => {
    const p = point({ onlyIf: { scopeType: ["switchboard", "level"] } });
    expect(isPointApplicable(p, { scope: "job" })).toBe(false);
  });
});

describe("isPointApplicable — total + deterministic", () => {
  it("returns a boolean for every scope × condition combination", () => {
    const conds: Array<Partial<ITPTemplatePoint>> = [
      {},
      { onlyIf: null },
      { onlyIf: { scopeType: "switchboard" } },
      { onlyIf: { scopeType: ["job", "area"] } },
      { onlyIf: { scopeType: [] } as unknown as ITPTemplatePoint["onlyIf"] },
    ];
    for (const scope of ITP_SCOPES) {
      for (const c of conds) {
        const v = isPointApplicable(point(c), { scope: scope as ITPScope });
        expect(typeof v).toBe("boolean");
      }
    }
  });

  it("is deterministic — same input, same output across calls", () => {
    const p = point({ onlyIf: { scopeType: ["switchboard"] } });
    const a = isPointApplicable(p, { scope: "area" });
    const b = isPointApplicable(p, { scope: "area" });
    const c = isPointApplicable(p, { scope: "area" });
    expect(a).toBe(false);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe("applicabilityReason", () => {
  it("returns null when the point applies", () => {
    expect(applicabilityReason(point(), { scope: "area" })).toBeNull();
  });

  it("names the allowed scopes when excluded (scalar)", () => {
    const p = point({ onlyIf: { scopeType: "switchboard" } });
    expect(applicabilityReason(p, { scope: "area" })).toBe(
      "Only applies to switchboard",
    );
  });

  it("names all allowed scopes when excluded (array)", () => {
    const p = point({ onlyIf: { scopeType: ["switchboard", "level"] } });
    expect(applicabilityReason(p, { scope: "job" })).toBe(
      "Only applies to switchboard, level",
    );
  });
});

describe("applicablePoints", () => {
  it("keeps applicable points, drops non-applicable, preserves order", () => {
    const points = [
      point({ id: "a" }),
      point({ id: "b", onlyIf: { scopeType: "switchboard" } }),
      point({ id: "c", onlyIf: { scopeType: ["area", "level"] } }),
    ];
    const out = applicablePoints(points, { scope: "area" });
    expect(out.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("returns all points unchanged when none carry a condition", () => {
    const points = [point({ id: "a" }), point({ id: "b" })];
    const out = applicablePoints(points, { scope: "job" });
    expect(out).toEqual(points);
  });
});
