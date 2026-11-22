import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * api/_lib/job-codes.js (#1152) — the parts that need no database: what
 * counts as a job number, which numbers a job list already uses, the words a
 * person sees, and the `connect` seam turning every database failure into one
 * typed error (so a caller can never fall through to a made-up number).
 * The SQL itself: job-codes.pg.test.ts.
 */
const requireFromHere = createRequire(import.meta.url);
const C = requireFromHere("../../../api/_lib/job-codes.js");

describe("job numbers — the range", () => {
  it("starts at IV4000 and ends at IV9999", () => {
    expect([C.FIRST, C.LAST]).toEqual([4000, 9999]);
    expect(C.codeOf(4000)).toBe("IV4000");
    expect(C.codeOf(41)).toBe("IV0041");
  });

  it("normalises what a person types, and refuses anything that isn't IV + 4 digits", () => {
    expect(C.normaliseCode(" iv4013 ")).toBe("IV4013");
    for (const bad of ["4013", "IV413", "IV40130", "JV4013", "", null, undefined, 4013]) expect(C.normaliseCode(bad)).toBeNull();
  });

  it("usedNumbers keeps only real codes inside the issued range", () => {
    const used = C.usedNumbers(["IV3345", "iv4000", "IV7001", " IV9999 ", "IV0041", null, "nonsense", undefined]);
    expect([...used].sort()).toEqual([4000, 7001, 9999]);
    expect(C.usedNumbers(undefined).size).toBe(0);
  });
});

describe("job numbers — what a person is told", () => {
  it("is plain, says nothing was created, and offers typing a number", () => {
    const msg = C.issueFailureMessage(new C.JobCodeError("unavailable"));
    expect(msg).toBe("Couldn't get the next job number just now, so nothing was created. Try again, or type a job number instead.");
    expect(C.issueFailureMessage(new C.JobCodeError("unprovisioned"))).toBe(msg);
    expect(C.issueFailureMessage(new Error("ECONNRESET at 10.0.0.1"))).toBe(msg); // never the driver's words
    expect(C.issueFailureMessage(new C.JobCodeError("range_exhausted"))).toContain("up to IV9999 are used");
  });
});

describe("job numbers — the connect seam", () => {
  const tenantSql = (rows: unknown[]) => {
    const sql = async () => rows;
    return sql as unknown;
  };

  it("a database that can't be opened is `unavailable`, for every operation", async () => {
    const codes = C.connect({ getDb: () => { throw new Error("SUPABASE_DB_URL is not set"); } });
    await expect(codes.issue({})).rejects.toMatchObject({ name: "JobCodeError", reason: "unavailable" });
    await expect(codes.claimTyped("IV4000", {})).rejects.toMatchObject({ reason: "unavailable" });
    await expect(codes.release("IV4000", "j")).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("a database with no tenant row is `unprovisioned`", async () => {
    const codes = C.connect({ getDb: () => tenantSql([]) });
    await expect(codes.issue({})).rejects.toMatchObject({ reason: "unprovisioned" });
  });

  it("a query that fails mid-way is `unavailable` — the driver's error never escapes", async () => {
    let n = 0;
    const sql = Object.assign(async () => { n += 1; if (n === 1) return [{ id: "t1" }]; throw new Error("relation job_code_claims does not exist"); }, {
      begin: async () => { throw new Error("relation job_code_counters does not exist"); },
    });
    const codes = C.connect({ getDb: () => sql });
    await expect(codes.issue({})).rejects.toMatchObject({ name: "JobCodeError", reason: "unavailable" });
    await expect(codes.claimTyped("IV4000", {})).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("an issue that loses a race with a typed claim is tried again, then gives up cleanly", async () => {
    let begins = 0;
    const clash = Object.assign(new Error("duplicate key"), { code: "23505" });
    const sql = Object.assign(async () => [{ id: "t1" }], {
      begin: async () => { begins += 1; if (begins < 3) throw clash; return "IV4002"; },
    });
    expect(await C.connect({ getDb: () => sql }).issue({})).toBe("IV4002");
    expect(begins).toBe(3);

    begins = 0;
    const always = Object.assign(async () => [{ id: "t1" }], { begin: async () => { begins += 1; throw clash; } });
    await expect(C.connect({ getDb: () => always }).issue({})).rejects.toMatchObject({ reason: "unavailable" });
    expect(begins).toBe(3);
  });

  it("running out of numbers keeps its own reason", async () => {
    const sql = Object.assign(async () => [{ id: "t1" }], { begin: async () => { throw new C.JobCodeError("range_exhausted"); } });
    await expect(C.connect({ getDb: () => sql }).issue({})).rejects.toMatchObject({ reason: "range_exhausted" });
  });
});
