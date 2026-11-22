import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * BuhlOS-issued job numbers — the real SQL against a real Postgres (#1152):
 * the counter, the claims, and above all that requests arriving at the same
 * instant get DIFFERENT numbers. Gate: JOB_CODES_PG_TEST=1 and
 * SUPABASE_ENV=local with a throwaway local database (every migration
 * applied, a `buhl` tenant). Skipped in CI.
 *
 * Each test runs against its OWN throwaway tenant, so the counter starts
 * fresh and nothing else in the database is touched.
 *
 * Concurrency is real: each "request" gets its own connection (max: 1, the
 * production pool shape), the way separate serverless instances would.
 */
const ENABLED =
  process.env.JOB_CODES_PG_TEST === "1" &&
  process.env.SUPABASE_ENV === "local" &&
  !!process.env.SUPABASE_DB_URL;
const requireFromHere = createRequire(import.meta.url);

type Sql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>;
  end: (o?: { timeout?: number }) => Promise<void>;
};

describe.skipIf(!ENABLED)("job numbers — real Postgres", () => {
  const C = requireFromHere("../../../api/_lib/job-codes.js");
  const postgres = requireFromHere("postgres");
  const marker = `jc${Date.now().toString(36)}`;
  const pools: Sql[] = [];
  const tenants: string[] = [];
  let sql: Sql;
  let tenantId: string;
  let n = 0;

  const connect = (): Sql => {
    const c = postgres(process.env.SUPABASE_DB_URL as string, { max: 1, prepare: false, onnotice: () => {} });
    pools.push(c);
    return c;
  };
  const claims = async () => (await sql`select code, job_legacy_id, source from public.job_code_claims where tenant_id = ${tenantId} order by code`).map((r) => `${r.code}:${r.job_legacy_id ?? "-"}:${r.source}`);
  const counter = async () => Number((await sql`select next_value from public.job_code_counters where tenant_id = ${tenantId}`)[0]?.next_value ?? NaN);

  beforeAll(() => {
    sql = connect();
  });

  beforeEach(async () => {
    const slug = `${marker}-${++n}`;
    tenantId = String((await sql`insert into public.tenants (name, slug) values (${slug}, ${slug}) returning id`)[0]!.id);
    tenants.push(tenantId);
  });

  afterAll(async () => {
    if (sql) {
      for (const t of tenants) {
        await sql`delete from public.job_code_claims where tenant_id = ${t}`;
        await sql`delete from public.job_code_counters where tenant_id = ${t}`;
        await sql`delete from public.tenants where id = ${t}`;
      }
    }
    await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
  });

  it("the first number is IV4000, then they run in order, each claimed for its job", async () => {
    const actor = { id: "u_office", name: "Olive Office" };
    expect(await C.issueNextCode(sql, tenantId, { jobId: "job-a", actor })).toBe("IV4000");
    expect(await C.issueNextCode(sql, tenantId, { jobId: "job-b", actor })).toBe("IV4001");
    expect(await C.issueNextCode(sql, tenantId, {})).toBe("IV4002");
    expect(await claims()).toEqual(["IV4000:job-a:issued", "IV4001:job-b:issued", "IV4002:-:issued"]);
    expect(await counter()).toBe(4003);
    const who = await sql`select claimed_by_legacy_id, claimed_by_name from public.job_code_claims where tenant_id = ${tenantId} and code = 'IV4000'`;
    expect(who[0]).toMatchObject({ claimed_by_legacy_id: "u_office", claimed_by_name: "Olive Office" });
  });

  it("skips numbers already on a job and numbers already claimed", async () => {
    await C.claimTypedCode(sql, tenantId, "IV4001", { jobId: "typed-job" });
    const existingCodes = ["IV4000", "iv4002", "IV3345", "IV7001", null, "junk"];
    expect(await C.issueNextCode(sql, tenantId, { existingCodes })).toBe("IV4003");
    expect(await C.issueNextCode(sql, tenantId, { existingCodes })).toBe("IV4004");
    // a number that is on a job but was never claimed stays skipped only while it is on the list
    expect(await counter()).toBe(4005);
  });

  it("TWENTY REQUESTS AT THE SAME INSTANT, each on its own connection: twenty different numbers", async () => {
    const conns = Array.from({ length: 20 }, connect);
    const got = await Promise.all(conns.map((c, i) => C.issueNextCode(c, tenantId, { jobId: `job-${i}` })));
    expect(new Set(got).size).toBe(20);
    expect([...got].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `IV${4000 + i}`));
    expect(await counter()).toBe(4020);
    expect(await claims()).toHaveLength(20);
  });

  it("issuing while numbers are being typed at the same time never hands out a typed number", async () => {
    const issuers = Array.from({ length: 6 }, connect);
    const typers = Array.from({ length: 6 }, connect);
    // The same retry the connect() seam applies when an issue loses the race
    // for a number to a typed claim (the whole transaction rolls back).
    const issue = async (c: Sql, i: number) => {
      for (let attempt = 1; ; attempt += 1) {
        try { return await C.issueNextCode(c, tenantId, { jobId: `issued-${i}` }) as string; }
        catch (e) { if ((e as { code?: string }).code !== "23505" || attempt >= 5) throw e; }
      }
    };
    const results = await Promise.all([
      ...issuers.map((c, i) => issue(c, i)),
      ...typers.map((c, i) => C.claimTypedCode(c, tenantId, `IV${4000 + i * 2}`, { jobId: `typed-${i}` }).then((r: { ok: boolean }) => r)),
    ]);
    const issued = results.slice(0, 6) as string[];
    const typed = results.slice(6) as Array<{ ok: boolean }>;
    const all = await claims();
    // every claim row is one job's; no code appears twice (the unique rule)
    expect(new Set(all.map((c) => c.split(":")[0])).size).toBe(all.length);
    // an issued number never equals a number a typer successfully claimed
    const typedWon = typed.map((r, i) => (r.ok ? `IV${4000 + i * 2}` : null)).filter(Boolean);
    for (const code of issued) expect(typedWon).not.toContain(code);
    expect(new Set(issued).size).toBe(6);
  });

  it("a typed number: claimed once, the same job may ask again, another job is told who has it", async () => {
    expect(await C.claimTypedCode(sql, tenantId, "IV3400", { jobId: "job-a", actor: { id: "u1", name: "Sam" } })).toEqual({ ok: true, fresh: true });
    expect(await C.claimTypedCode(sql, tenantId, "IV3400", { jobId: "job-a" })).toEqual({ ok: true, fresh: false });
    expect(await C.claimTypedCode(sql, tenantId, "IV3400", { jobId: "job-b" })).toEqual({ ok: false, heldBy: "job-a" });
    expect(await claims()).toEqual(["IV3400:job-a:typed"]);
    // a number BuhlOS issued can't then be typed onto a different job
    const issued = await C.issueNextCode(sql, tenantId, { jobId: "job-c" });
    expect(await C.claimTypedCode(sql, tenantId, issued, { jobId: "job-d" })).toEqual({ ok: false, heldBy: "job-c" });
  });

  it("release gives back a TYPED number for that job only; an issued number is never given back", async () => {
    await C.claimTypedCode(sql, tenantId, "IV3500", { jobId: "job-a" });
    const issued = await C.issueNextCode(sql, tenantId, { jobId: "job-b" });
    await C.releaseClaim(sql, tenantId, "IV3500", "someone-else");
    await C.releaseClaim(sql, tenantId, issued, "job-b");
    expect(await claims()).toEqual(["IV3500:job-a:typed", `${issued}:job-b:issued`]);
    await C.releaseClaim(sql, tenantId, "IV3500", "job-a");
    expect(await claims()).toEqual([`${issued}:job-b:issued`]);
    // the counter never goes back
    expect(await C.issueNextCode(sql, tenantId, {})).toBe("IV4001");
  });

  it("stops at IV9999 with its own reason, and uses nothing up when it does", async () => {
    await C.issueNextCode(sql, tenantId, {});
    await sql`update public.job_code_counters set next_value = 9999 where tenant_id = ${tenantId}`;
    expect(await C.issueNextCode(sql, tenantId, {})).toBe("IV9999");
    expect(await counter()).toBe(10000);
    await expect(C.issueNextCode(sql, tenantId, {})).rejects.toMatchObject({ name: "JobCodeError", reason: "range_exhausted" });
    await expect(C.issueNextCode(sql, tenantId, {})).rejects.toMatchObject({ reason: "range_exhausted" });
    expect(await counter()).toBe(10000);
    expect(await claims()).toHaveLength(2);
  });

  it("the database itself refuses a duplicate number, a malformed one, and a counter outside the range", async () => {
    await C.claimTypedCode(sql, tenantId, "IV4000", { jobId: "job-a" });
    await expect(sql`insert into public.job_code_claims (tenant_id, code, job_legacy_id, source) values (${tenantId}, 'IV4000', 'job-b', 'typed')`).rejects.toThrow(/duplicate|unique/i);
    await expect(sql`insert into public.job_code_claims (tenant_id, code, source) values (${tenantId}, '4000', 'typed')`).rejects.toThrow(/check/i);
    await expect(sql`insert into public.job_code_claims (tenant_id, code, source) values (${tenantId}, 'IV4005', 'guessed')`).rejects.toThrow(/check/i);
    await expect(sql`insert into public.job_code_counters (tenant_id, series, next_value) values (${tenantId}, 'IV', 3999)`).rejects.toThrow(/check/i);
  });
});
