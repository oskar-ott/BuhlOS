import { describe, expect, it, vi } from "vitest";
import type { Job } from "@/domains/jobs/types";
import {
  canCreateJobInput,
  codeFromDigits,
  findJobIdByCode,
  jobOnListWithCode,
  newJobCodeClash,
  nextFree7000,
  realCodesOnList,
  recoverJobIdAfterTimeout,
  sanitizeDigits,
} from "./philNewJobForm";

const listJob = (id: string, name: string, code?: string | null) =>
  ({ id, name, code }) as Pick<Job, "id" | "name" | "code">;

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

describe("recoverJobIdAfterTimeout — only a NEW list hit counts as success", () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;
  const noPriorJobs = new Set<string>();

  it("returns created + the job's id when the code landed on a job that was NOT there before submit", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        jobs: [
          { id: "job-active", code: "IV0041" },
          { id: "payneham-rd-bakery", code: "IV0038" },
        ],
      }),
    ) as unknown as typeof fetch;
    await expect(
      recoverJobIdAfterTimeout("IV0038", new Set(["job-active"]), fetchImpl),
    ).resolves.toEqual({ outcome: "created", id: "payneham-rd-bakery" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/jobs", { cache: "no-store" });
  });

  it("a PRE-EXISTING job carrying the code is never claimed as success — the create didn't happen", async () => {
    // The worker already had payneham-rd-bakery (code IV0038) on their list
    // before tapping Create: the server would have 409'd this create, so a
    // list hit on that job proves failure, not success.
    const fetchImpl = vi.fn(async () =>
      okResponse({ jobs: [{ id: "payneham-rd-bakery", code: "IV0038" }] }),
    ) as unknown as typeof fetch;
    await expect(
      recoverJobIdAfterTimeout("IV0038", new Set(["payneham-rd-bakery"]), fetchImpl),
    ).resolves.toEqual({ outcome: "preexisting" });
  });

  it("returns unknown when the code is NOT on the list (the create truly failed)", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ jobs: [{ id: "job-active", code: "IV0041" }] }),
    ) as unknown as typeof fetch;
    await expect(
      recoverJobIdAfterTimeout("IV0038", noPriorJobs, fetchImpl),
    ).resolves.toEqual({ outcome: "unknown" });
  });

  it("returns unknown on a non-2xx reply, a junk body, or a thrown fetch — never a false success", async () => {
    const bad = ({ ok: false, json: async () => ({}) }) as unknown as Response;
    await expect(
      recoverJobIdAfterTimeout("IV0038", noPriorJobs, (async () => bad) as unknown as typeof fetch),
    ).resolves.toEqual({ outcome: "unknown" });
    await expect(
      recoverJobIdAfterTimeout(
        "IV0038",
        noPriorJobs,
        (async () => okResponse({ nope: true })) as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ outcome: "unknown" });
    await expect(
      recoverJobIdAfterTimeout(
        "IV0038",
        noPriorJobs,
        (async () => {
          throw new TypeError("network down");
        }) as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ outcome: "unknown" });
  });
});

describe("jobOnListWithCode / newJobCodeClash — the duplicate-code pre-guard", () => {
  const jobs = [
    listJob("job-active", "Active Site", "IV0041"),
    listJob("payneham-rd-bakery", "Payneham Rd Bakery", "iv0038"), // stored case may differ
    listJob("bare", "No code job", null),
  ];

  it("names the worker's own job already carrying the code, case-insensitively", () => {
    expect(jobOnListWithCode(jobs, "IV0038")).toEqual({
      id: "payneham-rd-bakery",
      name: "Payneham Rd Bakery",
    });
    expect(jobOnListWithCode(jobs, "iv0041")).toEqual({ id: "job-active", name: "Active Site" });
  });

  it("is null for a free code or a malformed one", () => {
    expect(jobOnListWithCode(jobs, "IV9999")).toBeNull();
    expect(jobOnListWithCode(jobs, "not-a-code")).toBeNull();
    expect(jobOnListWithCode([], "IV0041")).toBeNull();
  });

  it("newJobCodeClash disables Create only on a COMPLETE clashing entry — silent mid-type", () => {
    // The clash (Create disabled + inline hint) fires on 4 typed digits…
    expect(newJobCodeClash(jobs, "0038")).toEqual({
      id: "payneham-rd-bakery",
      name: "Payneham Rd Bakery",
    });
    // …but never nags a partial entry, and a free code stays clash-free.
    expect(newJobCodeClash(jobs, "003")).toBeNull();
    expect(newJobCodeClash(jobs, "")).toBeNull();
    expect(newJobCodeClash(jobs, "7002")).toBeNull();
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
