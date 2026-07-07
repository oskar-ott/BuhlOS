import { describe, expect, it, vi } from "vitest";
import {
  canCreateJobInput,
  codeFromDigits,
  findJobIdByCode,
  nextFree7000,
  realCodesOnList,
  recoverJobIdAfterTimeout,
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

describe("findJobIdByCode — the timeout-recovery probe", () => {
  const jobs = [
    { id: "job-active", code: "IV0041" },
    { id: "payneham-rd-bakery", code: "iv0038" }, // stored case may differ
    { id: "no-code" },
    { code: "IV7001" }, // no id — unusable
    null,
    "garbage",
  ];

  it("finds the job carrying the submitted code, case-insensitively", () => {
    expect(findJobIdByCode(jobs, "IV0038")).toBe("payneham-rd-bakery");
    expect(findJobIdByCode(jobs, "iv0041")).toBe("job-active");
  });

  it("returns null when the code is absent or the shapes are junk", () => {
    expect(findJobIdByCode(jobs, "IV9999")).toBeNull();
    expect(findJobIdByCode([], "IV0041")).toBeNull();
    expect(findJobIdByCode(jobs, "IV7001")).toBeNull(); // no id on that row
    expect(findJobIdByCode(jobs, "not-a-code")).toBeNull();
  });
});

describe("recoverJobIdAfterTimeout — only a REAL list hit counts as success", () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  it("returns the created job's id when the code is now on the list", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ jobs: [{ id: "payneham-rd-bakery", code: "IV0038" }] }),
    ) as unknown as typeof fetch;
    await expect(recoverJobIdAfterTimeout("IV0038", fetchImpl)).resolves.toBe(
      "payneham-rd-bakery",
    );
    expect(fetchImpl).toHaveBeenCalledWith("/api/jobs", { cache: "no-store" });
  });

  it("returns null when the code is NOT on the list (the create truly failed)", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ jobs: [{ id: "job-active", code: "IV0041" }] }),
    ) as unknown as typeof fetch;
    await expect(recoverJobIdAfterTimeout("IV0038", fetchImpl)).resolves.toBeNull();
  });

  it("returns null on a non-2xx reply, a junk body, or a thrown fetch — never a false success", async () => {
    const bad = ({ ok: false, json: async () => ({}) }) as unknown as Response;
    await expect(
      recoverJobIdAfterTimeout("IV0038", (async () => bad) as unknown as typeof fetch),
    ).resolves.toBeNull();
    await expect(
      recoverJobIdAfterTimeout(
        "IV0038",
        (async () => okResponse({ nope: true })) as unknown as typeof fetch,
      ),
    ).resolves.toBeNull();
    await expect(
      recoverJobIdAfterTimeout(
        "IV0038",
        (async () => {
          throw new TypeError("network down");
        }) as unknown as typeof fetch,
      ),
    ).resolves.toBeNull();
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
