import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Customer stage invoices — the REAL store and the migration's constraints
 * against a real Postgres. The handler tests use an in-memory stand-in; this
 * is where the SQL itself is proven.
 *
 * Runs only with CUSTOMER_INVOICES_PG_TEST=1 and SUPABASE_ENV=local (a
 * throwaway local database with every file in supabase/migrations applied and
 * a `buhl` tenant row — docs/customer-invoices.md "Testing"). Local only: the
 * attempts table is immutable by trigger. Skipped in CI.
 */
const ENABLED =
  process.env.CUSTOMER_INVOICES_PG_TEST === "1" &&
  process.env.SUPABASE_ENV === "local" &&
  !!process.env.SUPABASE_DB_URL;
const requireFromHere = createRequire(import.meta.url);

type Sql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>;
  end: (o?: { timeout?: number }) => Promise<void>;
  json: (v: unknown) => unknown;
};

describe.skipIf(!ENABLED)("customer invoices store — real Postgres", () => {
  const store = requireFromHere("../../../api/_lib/customer-invoices/store.js");
  const postgres = requireFromHere("postgres");
  const marker = `ci${Date.now().toString(36)}`;
  const job = (n: string) => `${marker}-${n}`;
  const actor = { id: "u_office", name: "Olive Office", role: "office" };
  let sql: Sql;
  let tenantId: string;

  const amountStage = (title: string, amountCents: number, over: Record<string, unknown> = {}) => ({
    kind: "stage", title, basis: "amount", amountCents, percentBp: null, extraLines: [], retentionBp: null, plannedDate: null, note: null, ...over,
  });

  beforeAll(async () => {
    sql = postgres(process.env.SUPABASE_DB_URL as string, { max: 1, prepare: false, onnotice: () => {} });
    const t = await store.resolveTenant(sql);
    expect(t).toBeTruthy();
    tenantId = t.id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.customer_invoice_events where job_legacy_id like ${marker + "%"}`;
    await sql`delete from public.customer_invoices where job_legacy_id like ${marker + "%"}`;
    await sql`delete from public.customer_invoice_job_profiles where job_legacy_id like ${marker + "%"}`;
    await sql.end({ timeout: 5 });
  });

  it("creates planned stages in order and maps bigint money back to integer cents", async () => {
    const j = job("order");
    const a = await store.createStage(sql, tenantId, j, amountStage("Deposit", 12_345_67, {
      extraLines: [{ description: "Variation 1", amountCents: 1_200_00 }], plannedDate: "2026-12-01", note: "office note",
    }), actor);
    const b = await store.createStage(sql, tenantId, j, {
      kind: "stage", title: "Rough-in", basis: "percent", percentBp: 3000, amountCents: null, extraLines: [], retentionBp: 250, plannedDate: null, note: null,
    }, actor);

    expect(a).toMatchObject({ jobId: j, kind: "stage", title: "Deposit", basis: "amount", amountCents: 12_345_67, percentBp: null, state: "planned", version: 1, seq: null, invoiceNumber: null, plannedDate: "2026-12-01", note: "office note", createdBy: "Olive Office" });
    expect(typeof a.amountCents).toBe("number");
    expect(a.extraLines).toEqual([{ description: "Variation 1", amountCents: 1_200_00 }]);
    expect(b).toMatchObject({ basis: "percent", percentBp: 3000, amountCents: null, retentionBp: 250 });
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);

    const list = await store.listJobInvoices(sql, tenantId, j);
    expect(list.map((r: { title: string }) => r.title)).toEqual(["Deposit", "Rough-in"]);
    expect(await store.getInvoice(sql, tenantId, a.id)).toMatchObject({ id: a.id, title: "Deposit" });
    expect(await store.getInvoice(sql, tenantId, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("edits by compare-and-swap: the right version wins, a stale one is refused and changes nothing", async () => {
    const j = job("cas");
    const s = await store.createStage(sql, tenantId, j, amountStage("Deposit", 10_000_00), actor);
    const edited = await store.updateStage(sql, tenantId, s.id, {
      title: "Deposit (revised)", basis: "percent", percentBp: 2000, amountCents: null, extraLines: [], retentionBp: null, plannedDate: null, note: null,
    }, { expectedVersion: 1, actor });
    expect(edited).toMatchObject({ title: "Deposit (revised)", basis: "percent", percentBp: 2000, amountCents: null, version: 2 });

    await expect(
      store.updateStage(sql, tenantId, s.id, amountStage("Stale", 1_00), { expectedVersion: 1, actor })
    ).rejects.toMatchObject({ name: "StoreConflict", reason: "version" });
    expect((await store.getInvoice(sql, tenantId, s.id)).title).toBe("Deposit (revised)");
  });

  it("names why a guarded write matched nothing: gone, or no longer planned", async () => {
    const j = job("guard");
    await expect(
      store.updateStage(sql, tenantId, "00000000-0000-4000-8000-000000000000", amountStage("x", 1_00), { expectedVersion: 1, actor })
    ).rejects.toMatchObject({ reason: "not_found" });

    const s = await store.createStage(sql, tenantId, j, amountStage("Sent one", 5_000_00), actor);
    // Stand in for the send (#1150): the row leaves `planned`.
    await sql`update public.customer_invoices set state = 'failed' where id = ${s.id}`;
    await expect(
      store.updateStage(sql, tenantId, s.id, amountStage("x", 1_00), { expectedVersion: 1, actor })
    ).rejects.toMatchObject({ reason: "not_planned" });
    await expect(
      store.removeStage(sql, tenantId, s.id, { expectedVersion: 1, actor })
    ).rejects.toMatchObject({ reason: "not_planned" });
  });

  it("removes a planned stage outright and keeps a job-level record of it", async () => {
    const j = job("remove");
    const s = await store.createStage(sql, tenantId, j, amountStage("Mistake", 5_000_00), actor);
    await expect(store.removeStage(sql, tenantId, s.id, { expectedVersion: 9, actor })).rejects.toMatchObject({ reason: "version" });
    expect(await store.removeStage(sql, tenantId, s.id, { expectedVersion: 1, actor })).toEqual({ id: s.id, jobId: j });
    expect(await store.getInvoice(sql, tenantId, s.id)).toBeNull();
    const events = await store.listJobEvents(sql, tenantId, j);
    expect(events.map((e: { event: string }) => e.event)).toContain("removed");
    expect(events.find((e: { event: string }) => e.event === "removed").detail).toMatchObject({ title: "Mistake" });
  });

  it("saves a job profile once, then only with the current version", async () => {
    const j = job("profile");
    expect(await store.getProfile(sql, tenantId, j)).toBeNull();
    const first = await store.saveProfile(sql, tenantId, j, { retentionBp: 500 }, { expectedVersion: null, actor });
    expect(first).toMatchObject({ jobId: j, retentionBp: 500, version: 1, xeroContactId: null });

    await expect(store.saveProfile(sql, tenantId, j, { retentionBp: 1000 }, { expectedVersion: null, actor })).rejects.toMatchObject({ reason: "version" });
    await expect(store.saveProfile(sql, tenantId, j, { retentionBp: 1000 }, { expectedVersion: 7, actor })).rejects.toMatchObject({ reason: "version" });

    // A later patch touches only its own fields (the contact link lands in #1149).
    const linked = await store.saveProfile(sql, tenantId, j, { xeroContactId: "c-1", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1" }, { expectedVersion: 1, actor });
    expect(linked).toMatchObject({ retentionBp: 500, xeroContactId: "c-1", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", version: 2 });
    expect(await store.getProfile(sql, tenantId, j)).toMatchObject({ retentionBp: 500, xeroContactId: "c-1", version: 2 });
  });

  it("keeps cancelled rows out of the job's list", async () => {
    const j = job("cancelled");
    const s = await store.createStage(sql, tenantId, j, amountStage("Cancelled", 1_000_00), actor);
    await sql`update public.customer_invoices set state = 'cancelled' where id = ${s.id}`;
    expect(await store.listJobInvoices(sql, tenantId, j)).toEqual([]);
  });

  describe("what the schema itself refuses", () => {
    const insert = (j: string, cols: Record<string, unknown>) => {
      const base = { title: "T", basis: "amount", amount_cents: 100, percent_bp: null, seq: null, invoice_number: null, state: "planned", xero_invoice_id: null, external_tenant_id: null };
      const r = { ...base, ...cols };
      return sql`
        insert into public.customer_invoices
          (tenant_id, job_legacy_id, title, basis, amount_cents, percent_bp, seq, invoice_number, state, xero_invoice_id, external_tenant_id)
        values (${tenantId}, ${j}, ${r.title as string}, ${r.basis as string}, ${r.amount_cents as number | null}, ${r.percent_bp as number | null},
                ${r.seq as number | null}, ${r.invoice_number as string | null}, ${r.state as string}, ${r.xero_invoice_id as string | null}, ${r.external_tenant_id as string | null})
        returning id`;
    };

    it("a % stage with no percentage, or a dollar stage with no amount", async () => {
      await expect(insert(job("chk"), { basis: "percent", amount_cents: 100, percent_bp: null })).rejects.toThrow(/check/i);
      await expect(insert(job("chk"), { basis: "amount", amount_cents: null })).rejects.toThrow(/check/i);
    });

    it("a negative amount, a 0% or over-100% stage, an unknown state", async () => {
      await expect(insert(job("chk"), { amount_cents: -1 })).rejects.toThrow(/check/i);
      await expect(insert(job("chk"), { basis: "percent", amount_cents: null, percent_bp: 0 })).rejects.toThrow(/check/i);
      await expect(insert(job("chk"), { basis: "percent", amount_cents: null, percent_bp: 10001 })).rejects.toThrow(/check/i);
      await expect(insert(job("chk"), { state: "approved" })).rejects.toThrow(/check/i);
    });

    it("a sequence without a number (or a number without a sequence)", async () => {
      await expect(insert(job("chk"), { seq: 1, invoice_number: null })).rejects.toThrow(/check/i);
      await expect(insert(job("chk"), { seq: null, invoice_number: `${marker}-X` })).rejects.toThrow(/check/i);
    });

    it("a row marked sent that has no number or no Xero invoice id", async () => {
      await expect(insert(job("chk"), { state: "sent" })).rejects.toThrow(/check/i);
      await expect(insert(job("chk"), { state: "sent", seq: 1, invoice_number: `${marker}-S1` })).rejects.toThrow(/check/i);
    });

    it("the same stage number twice on one job, or the same invoice number twice anywhere", async () => {
      const j = job("uniq");
      await insert(j, { seq: 1, invoice_number: `${marker}-IV1-1`, state: "sending" });
      await expect(insert(j, { seq: 1, invoice_number: `${marker}-IV1-1b`, state: "sending" })).rejects.toThrow(/duplicate key/i);
      await expect(insert(job("uniq2"), { seq: 1, invoice_number: `${marker}-IV1-1`, state: "sending" })).rejects.toThrow(/duplicate key/i);
      // …while any number of planned stages (no number yet) is fine.
      await insert(j, {});
      await insert(j, {});
    });

    it("an attempt row being changed after the fact", async () => {
      const j = job("attempt");
      const inv = await insert(j, { seq: 1, invoice_number: `${marker}-A-1`, state: "sending" });
      const att = await sql`
        insert into public.customer_invoice_attempts (tenant_id, invoice_id, external_tenant_id, invoice_number, content_hash, outcome)
        values (${tenantId}, ${inv[0]!.id as string}, 'org-1', ${`${marker}-A-1`}, 'h', 'error')
        returning id`;
      await expect(
        sql`update public.customer_invoice_attempts set outcome = 'accepted' where id = ${att[0]!.id as string}`
      ).rejects.toThrow(/immutable/i);
    });

    it("an event can be written before its attempt exists (pending comes first)", async () => {
      const j = job("pending");
      const inv = await insert(j, { seq: 1, invoice_number: `${marker}-P-1`, state: "sending" });
      await store.insertEvent(sql, tenantId, {
        invoiceId: inv[0]!.id, jobId: j, attemptId: "11111111-1111-4111-8111-111111111111", event: "pending", actor, detail: {},
      });
      const events = await store.listJobEvents(sql, tenantId, j);
      expect(events.map((e: { event: string }) => e.event)).toEqual(["pending"]);
    });

    it("row-level security is on with no policies on every table", async () => {
      const tables = ["customer_invoice_settings", "customer_invoice_job_profiles", "customer_invoices", "customer_invoice_attempts", "customer_invoice_events", "customer_invoice_prefs", "customer_invoice_variations"];
      const rls = await sql`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname like 'customer_invoice%' and relkind = 'r'`;
      expect(rls.map((r) => r.relname).sort()).toEqual([...tables].sort());
      for (const r of rls) expect(r.relrowsecurity).toBe(true);
      const policies = await sql`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename like 'customer_invoice%'`;
      expect(policies[0]!.n).toBe(0);
    });
  });
});
