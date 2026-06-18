import { describe, expect, it } from "vitest";
import { evaluateAgainstCriteria } from "./criteria";

describe("evaluateAgainstCriteria — the one numeric pass/fail rule (#517)", () => {
  it("returns null when there is no criterion (both bounds absent)", () => {
    expect(evaluateAgainstCriteria(5, null, null)).toBeNull();
    expect(evaluateAgainstCriteria(5, undefined, undefined)).toBeNull();
  });

  it("returns null when the value is not a finite number", () => {
    expect(evaluateAgainstCriteria(null, 1, 10)).toBeNull();
    expect(evaluateAgainstCriteria(undefined, 1, 10)).toBeNull();
    expect(evaluateAgainstCriteria("", 1, 10)).toBeNull();
    expect(evaluateAgainstCriteria("abc", 1, 10)).toBeNull();
    expect(evaluateAgainstCriteria(Number.NaN, 1, 10)).toBeNull();
    expect(evaluateAgainstCriteria(Number.POSITIVE_INFINITY, 1, 10)).toBeNull();
  });

  it("coerces a numeric string", () => {
    expect(evaluateAgainstCriteria("5", 1, 10)).toBe("pass");
  });

  it("fails below min, fails above max, passes within (inclusive bounds)", () => {
    expect(evaluateAgainstCriteria(0.5, 1, 10)).toBe("fail");
    expect(evaluateAgainstCriteria(11, 1, 10)).toBe("fail");
    expect(evaluateAgainstCriteria(5, 1, 10)).toBe("pass");
    expect(evaluateAgainstCriteria(1, 1, 10)).toBe("pass"); // == min, inclusive
    expect(evaluateAgainstCriteria(10, 1, 10)).toBe("pass"); // == max, inclusive
  });

  it("min-only (e.g. insulation resistance >= 1 MOhm)", () => {
    expect(evaluateAgainstCriteria(0.9, 1, null)).toBe("fail");
    expect(evaluateAgainstCriteria(999, 1, null)).toBe("pass");
  });

  it("max-only (e.g. Zs <= 1.37 Ohm, RCD trip <= 40 ms)", () => {
    expect(evaluateAgainstCriteria(1.4, null, 1.37)).toBe("fail");
    expect(evaluateAgainstCriteria(1.0, null, 1.37)).toBe("pass");
  });

  it("handles negative bounds", () => {
    expect(evaluateAgainstCriteria(-5, -10, -1)).toBe("pass");
    expect(evaluateAgainstCriteria(0, -10, -1)).toBe("fail");
  });
});
