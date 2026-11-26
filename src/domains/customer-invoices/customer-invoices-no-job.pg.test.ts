import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * An invoice with NO job (#1166) — the REAL store and migration
 * (20261126100000_customer_invoices_no_job.sql) against a real Postgres: the
 * client chosen on the invoice, the rules the schema enforces, and the no-job
 * series handing out each number once however many are sent at the same time.
 *
 * Runs only with CUSTOMER_INVOICES_PG_TEST=1 and SUPABASE_ENV=local (a
 * throwaway local database — docs/customer-invoices.md "Testing"). Skipped in CI.
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

describe.skipIf(!ENABLED)("an invoice with no job — real Postgres", () => {
  const store = requireFromHere("../../../api/_lib/customer-invoices/store.js");
  const noJob = requireFromHere("../../../api/_lib/customer-invoices/no-job.js");
  const postgres = requireFromHere("postgres");
  const LEDGER: string = noJob.NO_JOB_ID;
  const marker = `nj${Date.now().toString(36)}`;
  const actor = { id: "u_office", name: "Olive Office", role: "office" };
  const connect = (): Sql => postgres(process.env.SUPABASE_DB_URL as string, { max: 1, prepare: false, onnotice: () => {} });
  let sql: Sql;
  let tenantId: string;
  const extra: Sql[] = [];
  const CLIENT = { id: "11111111-1111-4111-8111-111111111111", name: "Built Pty Ltd", externalTenantId: "org-1" };

  const line = (over: Record<string, unknown> = {}) => ({
    id: "it_a", type: "line", description: "Progress claim 4", quantityMilli: 1000, unit: "ea", unitCents: 1250000, source: "manual", costCents: null, refs: [], ...over,
  });
  // Every row this file makes carries the marker in its title, so the
  // clean-up never touches another test's rows in the shared ledger.
  const invoice = (title: string, over: Record<string, unknown> = {}) => ({
    kind: "itemised", title: `${marker} ${title}`, basis: "amount", amountCents: 1250000, percentBp: null, extraLines: [],
    items: [line()], retentionBp: null, plannedDate: null, note: null, client: CLIENT, ...over,
  });
  const snap = (over: Record<string, unknown> = {}) => ({
    jobCode: null, numberFor: noJob.numberFor, grossCents: 1250000, retentionBp: 0, retentionCents: 0, netCents: 1250000,
    invoiceDate: "2026-11-25", dueDate: "2026-12-25", reference: "ref", footer: null,
    externalTenantId: "org-1", xeroContactId: CLIENT.id, xeroContactName: CLIENT.name,
    build: (n: string) => `hash-${n}`, ...over,
  });
  const mine = () => sql`select * from public.customer_invoices where tenant_id = ${tenantId} and title like ${marker + "%"} order by created_at`;

  async function wipe() {
    await sql`delete from public.customer_invoice_events where invoice_id in (select id from public.customer_invoices where title like ${marker + "%"})`;
    await sql`delete from public.customer_invoice_attempts where invoice_id in (select id from public.customer_invoices where title like ${marker + "%"})`;
    await sql`delete from public.customer_invoices where title like ${marker + "%"}`;
  }

  beforeAll(async () => {
    sql = connect();
    const t = await store.resolveTenant(sql);
    expect(t).toBeTruthy();
    tenantId = t.id;
  });

  afterAll(async () => {
    if (!sql) return;
    await wipe();
    await Promise.all(extra.map((c) => c.end({ timeout: 5 })));
    await sql.end({ timeout: 5 });
  });

  describe("the client chosen on the invoice", () => {
    it("is stored with the invoice and read back, in the ledger and nowhere else", async () => {
      const row = await store.createStage(sql, tenantId, LEDGER, invoice("stored"), actor);
      expect(row).toMatchObject({
        jobId: LEDGER, kind: "itemised", state: "planned",
        clientContactId: CLIENT.id, clientContactName: CLIENT.name, clientExternalTenantId: "org-1",
      });
      const listed = await store.listJobInvoices(sql, tenantId, LEDGER);
      expect(listed.some((r: { id: string }) => r.id === row.id)).toBe(true);
      const read = await store.getInvoice(sql, tenantId, row.id);
      expect(read.clientContactName).toBe("Built Pty Ltd");
    });

    it("can be left out, changed and cleared by an edit", async () => {
      const row = await store.createStage(sql, tenantId, LEDGER, invoice("no client", { client: null }), actor);
      expect(row).toMatchObject({ clientContactId: null, clientContactName: null, clientExternalTenantId: null });
      const withClient = await store.updateStage(sql, tenantId, row.id, invoice("no client"), { expectedVersion: 1, actor });
      expect(withClient).toMatchObject({ clientContactId: CLIENT.id, version: 2 });
      const cleared = await store.updateStage(sql, tenantId, row.id, invoice("no client", { client: null }), { expectedVersion: 2, actor });
      expect(cleared).toMatchObject({ clientContactId: null, clientContactName: null, clientExternalTenantId: null, version: 3 });
    });

    it("a half-filled client is stored as none (all three fields or nothing)", async () => {
      const row = await store.createStage(sql, tenantId, LEDGER, invoice("half", { client: { id: CLIENT.id, name: "", externalTenantId: "org-1" } }), actor);
      expect(row).toMatchObject({ clientContactId: null, clientContactName: null, clientExternalTenantId: null });
    });

    it("a job's invoice never carries one: the store writes none without it", async () => {
      const jobId = `${marker}-job`;
      const row = await store.createStage(sql, tenantId, jobId, { ...invoice("on a job"), client: undefined }, actor);
      expect(row).toMatchObject({ jobId, clientContactId: null });
      await sql`delete from public.customer_invoice_events where job_legacy_id = ${jobId}`;
    });
  });

  describe("what the schema itself refuses", () => {
    const refuses = async (q: Promise<unknown>, constraint: string) => {
      await expect(q).rejects.toMatchObject({ code: "23514", constraint_name: constraint });
    };

    it("a client on a job's invoice", async () => {
      await refuses(
        sql`insert into public.customer_invoices (tenant_id, job_legacy_id, kind, title, basis, amount_cents, client_contact_id, client_contact_name, client_external_tenant_id)
            values (${tenantId}, ${marker + "-real-job"}, 'itemised', ${marker + " x"}, 'amount', 100, 'c', 'n', 'o')`,
        "customer_invoices_client_scope_check"
      );
    });

    it("a client with a field missing", async () => {
      await refuses(
        sql`insert into public.customer_invoices (tenant_id, job_legacy_id, kind, title, basis, amount_cents, client_contact_id)
            values (${tenantId}, ${LEDGER}, 'itemised', ${marker + " x"}, 'amount', 100, 'c')`,
        "customer_invoices_client_whole_check"
      );
    });

    it("anything but an itemised invoice in the ledger", async () => {
      for (const kind of ["stage", "retention_release"]) {
        await refuses(
          sql`insert into public.customer_invoices (tenant_id, job_legacy_id, kind, title, basis, amount_cents)
              values (${tenantId}, ${LEDGER}, ${kind}, ${marker + " x"}, 'amount', 100)`,
          "customer_invoices_no_job_kind_check"
        );
      }
    });

    it("leaves every existing kind of job invoice alone", async () => {
      const jobId = `${marker}-kinds`;
      for (const kind of ["stage", "retention_release", "itemised"]) {
        await sql`insert into public.customer_invoices (tenant_id, job_legacy_id, kind, title, basis, amount_cents)
                  values (${tenantId}, ${jobId}, ${kind}, ${marker + " " + kind}, 'amount', 100)`;
      }
      const n = await sql`select count(*)::int as n from public.customer_invoices where job_legacy_id = ${jobId}`;
      expect(n[0]!.n).toBe(3);
    });
  });

  describe("the no-job series", () => {
    it("numbers from the ledger's own sequence and freezes the client it was sent to", async () => {
      const before = await store.peekNextSeq(sql, tenantId, LEDGER);
      const row = await store.createStage(sql, tenantId, LEDGER, invoice("numbered"), actor);
      const sent = await store.beginSend(sql, tenantId, row.id, snap(), { expectedVersion: 1, actor });
      expect(sent).toMatchObject({
        state: "sending", seq: before, invoiceNumber: noJob.numberFor(before),
        xeroContactId: CLIENT.id, xeroContactName: CLIENT.name, externalTenantId: "org-1",
        clientContactId: CLIENT.id, contentHash: `hash-${noJob.numberFor(before)}`,
      });
      expect(sent.invoiceNumber).toMatch(/^GEN-\d{4,}$/);
    });

    it("a job's invoice is still numbered from the job number", async () => {
      const jobId = `${marker}-numbered-job`;
      const row = await store.createStage(sql, tenantId, jobId, { ...invoice("job numbered"), client: undefined }, actor);
      const sent = await store.beginSend(sql, tenantId, row.id, snap({ jobCode: "IV7001", numberFor: null }), { expectedVersion: 1, actor });
      expect(sent).toMatchObject({ seq: 1, invoiceNumber: "IV7001-1" });
      await sql`delete from public.customer_invoice_events where job_legacy_id = ${jobId}`;
      await sql`delete from public.customer_invoices where job_legacy_id = ${jobId}`;
    });

    it("eight sent at the same instant, each on its own connection, get eight different numbers", async () => {
      const rows = [];
      for (let i = 0; i < 8; i += 1) rows.push(await store.createStage(sql, tenantId, LEDGER, invoice(`race ${i}`), actor));
      const conns = rows.map(() => connect());
      extra.push(...conns);
      const sent = await Promise.all(rows.map((r, i) => store.beginSend(conns[i], tenantId, r.id, snap(), { expectedVersion: 1, actor })));
      const numbers = sent.map((s: { invoiceNumber: string }) => s.invoiceNumber);
      expect(new Set(numbers).size).toBe(8);
      const seqs = sent.map((s: { seq: number }) => s.seq).sort((a: number, b: number) => a - b);
      // consecutive: none skipped, none repeated
      expect(seqs).toEqual(seqs.map((_: number, i: number) => seqs[0]! + i));
    });

    it("putting one back to planned keeps its lines and its client", async () => {
      const row = await store.createStage(sql, tenantId, LEDGER, invoice("reset"), actor);
      await store.beginSend(sql, tenantId, row.id, snap(), { expectedVersion: 1, actor });
      await store.markFailed(sql, tenantId, row.id, { category: "validation", detail: "no" });
      const back = await store.resetToPlanned(sql, tenantId, row.id, { actor });
      expect(back).toMatchObject({
        state: "planned", seq: null, invoiceNumber: null, xeroContactId: null,
        clientContactId: CLIENT.id, clientContactName: CLIENT.name, clientExternalTenantId: "org-1",
      });
      expect(back.items).toHaveLength(1);
    });

    it("raising one again copies its client onto the new invoice", async () => {
      const row = await store.createStage(sql, tenantId, LEDGER, invoice("raise"), actor);
      await store.beginSend(sql, tenantId, row.id, snap(), { expectedVersion: 1, actor });
      await store.markFailed(sql, tenantId, row.id, { category: "number_taken", detail: "taken" });
      const fresh = await store.raiseAgain(sql, tenantId, row.id, { actor });
      expect(fresh).toMatchObject({ jobId: LEDGER, state: "planned", clientContactId: CLIENT.id, clientContactName: CLIENT.name });
      const all = await mine();
      expect(all.filter((r) => r.id === row.id)[0]).toMatchObject({ state: "cancelled" });
    });
  });
});
