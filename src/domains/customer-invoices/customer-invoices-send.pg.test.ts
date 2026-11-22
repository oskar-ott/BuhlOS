import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Customer stage invoices — the SEND's SQL (#1150) against a real Postgres:
 * claiming a stage (number allocation under concurrency), the guarded state
 * changes, the immutable attempts, reset and raise-again. Same gate as the
 * other .pg tests: CUSTOMER_INVOICES_PG_TEST=1 and SUPABASE_ENV=local, a
 * throwaway local database. Skipped in CI.
 *
 * Concurrency is real: each "request" gets its OWN connection (max: 1, the
 * production pool shape), the way separate serverless instances would.
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

describe.skipIf(!ENABLED)("customer invoices send — real Postgres", () => {
  const store = requireFromHere("../../../api/_lib/customer-invoices/store.js");
  const postgres = requireFromHere("postgres");
  const marker = `cs${Date.now().toString(36)}`;
  const job = (n: string) => `${marker}-${n}`;
  const code = (n: number) => `${marker.toUpperCase()}${n}`;
  const actor = { id: "u_office", name: "Olive Office", role: "office" };
  const pools: Sql[] = [];
  let sql: Sql;
  let tenantId: string;

  const connect = (): Sql => {
    const c = postgres(process.env.SUPABASE_DB_URL as string, { max: 1, prepare: false, onnotice: () => {} });
    pools.push(c);
    return c;
  };
  const add = (j: string, title = "Stage", amountCents = 10_000_00) =>
    store.createStage(sql, tenantId, j, { kind: "stage", title, basis: "amount", amountCents, percentBp: null, extraLines: [], retentionBp: null, plannedDate: null, note: null }, actor);
  const snap = (jobCode: string, over: Record<string, unknown> = {}) => ({
    jobCode, grossCents: 10_000_00, retentionBp: 500, retentionCents: 500_00, netCents: 9_500_00,
    invoiceDate: "2026-11-22", dueDate: "2026-12-22", reference: "REF", externalTenantId: "org-1",
    xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", build: (n: string) => `hash-of-${n}`, ...over,
  });
  const mirror = (over: Record<string, unknown> = {}) => ({
    status: "DRAFT", subtotalCents: 9_500_00, taxCents: 950_00, totalCents: 10_450_00, amountDueCents: 10_450_00,
    amountPaidCents: 0, amountCreditedCents: 0, dueDate: "2026-12-22", fullyPaidOn: null, updatedAt: "2026-11-22T01:02:03.000Z", ...over,
  });

  beforeAll(async () => {
    sql = connect();
    tenantId = (await store.resolveTenant(sql)).id;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from public.customer_invoice_events where job_legacy_id like ${marker + "%"}`;
      // attempts go with their invoice (on delete cascade)
      await sql`delete from public.customer_invoices where job_legacy_id like ${marker + "%"}`;
    }
    await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
  });

  it("claiming a stage allocates the next number, freezes the snapshot and moves it to sending", async () => {
    const j = job("claim");
    const s = await add(j);
    expect(await store.peekNextSeq(sql, tenantId, j)).toBe(1);
    const row = await store.beginSend(sql, tenantId, s.id, snap(code(1)), { expectedVersion: 1, actor });
    expect(row).toMatchObject({
      state: "sending", seq: 1, invoiceNumber: `${code(1)}-1`, contentHash: `hash-of-${code(1)}-1`,
      grossCents: 10_000_00, retentionBp: 500, retentionCents: 500_00, netCents: 9_500_00,
      invoiceDate: "2026-11-22", dueDate: "2026-12-22", reference: "REF", externalTenantId: "org-1",
      xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", sentBy: "Olive Office", version: 2, xeroInvoiceId: null,
    });
    expect(await store.peekNextSeq(sql, tenantId, j)).toBe(2);
  });

  it("a second claim of the same stage is refused, as is a stale version or a missing stage", async () => {
    const j = job("guard");
    const s = await add(j);
    await expect(store.beginSend(sql, tenantId, s.id, snap(code(2)), { expectedVersion: 9, actor })).rejects.toMatchObject({ reason: "version" });
    await store.beginSend(sql, tenantId, s.id, snap(code(2)), { expectedVersion: 1, actor });
    await expect(store.beginSend(sql, tenantId, s.id, snap(code(2)), { expectedVersion: 2, actor })).rejects.toMatchObject({ reason: "not_planned" });
    await expect(store.beginSend(sql, tenantId, "00000000-0000-4000-8000-000000000000", snap(code(2)), { expectedVersion: 1, actor })).rejects.toMatchObject({ reason: "not_found" });
  });

  it("TWO REQUESTS claiming the same stage at the same instant: exactly one wins", async () => {
    const j = job("race-same");
    const s = await add(j);
    const a = connect();
    const b = connect();
    const results = await Promise.allSettled([
      store.beginSend(a, tenantId, s.id, snap(code(3)), { expectedVersion: 1, actor }),
      store.beginSend(b, tenantId, s.id, snap(code(3)), { expectedVersion: 1, actor }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["not_planned", "version"]).toContain(lost.reason.reason);
    const rows = await sql`select count(*)::int as n from public.customer_invoices where job_legacy_id = ${j} and seq is not null`;
    expect(rows[0]!.n).toBe(1);
  });

  it("SIX DIFFERENT stages of one job claimed at the same instant get six different consecutive numbers", async () => {
    const j = job("race-many");
    const stages = [];
    for (let i = 0; i < 6; i++) stages.push(await add(j, `Stage ${i}`));
    const out = await Promise.all(
      stages.map((s) => store.beginSend(connect(), tenantId, s.id, snap(code(4)), { expectedVersion: 1, actor }))
    );
    const seqs = out.map((r: { seq: number }) => r.seq).sort((x: number, y: number) => x - y);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(out.map((r: { invoiceNumber: string }) => r.invoiceNumber)).size).toBe(6);
  });

  it("an invoice number already used anywhere in the tenant is refused as a clash, and nothing is claimed", async () => {
    const j1 = job("clash-1");
    const j2 = job("clash-2");
    const a = await add(j1);
    const b = await add(j2);
    await store.beginSend(sql, tenantId, a.id, snap(code(5)), { expectedVersion: 1, actor });
    // a different job that (wrongly) carries the same job code would collide on <code>-1
    await expect(store.beginSend(sql, tenantId, b.id, snap(code(5)), { expectedVersion: 1, actor })).rejects.toMatchObject({ name: "StoreConflict", reason: "number_clash" });
    expect(await store.getInvoice(sql, tenantId, b.id)).toMatchObject({ state: "planned", seq: null, version: 1 });
  });

  it("accepting stores Xero's id and figures and moves sending → sent; it can't be accepted twice", async () => {
    const j = job("accept");
    const s = await add(j);
    await store.beginSend(sql, tenantId, s.id, snap(code(6)), { expectedVersion: 1, actor });
    const sent = await store.markAccepted(sql, tenantId, s.id, { xeroInvoiceId: `${marker}-x1`, mirror: mirror(), drift: null });
    expect(sent).toMatchObject({
      state: "sent", xeroInvoiceId: `${marker}-x1`, xeroStatus: "DRAFT", xeroSubtotalCents: 9_500_00, xeroTaxCents: 950_00,
      xeroTotalCents: 10_450_00, xeroAmountDueCents: 10_450_00, xeroAmountPaidCents: 0, xeroDueDate: "2026-12-22",
      xeroUpdatedAt: "2026-11-22T01:02:03.000Z", drift: null, failureCategory: null,
    });
    expect(typeof sent.xeroSubtotalCents).toBe("number");
    expect(sent.sentAt).toBeTruthy();
    expect(sent.lastCheckedAt).toBeTruthy();
    expect(await store.markAccepted(sql, tenantId, s.id, { xeroInvoiceId: `${marker}-x2`, mirror: mirror(), drift: null })).toBeNull();
    expect((await store.getInvoice(sql, tenantId, s.id)).xeroInvoiceId).toBe(`${marker}-x1`);
  });

  it("a planned stage can't be marked accepted, failed or unknown — only a claimed one can", async () => {
    const j = job("unclaimed");
    const s = await add(j);
    expect(await store.markAccepted(sql, tenantId, s.id, { xeroInvoiceId: `${marker}-nope`, mirror: mirror(), drift: null })).toBeNull();
    expect(await store.markFailed(sql, tenantId, s.id, { category: "validation", detail: "x" })).toBeNull();
    expect(await store.noteUnknown(sql, tenantId, s.id, { category: "timeout", detail: null })).toBeNull();
    expect(await store.getInvoice(sql, tenantId, s.id)).toMatchObject({ state: "planned", version: 1 });
  });

  it("records the drift when what Xero holds differs, and Xero's figure is what is stored", async () => {
    const j = job("drift");
    const s = await add(j);
    await store.beginSend(sql, tenantId, s.id, snap(code(7)), { expectedVersion: 1, actor });
    const sent = await store.markAccepted(sql, tenantId, s.id, {
      xeroInvoiceId: `${marker}-x7`, mirror: mirror({ subtotalCents: 9_499_00 }), drift: { mismatches: ["subtotal"], at: "2026-11-22T00:00:00.000Z" },
    });
    expect(sent.xeroSubtotalCents).toBe(9_499_00);
    expect(sent.drift).toMatchObject({ mismatches: ["subtotal"] });
  });

  it("unknown keeps the stage `sending` with the reason; a later look-up can still accept it — also from `failed`", async () => {
    const j = job("unknown");
    const s = await add(j);
    await store.beginSend(sql, tenantId, s.id, snap(code(8)), { expectedVersion: 1, actor });
    expect(await store.noteUnknown(sql, tenantId, s.id, { category: "timeout", detail: null })).toMatchObject({ state: "sending", failureCategory: "timeout" });
    expect(await store.markFailed(sql, tenantId, s.id, { category: "validation", detail: "Xero said no" })).toMatchObject({ state: "failed", failureCategory: "validation", failureDetail: "Xero said no" });
    // noteUnknown no longer applies once it has failed
    expect(await store.noteUnknown(sql, tenantId, s.id, { category: "timeout", detail: null })).toBeNull();
    expect(await store.markAccepted(sql, tenantId, s.id, { xeroInvoiceId: `${marker}-x8`, mirror: mirror(), drift: null })).toMatchObject({ state: "sent", failureCategory: null, failureDetail: null });
  });

  it("attempts are written with their outcome and can never be changed", async () => {
    const j = job("attempts");
    const s = await add(j);
    const row = await store.beginSend(sql, tenantId, s.id, snap(code(9)), { expectedVersion: 1, actor });
    const id1 = "11111111-1111-4111-8111-" + marker.padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "0");
    await store.insertAttempt(sql, tenantId, {
      id: id1, invoiceId: s.id, externalTenantId: "org-1", invoiceNumber: row.invoiceNumber, contentHash: "h", requestHash: "rh",
      idempotencyKey: "k".repeat(64), outcome: "error", httpStatus: null, errorCategory: "timeout", errorDetail: null, actor,
    });
    const list = await store.listAttempts(sql, tenantId, s.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ outcome: "error", invoiceNumber: row.invoiceNumber, idempotencyKey: "k".repeat(64), errorCategory: "timeout", httpStatus: null });
    await expect(sql`update public.customer_invoice_attempts set outcome = 'accepted' where id = ${id1}`).rejects.toThrow(/immutable/i);
    await expect(store.insertAttempt(sql, tenantId, { id: id1.replace(/^1/, "2"), invoiceId: s.id, externalTenantId: "org-1", invoiceNumber: row.invoiceNumber, contentHash: "h", outcome: "sent" })).rejects.toThrow(/check/i);
  });

  it("reset releases the number and clears the snapshot — but never for a stage Xero has", async () => {
    const j = job("reset");
    const s = await add(j);
    await store.beginSend(sql, tenantId, s.id, snap(code(10)), { expectedVersion: 1, actor });
    await store.markFailed(sql, tenantId, s.id, { category: "validation", detail: "no" });
    const back = await store.resetToPlanned(sql, tenantId, s.id, { actor });
    expect(back).toMatchObject({
      state: "planned", seq: null, invoiceNumber: null, grossCents: null, retentionCents: null, netCents: null, invoiceDate: null,
      dueDate: null, reference: null, contentHash: null, externalTenantId: null, xeroContactId: null, failureCategory: null, sentBy: null,
    });
    expect(back.amountCents).toBe(10_000_00); // what the office typed is untouched
    expect(await store.peekNextSeq(sql, tenantId, j)).toBe(1); // the number is free again

    // claimed again, accepted, then reset must refuse
    await store.beginSend(sql, tenantId, s.id, snap(code(10)), { expectedVersion: back.version, actor });
    await store.markAccepted(sql, tenantId, s.id, { xeroInvoiceId: `${marker}-x10`, mirror: mirror(), drift: null });
    await expect(store.resetToPlanned(sql, tenantId, s.id, { actor })).rejects.toMatchObject({ reason: "not_resettable" });
    await expect(store.resetToPlanned(sql, tenantId, "00000000-0000-4000-8000-000000000000", { actor })).rejects.toMatchObject({ reason: "not_found" });
  });

  it("raise again burns the number (kept on the cancelled row) and the copy takes the next one", async () => {
    const j = job("raise");
    const s = await store.createStage(sql, tenantId, j, {
      kind: "stage", title: "Deposit", basis: "percent", percentBp: 2000, amountCents: null,
      extraLines: [{ description: "Variation 1", amountCents: 1_000_00 }], retentionBp: null, plannedDate: "2026-12-01", note: "note",
    }, actor);
    await store.beginSend(sql, tenantId, s.id, snap(code(11)), { expectedVersion: 1, actor });
    await expect(store.raiseAgain(sql, tenantId, s.id, { actor })).rejects.toMatchObject({ reason: "not_raisable" }); // still sending
    await store.markFailed(sql, tenantId, s.id, { category: "number_taken", detail: "taken" });

    const fresh = await store.raiseAgain(sql, tenantId, s.id, { actor });
    expect(fresh).toMatchObject({ state: "planned", title: "Deposit", basis: "percent", percentBp: 2000, seq: null, invoiceNumber: null, plannedDate: "2026-12-01", note: "note", version: 1 });
    expect(fresh.extraLines).toEqual([{ description: "Variation 1", amountCents: 1_000_00 }]);
    expect(fresh.id).not.toBe(s.id);

    const old = await store.getInvoice(sql, tenantId, s.id);
    expect(old).toMatchObject({ state: "cancelled", seq: 1, invoiceNumber: `${code(11)}-1` });
    expect((await store.listJobInvoices(sql, tenantId, j)).map((r: { id: string }) => r.id)).toEqual([fresh.id]);

    const next = await store.beginSend(sql, tenantId, fresh.id, snap(code(11)), { expectedVersion: 1, actor });
    expect(next.invoiceNumber).toBe(`${code(11)}-2`);
    const events = await store.listJobEvents(sql, tenantId, j);
    expect(events.map((e: { event: string }) => e.event)).toContain("raised_again");
  });
});
