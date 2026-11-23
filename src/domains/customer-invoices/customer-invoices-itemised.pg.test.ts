import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Customer invoices, part 2 — the REAL store and migration
 * (20261125100000_customer_invoices_itemised_and_variations.sql) against a
 * real Postgres: itemised lines, the per-job lock that stops two invoices
 * claiming the same hours, the business's habits, the variations register and
 * the wording frozen at send.
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

describe.skipIf(!ENABLED)("customer invoices part 2 — real Postgres", () => {
  const store = requireFromHere("../../../api/_lib/customer-invoices/store.js");
  const billable = requireFromHere("../../../api/_lib/customer-invoices/billable.js");
  const postgres = requireFromHere("postgres");
  const marker = `it${Date.now().toString(36)}`;
  const job = (n: string) => `${marker}-${n}`;
  const actor = { id: "u_office", name: "Olive Office", role: "office" };
  const connect = (): Sql => postgres(process.env.SUPABASE_DB_URL as string, { max: 1, prepare: false, onnotice: () => {} });
  let sql: Sql;
  let tenantId: string;
  const extra: Sql[] = [];

  const line = (over: Record<string, unknown> = {}) => ({
    id: "it_a", type: "line", description: "Call-out fee", quantityMilli: 1000, unit: "ea", unitCents: 9500, source: "manual", costCents: null, refs: [], ...over,
  });
  const itemised = (title: string, items: unknown[], over: Record<string, unknown> = {}) => ({
    kind: "itemised", title, basis: "amount", amountCents: 9500, percentBp: null, extraLines: [], items, retentionBp: null, plannedDate: null, note: null, ...over,
  });
  const stage = (title: string, amountCents: number, over: Record<string, unknown> = {}) => ({
    kind: "stage", title, basis: "amount", amountCents, percentBp: null, extraLines: [], retentionBp: null, plannedDate: null, note: null, ...over,
  });

  beforeAll(async () => {
    sql = connect();
    const t = await store.resolveTenant(sql);
    expect(t).toBeTruthy();
    tenantId = t.id;
    // The habits are one row per tenant: start from none (throwaway database).
    await sql`delete from public.customer_invoice_prefs where tenant_id = ${tenantId}`;
    await sql`delete from public.customer_invoice_events where event = 'prefs_updated' and tenant_id = ${tenantId}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.customer_invoice_events where job_legacy_id like ${marker + "%"}`;
    await sql`delete from public.customer_invoice_events where event = 'prefs_updated' and tenant_id = ${tenantId}`;
    await sql`delete from public.customer_invoices where job_legacy_id like ${marker + "%"}`;
    await sql`delete from public.customer_invoice_variations where job_legacy_id like ${marker + "%"}`;
    await sql`delete from public.customer_invoice_job_profiles where job_legacy_id like ${marker + "%"}`;
    await sql`delete from public.customer_invoice_prefs where tenant_id = ${tenantId}`;
    await Promise.all(extra.map((c) => c.end({ timeout: 5 })));
    await sql.end({ timeout: 5 });
  });

  describe("itemised lines", () => {
    it("are stored and read back exactly, cost and refs included", async () => {
      const items = [
        { id: "n1", type: "note", description: "Rewired the shop front." },
        line(),
        line({ id: "it_b", description: "Labour", quantityMilli: 14350, unit: "hr", source: "labour", costCents: 68880, refs: [{ t: "h", u: "u_field", d: "2026-11-10", m: 14350 }] }),
        line({ id: "it_c", description: "Credit", unit: null, unitCents: -5000 }),
      ];
      const row = await store.createStage(sql, tenantId, job("lines"), itemised("Shop front rewire", items, { amountCents: 140825 }), actor);
      expect(row).toMatchObject({ kind: "itemised", state: "planned", amountCents: 140825, extraLines: [], sentFooter: null });
      expect(row.items).toEqual(items);
      expect((await store.getInvoice(sql, tenantId, row.id)).items).toEqual(items);
      const [raw] = await sql`select jsonb_typeof(items) as t, jsonb_array_length(items) as n from public.customer_invoices where id = ${row.id}`;
      expect(raw).toEqual({ t: "array", n: 4 });
    });

    it("an older stage row has no lines, and the three kinds are the only kinds", async () => {
      const row = await store.createStage(sql, tenantId, job("kinds"), stage("Deposit", 100), actor);
      expect(row.items).toEqual([]);
      await expect(
        sql`insert into public.customer_invoices (tenant_id, job_legacy_id, kind, title, basis, amount_cents) values (${tenantId}, ${job("kinds")}, 'quote', 'x', 'amount', 1)`
      ).rejects.toThrow(/customer_invoices_kind_check/);
    });

    it("an edit replaces the lines and keeps the kind; raising again copies them", async () => {
      const j = job("edit");
      const a = await store.createStage(sql, tenantId, j, itemised("First", [line()]), actor);
      const next = [line({ unitCents: 9900 }), line({ id: "it_z", description: "Travel", unitCents: 4000 })];
      const b = await store.updateStage(sql, tenantId, a.id, itemised("Second", next, { amountCents: 13900 }), { expectedVersion: a.version, actor });
      expect(b).toMatchObject({ kind: "itemised", title: "Second", amountCents: 13900, version: 2 });
      expect(b.items).toEqual(next);
      await sql`update public.customer_invoices set state = 'failed', seq = 1, invoice_number = ${`${marker}-1`} where id = ${a.id}`;
      const fresh = await store.raiseAgain(sql, tenantId, a.id, { actor });
      expect(fresh).toMatchObject({ kind: "itemised", state: "planned", seq: null });
      expect(fresh.items).toEqual(next);
    });

    it("wording added at send is frozen with the snapshot, and cleared if it goes back to planned", async () => {
      const a = await store.createStage(sql, tenantId, job("footer"), itemised("With wording", [line()]), actor);
      const footer = "This is a payment claim made under the Act.\nContract sum: $90,000.00.";
      const sending = await store.beginSend(sql, tenantId, a.id, {
        jobCode: "IV9990", grossCents: 9500, retentionBp: 0, retentionCents: 0, netCents: 9500, invoiceDate: "2026-11-22", dueDate: "2026-12-06",
        reference: "ref", footer, externalTenantId: "org-1", xeroContactId: "c1", xeroContactName: "Built", build: () => "hash",
      }, { expectedVersion: a.version, actor });
      expect(sending).toMatchObject({ state: "sending", sentFooter: footer });
      const back = await store.resetToPlanned(sql, tenantId, a.id, { actor });
      expect(back).toMatchObject({ state: "planned", sentFooter: null, invoiceNumber: null });
      // no wording → null, not an empty string
      const again = await store.beginSend(sql, tenantId, a.id, {
        jobCode: "IV9990", grossCents: 9500, retentionBp: 0, retentionCents: 0, netCents: 9500, invoiceDate: "2026-11-22", dueDate: "2026-12-06",
        reference: "ref", externalTenantId: "org-1", xeroContactId: "c1", xeroContactName: "Built", build: () => "hash",
      }, { expectedVersion: back.version, actor });
      expect(again.sentFooter).toBeNull();
    });
  });

  describe("nothing billed twice — the per-job lock", () => {
    // The same check the handler runs: read the job's invoices INSIDE the
    // transaction, under the lock, and refuse a line another invoice holds.
    const SOURCES = {
      labour: { available: true, reason: null, pendingMilli: 0, days: [{ userId: "u1", name: "Sam", date: "2026-11-10", milli: 4500, costRateCents: 4800, chargeOutRateCents: 9500 }] },
      supplier: { available: true, reason: null, lines: [], whole: [] },
      ledger: { available: true, reason: null, lines: [] },
    };
    const claim = (db: Sql, j: string, title: string) => {
      const items = [line({ description: "Labour", quantityMilli: 4500, unit: "hr", refs: [{ t: "h", u: "u1", d: "2026-11-10", m: 4500 }] })];
      return store.createStage(db, tenantId, j, null, actor, {
        prepare: async (tx: Sql) => {
          const rows = await store.listJobInvoices(tx, tenantId, j);
          return itemised(title, billable.resolveItems({ items, sources: SOURCES, rows, variations: [] }), { amountCents: 42750 });
        },
      });
    };

    it("eight requests for the same hours at the same instant: exactly one invoice gets them", async () => {
      const j = job("race");
      const conns = Array.from({ length: 8 }, () => connect());
      extra.push(...conns);
      const results = await Promise.allSettled(conns.map((c, i) => claim(c, j, `Race ${i}`)));
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(7);
      expect(lost.every((r) => r.reason instanceof billable.BillableError && r.reason.code === "already_billed")).toBe(true);
      const rows = await store.listJobInvoices(sql, tenantId, j);
      expect(rows).toHaveLength(1);
      expect(rows[0].items[0]).toMatchObject({ source: "labour", costCents: 21600 });
    });

    it("a refused save leaves nothing behind — the transaction is rolled back", async () => {
      const j = job("rollback");
      await claim(sql, j, "First");
      const before = await sql`select count(*)::int as n from public.customer_invoice_events where job_legacy_id = ${j}`;
      await expect(claim(sql, j, "Second")).rejects.toMatchObject({ code: "already_billed" });
      const after = await sql`select count(*)::int as n from public.customer_invoice_events where job_legacy_id = ${j}`;
      expect(after[0]!.n).toBe(before[0]!.n);
      expect(await store.listJobInvoices(sql, tenantId, j)).toHaveLength(1);
    });

    it("two different jobs don't wait on each other", async () => {
      const [a, b] = await Promise.all([claim(sql, job("apart-1"), "A"), claim(connectExtra(), job("apart-2"), "B")]);
      expect([a.state, b.state]).toEqual(["planned", "planned"]);
    });

    it("an edit is checked under the same lock, and may keep what the invoice already holds", async () => {
      const j = job("edit-lock");
      const a = await claim(sql, j, "Holds the hours");
      const items = [line({ description: "Labour", quantityMilli: 4500, unit: "hr", unitCents: 9900, refs: [{ t: "h", u: "u1", d: "2026-11-10", m: 4500 }] })];
      const b = await store.updateStage(sql, tenantId, a.id, null, {
        expectedVersion: a.version, actor, jobId: j,
        prepare: async (tx: Sql) => {
          const rows = await store.listJobInvoices(tx, tenantId, j);
          return itemised("Repriced", billable.resolveItems({ items, sources: SOURCES, rows, variations: [], excludeInvoiceId: a.id }), { amountCents: 44550 });
        },
      });
      expect(b).toMatchObject({ title: "Repriced", amountCents: 44550, version: 2 });
    });
  });

  function connectExtra(): Sql {
    const c = connect();
    extra.push(c);
    return c;
  }

  describe("the job's payment-claim switch", () => {
    it("is off until turned on, and turning it on disturbs nothing else", async () => {
      const j = job("claim");
      expect(await store.getProfile(sql, tenantId, j)).toBeNull();
      const a = await store.saveProfile(sql, tenantId, j, { retentionBp: 500, xeroContactId: "c1", xeroContactName: "Built", externalTenantId: "org-1" }, { expectedVersion: null, actor });
      expect(a.paymentClaim).toBe(false);
      const b = await store.saveProfile(sql, tenantId, j, { paymentClaim: true }, { expectedVersion: a.version, actor });
      expect(b).toMatchObject({ paymentClaim: true, retentionBp: 500, xeroContactId: "c1", version: 2 });
      const c = await store.saveProfile(sql, tenantId, j, { retentionBp: 250 }, { expectedVersion: b.version, actor });
      expect(c).toMatchObject({ paymentClaim: true, retentionBp: 250 });
      // a first save can turn it on too
      const d = await store.saveProfile(sql, tenantId, job("claim-2"), { paymentClaim: true }, { expectedVersion: null, actor });
      expect(d).toMatchObject({ paymentClaim: true, retentionBp: 0, xeroContactId: null });
    });
  });

  describe("the business's habits", () => {
    const usual = [{ id: "c1", name: "Call-out fee", unit: "ea", unitCents: 9500, kind: "other" }, { id: "c2", name: "Tradesman", unit: "hr", unitCents: 11000, kind: "labour" }];

    it("start empty, are saved by compare-and-swap, and read back exactly", async () => {
      expect(await store.getPrefs(sql, tenantId)).toBeNull();
      const a = await store.savePrefs(sql, tenantId, { materialsMarkupBp: 2500, labourRoundMinutes: 15, usualCharges: usual }, { expectedVersion: null, actor });
      expect(a).toMatchObject({ materialsMarkupBp: 2500, labourRoundMinutes: 15, usualCharges: usual, version: 1, updatedBy: "Olive Office" });
      await expect(store.savePrefs(sql, tenantId, { materialsMarkupBp: 1, labourRoundMinutes: 0, usualCharges: [] }, { expectedVersion: null, actor })).rejects.toMatchObject({ reason: "version" });
      const b = await store.savePrefs(sql, tenantId, { materialsMarkupBp: null, labourRoundMinutes: 0, usualCharges: [] }, { expectedVersion: 1, actor });
      expect(b).toMatchObject({ materialsMarkupBp: null, labourRoundMinutes: 0, usualCharges: [], version: 2 });
      await expect(store.savePrefs(sql, tenantId, { materialsMarkupBp: 1, labourRoundMinutes: 0, usualCharges: [] }, { expectedVersion: 1, actor })).rejects.toMatchObject({ reason: "version" });
    });

    it("the database refuses a rounding step that isn't offered, and a markup past 1,000%", async () => {
      await expect(sql`update public.customer_invoice_prefs set labour_round_minutes = 10 where tenant_id = ${tenantId}`).rejects.toThrow(/check/);
      await expect(sql`update public.customer_invoice_prefs set materials_markup_bp = 100001 where tenant_id = ${tenantId}`).rejects.toThrow(/check/);
    });
  });

  describe("variations", () => {
    it("take the job's next number, start proposed, and read back as written", async () => {
      const j = job("var");
      const a = await store.createVariation(sql, tenantId, j, { title: "Four extra power points", detail: "Kitchen", requestedBy: "Site manager", requestedOn: "2026-11-18", quotedCents: 120000 }, actor);
      const b = await store.createVariation(sql, tenantId, j, { title: "Relocate the board" }, actor);
      expect(a).toMatchObject({ seq: 1, status: "proposed", quotedCents: 120000, approvedCents: null, requestedOn: "2026-11-18", detail: "Kitchen", version: 1, createdBy: "Olive Office" });
      expect(b).toMatchObject({ seq: 2, quotedCents: null, requestedBy: null });
      expect((await store.listVariations(sql, tenantId, j)).map((v: { seq: number }) => v.seq)).toEqual([1, 2]);
      expect((await store.createVariation(sql, tenantId, job("var-other"), { title: "Elsewhere" }, actor)).seq).toBe(1);
    });

    it("six added at the same instant get six different numbers", async () => {
      const j = job("var-race");
      const conns = Array.from({ length: 6 }, () => connectExtra());
      const made = await Promise.all(conns.map((c, i) => store.createVariation(c, tenantId, j, { title: `V ${i}` }, actor)));
      expect(made.map((v: { seq: number }) => v.seq).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("are approved with an amount, declined, or put back — by compare-and-swap", async () => {
      const j = job("var-decide");
      const v = await store.createVariation(sql, tenantId, j, { title: "Extra", quotedCents: 120000 }, actor);
      const ok = await store.decideVariation(sql, tenantId, v.id, { status: "approved", approvedCents: 110000, approvalRef: "Email 20 Nov", decidedOn: "2026-11-20" }, { expectedVersion: 1, actor });
      expect(ok).toMatchObject({ status: "approved", approvedCents: 110000, quotedCents: 120000, approvalRef: "Email 20 Nov", decidedOn: "2026-11-20", decidedBy: "Olive Office", version: 2 });
      await expect(store.decideVariation(sql, tenantId, v.id, { status: "declined" }, { expectedVersion: 1, actor })).rejects.toMatchObject({ reason: "version" });
      const back = await store.decideVariation(sql, tenantId, v.id, { status: "proposed" }, { expectedVersion: 2, actor });
      expect(back).toMatchObject({ status: "proposed", approvedCents: null, approvalRef: null, decidedOn: null, decidedBy: null });
      const no = await store.decideVariation(sql, tenantId, v.id, { status: "declined", decidedOn: "2026-11-21" }, { expectedVersion: 3, actor });
      expect(no).toMatchObject({ status: "declined", approvedCents: null, decidedOn: "2026-11-21" });
    });

    it("the database won't hold an approved variation with no approved amount", async () => {
      const v = await store.createVariation(sql, tenantId, job("var-check"), { title: "Extra" }, actor);
      await expect(sql`update public.customer_invoice_variations set status = 'approved' where id = ${v.id}`).rejects.toThrow(/check/);
      await expect(sql`update public.customer_invoice_variations set status = 'maybe' where id = ${v.id}`).rejects.toThrow(/check/);
    });

    it("a removed variation leaves the list but its number is never handed out again", async () => {
      const j = job("var-remove");
      const a = await store.createVariation(sql, tenantId, j, { title: "One" }, actor);
      const b = await store.createVariation(sql, tenantId, j, { title: "Two" }, actor);
      await store.removeVariation(sql, tenantId, b.id, { expectedVersion: 1, actor });
      expect(await store.getVariation(sql, tenantId, b.id)).toBeNull();
      expect((await store.listVariations(sql, tenantId, j)).map((v: { seq: number }) => v.seq)).toEqual([1]);
      expect((await store.createVariation(sql, tenantId, j, { title: "Three" }, actor)).seq).toBe(3);
      await expect(store.removeVariation(sql, tenantId, b.id, { expectedVersion: 2, actor })).rejects.toMatchObject({ reason: "not_found" });
      await expect(store.updateVariation(sql, tenantId, a.id, { title: "Stale" }, { expectedVersion: 9, actor })).rejects.toMatchObject({ reason: "version" });
    });

    it("a guard that refuses stops the change — nothing is written", async () => {
      const j = job("var-guard");
      const v = await store.createVariation(sql, tenantId, j, { title: "Billed already", quotedCents: 100 }, actor);
      const refuse = async () => { throw new billable.BillableError("variation_billed", { on: "IV1-1" }); };
      await expect(store.decideVariation(sql, tenantId, v.id, { status: "declined" }, { expectedVersion: 1, actor, guard: refuse, jobId: j })).rejects.toMatchObject({ code: "variation_billed" });
      await expect(store.removeVariation(sql, tenantId, v.id, { expectedVersion: 1, actor, guard: refuse, jobId: j })).rejects.toMatchObject({ code: "variation_billed" });
      expect(await store.getVariation(sql, tenantId, v.id)).toMatchObject({ status: "proposed", version: 1 });
    });

    it("goes onto a planned stage as an extra line that remembers which variation it bills", async () => {
      const j = job("var-line");
      const s = await store.createStage(sql, tenantId, j, stage("Rough-in", 2700000, { extraLines: [{ description: "Existing", amountCents: 500 }] }), actor);
      const v = await store.createVariation(sql, tenantId, j, { title: "Extra", quotedCents: 110000 }, actor);
      const out = await store.appendExtraLine(sql, tenantId, s.id, { description: "Variation V1 — Extra", amountCents: 110000, variationId: v.id }, { expectedVersion: 1, actor });
      expect(out.extraLines).toEqual([{ description: "Existing", amountCents: 500 }, { description: "Variation V1 — Extra", amountCents: 110000, variationId: v.id }]);
      expect(out.version).toBe(2);
      expect([...billable.variationBilling(await store.listJobInvoices(sql, tenantId, j))]).toEqual([[v.id, "Rough-in"]]);
      await expect(store.appendExtraLine(sql, tenantId, s.id, { description: "Stale", amountCents: 1 }, { expectedVersion: 1, actor })).rejects.toMatchObject({ reason: "version" });
      await sql`update public.customer_invoices set state = 'sending', seq = 1, invoice_number = ${`${marker}-L1`} where id = ${s.id}`;
      await expect(store.appendExtraLine(sql, tenantId, s.id, { description: "Late", amountCents: 1 }, { expectedVersion: 2, actor })).rejects.toMatchObject({ reason: "not_planned" });
    });
  });

  describe("history", () => {
    it("records each step, and the events table takes the new kinds", async () => {
      const j = job("var-decide");
      const kinds = (await sql`select event from public.customer_invoice_events where job_legacy_id = ${j} order by created_at`).map((r) => r.event);
      expect(kinds).toEqual(["variation_added", "variation_approved", "variation_reopened", "variation_declined"]);
      const prefs = await sql`select count(*)::int as n from public.customer_invoice_events where event = 'prefs_updated' and tenant_id = ${tenantId}`;
      expect(prefs[0]!.n).toBe(2);
      await expect(
        sql`insert into public.customer_invoice_events (tenant_id, job_legacy_id, event) values (${tenantId}, ${j}, 'made_up')`
      ).rejects.toThrow(/customer_invoice_events_event_check/);
    });
  });

  describe("row-level security", () => {
    it("is on, with no policies, on both new tables", async () => {
      const rows = await sql`
        select c.relname, c.relrowsecurity as rls,
               (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('customer_invoice_prefs', 'customer_invoice_variations')
        order by 1`;
      expect(rows).toEqual([
        { relname: "customer_invoice_prefs", rls: true, policies: 0 },
        { relname: "customer_invoice_variations", rls: true, policies: 0 },
      ]);
    });
  });
});
