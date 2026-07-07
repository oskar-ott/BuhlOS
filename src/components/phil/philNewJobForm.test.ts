import { describe, expect, it } from "vitest";
import {
  canCreateJobInput,
  codeFromDigits,
  nextFree7000,
  realCodesOnList,
  sanitizeDigits,
} from "./philNewJobForm";

describe("sanitizeDigits", () => {
  it("keeps only digits, capped at 4", () => {
    expect(sanitizeDigits("7001")).toBe("7001");
    expect(sanitizeDigits("70x0!1")).toBe("7001");
    expect(sanitizeDigits("700123")).toBe("7001");
    expect(sanitizeDigits("IV7001")).toBe("7001");
    expect(sanitizeDigits("")).toBe("");
  });
});

describe("canCreateJobInput — create stays disabled until valid", () => {
  it("requires a real name AND exactly 4 digits", () => {
    expect(canCreateJobInput("Bakery", "0041")).toBe(true);
    expect(canCreateJobInput("", "0041")).toBe(false);
    expect(canCreateJobInput("   ", "0041")).toBe(false);
    expect(canCreateJobInput("Bakery", "")).toBe(false);
    expect(canCreateJobInput("Bakery", "41")).toBe(false);
    expect(canCreateJobInput("Bakery", "00411")).toBe(false);
  });
});

describe("codeFromDigits", () => {
  it("locks the IV prefix", () => {
    expect(codeFromDigits("0041")).toBe("IV0041");
    expect(codeFromDigits("7001")).toBe("IV7001");
  });
});

describe("realCodesOnList — nothing invented (P7)", () => {
  it("returns only real IV#### codes, uppercased + de-duplicated", () => {
    expect(
      realCodesOnList([
        { code: "IV0041" },
        { code: "iv0038" },
        { code: "IV0041" }, // dup
        { code: null },
        {},
        { code: "J-2041" }, // wrong format — not a code
        { code: "IV38" }, // too short
      ] as Array<{ code?: string | null }>),
    ).toEqual(["IV0041", "IV0038"]);
  });

  it("is empty for a list with no codes (most workers today)", () => {
    expect(realCodesOnList([{ code: null }, {}] as Array<{ code?: string | null }>)).toEqual([]);
  });
});

describe("nextFree7000 — from ACTUAL codes only", () => {
  it("defaults to 7001 when nothing in the 7000s is taken", () => {
    expect(nextFree7000([])).toBe("7001");
    expect(nextFree7000(["IV0041", "IV0038"])).toBe("7001");
  });

  it("skips taken numbers, including gaps", () => {
    expect(nextFree7000(["IV7001", "IV7002"])).toBe("7003");
    expect(nextFree7000(["IV7001", "IV7003"])).toBe("7002");
    expect(nextFree7000(["iv7001"])).toBe("7002"); // case-insensitive
  });

  it("ignores non-7000s and malformed refs", () => {
    expect(nextFree7000(["IV0041", "nonsense", "IV70011"])).toBe("7001");
  });

  it("returns null only when the whole 7001..7999 range is taken", () => {
    const all = Array.from({ length: 999 }, (_, i) => `IV${7001 + i}`);
    expect(nextFree7000(all)).toBeNull();
    expect(nextFree7000(all.slice(0, 998))).toBe("7999");
  });
});
