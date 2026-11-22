import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Customer stage invoices — the Xero set-up SQL (#1149) against a real
 * Postgres: the per-organisation invoice defaults and the "another job for
 * this client uses…" suggestion. Same gate as
 * customer-invoices-store.pg.test.ts: CUSTOMER_INVOICES_PG_TEST=1 and
 * SUPABASE_ENV=local, a throwaway local database. Skipped in CI.
 */
const ENABLED =
  process.env.CUSTOMER_INVOICES_PG_TEST === "1" &&
  process.env.SUPABASE_ENV === "local" &&
  !!process.env.SUPABASE_DB_URL;
const requireFromHere = createRequire(import.meta.url);

type Sql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>;
  end: (o?: { timeout?: number }) => Promise<void>;
};

describe.skipIf(!ENABLED)("customer invoices Xero set-up — real Postgres", () => {
  const store = requireFromHere("../../../api/_lib/customer-invoices/store.js");
  const postgres = requireFromHere("postgres");
  const marker = `cx${Date.now().toString(36)}`;
  const org = (n: string) => `${marker}-org-${n}`;
  const job = (n: string) => `${marker}-${n}`;
  const actor = { id: "u_office", name: "Olive Office", role: "office" };
  const choice = (over: Record<string, unknown> = {}) => ({
    salesAccountCode: "200", salesAccountName: "Sales", taxType: "OUTPUT", taxName: "GST on Income",
    taxRateBp: 1000, paymentTermsDays: 30, ...over,
  });
  let sql: Sql;
  let tenantId: string;

  beforeAll(async () => {
    sql = postgres(process.env.SUPABASE_DB_URL as string, { max: 1, prepare: false, onnotice: () => {} });
    tenantId = (await store.resolveTenant(sql)).id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.customer_invoice_events where detail->>'externalTenantId' like ${marker + "%"}`;
    await sql`delete from public.customer_invoice_events where job_legacy_id like ${marker + "%"}`;
    await sql`delete from public.customer_invoice_settings where external_tenant_id like ${marker + "%"}`;
    await sql`delete from public.customer_invoice_job_profiles where job_legacy_id like ${marker + "%"}`;
    await sql.end({ timeout: 5 });
  });

  it("has no defaults until they are saved, and none at all without an organisation", async () => {
    expect(await store.getSettings(sql, tenantId, org("a"))).toBeNull();
    expect(await store.getSettings(sql, tenantId, null)).toBeNull();
    expect(store.settingsComplete(null)).toBe(false);
  });

  it("saves the defaults once, then only with the current version", async () => {
    const first = await store.saveSettings(sql, tenantId, org("a"), choice(), { expectedVersion: null, actor });
    expect(first).toMatchObject({
      externalTenantId: org("a"), salesAccountCode: "200", salesAccountName: "Sales", taxType: "OUTPUT",
      taxName: "GST on Income", taxRateBp: 1000, paymentTermsDays: 30, version: 1, updatedBy: "Olive Office",
    });
    expect(typeof first.taxRateBp).toBe("number");
    expect(store.settingsComplete(first)).toBe(true);

    await expect(store.saveSettings(sql, tenantId, org("a"), choice(), { expectedVersion: null, actor })).rejects.toMatchObject({ name: "StoreConflict", reason: "version" });
    await expect(store.saveSettings(sql, tenantId, org("a"), choice(), { expectedVersion: 5, actor })).rejects.toMatchObject({ reason: "version" });

    const second = await store.saveSettings(sql, tenantId, org("a"), choice({ salesAccountCode: "260", salesAccountName: "Other Revenue", paymentTermsDays: 0 }), { expectedVersion: 1, actor });
    expect(second).toMatchObject({ salesAccountCode: "260", paymentTermsDays: 0, version: 2 });
    // 0 days and a 0% rate are real choices, not "missing"
    expect(store.settingsComplete(second)).toBe(true);
    expect(store.settingsComplete({ ...second, taxRateBp: 0 })).toBe(true);
    expect(store.settingsComplete({ ...second, paymentTermsDays: null })).toBe(false);
    expect(store.settingsComplete({ ...second, salesAccountCode: null })).toBe(false);
  });

  it("keeps each Xero organisation's defaults apart", async () => {
    await store.saveSettings(sql, tenantId, org("b"), choice({ salesAccountCode: "999", salesAccountName: "Org B Sales" }), { expectedVersion: null, actor });
    expect((await store.getSettings(sql, tenantId, org("a"))).salesAccountCode).toBe("260");
    expect((await store.getSettings(sql, tenantId, org("b"))).salesAccountCode).toBe("999");
  });

  it("the schema refuses a tax rate or payment terms outside what makes sense", async () => {
    await expect(store.saveSettings(sql, tenantId, org("bad1"), choice({ taxRateBp: 10001 }), { expectedVersion: null, actor })).rejects.toThrow(/check/i);
    await expect(store.saveSettings(sql, tenantId, org("bad2"), choice({ paymentTermsDays: 366 }), { expectedVersion: null, actor })).rejects.toThrow(/check/i);
    await expect(store.saveSettings(sql, tenantId, org("bad3"), choice({ paymentTermsDays: -1 }), { expectedVersion: null, actor })).rejects.toThrow(/check/i);
    expect(await store.getSettings(sql, tenantId, org("bad1"))).toBeNull();
  });

  it("suggests the most recently linked contact among the given jobs, in the given organisation only", async () => {
    const link = (j: string, id: string, name: string, o: string, expectedVersion: number | null = null) =>
      store.saveProfile(sql, tenantId, job(j), { xeroContactId: id, xeroContactName: name, externalTenantId: org(o) }, { expectedVersion, actor });
    await link("j1", "c-old", "Built (old)", "a");
    await link("j2", "c-new", "Built Pty Ltd", "a");
    await link("j3", "c-other-org", "Built in Org B", "b");
    await store.saveProfile(sql, tenantId, job("j4"), { retentionBp: 500 }, { expectedVersion: null, actor }); // no contact

    const all = [job("j1"), job("j2"), job("j3"), job("j4")];
    expect(await store.latestContactAmongJobs(sql, tenantId, all, org("a"))).toEqual({ id: "c-new", name: "Built Pty Ltd", fromJobId: job("j2") });
    expect(await store.latestContactAmongJobs(sql, tenantId, all, org("b"))).toMatchObject({ id: "c-other-org" });
    expect(await store.latestContactAmongJobs(sql, tenantId, [job("j1")], org("a"))).toMatchObject({ id: "c-old" });

    // re-linking j1 makes it the most recent
    await link("j1", "c-relinked", "Built Group", "a", 1);
    expect(await store.latestContactAmongJobs(sql, tenantId, all, org("a"))).toMatchObject({ id: "c-relinked" });

    // nothing to go on → no suggestion (and no SQL error on an empty list)
    expect(await store.latestContactAmongJobs(sql, tenantId, [], org("a"))).toBeNull();
    expect(await store.latestContactAmongJobs(sql, tenantId, [job("j4")], org("a"))).toBeNull();
    expect(await store.latestContactAmongJobs(sql, tenantId, all, null)).toBeNull();
    expect(await store.latestContactAmongJobs(sql, tenantId, all, org("zzz"))).toBeNull();
  });

  it("unlinking clears the contact but keeps the job's retention", async () => {
    const j = job("unlink");
    await store.saveProfile(sql, tenantId, j, { retentionBp: 500 }, { expectedVersion: null, actor });
    await store.saveProfile(sql, tenantId, j, { xeroContactId: "c1", xeroContactName: "Built", externalTenantId: org("a") }, { expectedVersion: 1, actor });
    const cleared = await store.saveProfile(sql, tenantId, j, { xeroContactId: null, xeroContactName: null, externalTenantId: null }, { expectedVersion: 2, actor });
    expect(cleared).toMatchObject({ retentionBp: 500, xeroContactId: null, xeroContactName: null, externalTenantId: null, version: 3 });
  });
});
