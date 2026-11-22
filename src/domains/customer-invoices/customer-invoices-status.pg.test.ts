import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Customer stage invoices — the STATUS CHECK's SQL (#1151) against a real
 * Postgres: which sent invoices the hourly check asks about, writing Xero's
 * figures onto a row, noting a check that found nothing new, and raising a
 * deleted / voided invoice again (once). Same gate as the other .pg tests:
 * CUSTOMER_INVOICES_PG_TEST=1 and SUPABASE_ENV=local, a throwaway local
 * database. Skipped in CI.
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

describe.skipIf(!ENABLED)("customer invoices status check — real Postgres", () => {
  const store = requireFromHere("../../../api/_lib/customer-invoices/store.js");
  const postgres = requireFromHere("postgres");
  const marker = `st${Date.now().toString(36)}`;
  // A Xero organisation of this run's own, so other tests' rows never show up.
  const org = `${marker}-org`;
  const job = (n: string) => `${marker}-${n}`;
  const actor = { id: "u_office", name: "Olive Office", role: "office" };
  let sql: Sql;
  let tenantId: string;
  let n = 0;

  const mirror = (over: Record<string, unknown> = {}) => ({
    status: "DRAFT", subtotalCents: 9_500_00, taxCents: 950_00, totalCents: 10_450_00, amountDueCents: 10_450_00,
    amountPaidCents: 0, amountCreditedCents: 0, dueDate: "2026-12-22", fullyPaidOn: null, updatedAt: "2026-11-22T01:02:03.000Z", ...over,
  });
  /** A stage that has been sent and accepted, with Xero's figures as given. */
  async function sentStage(j: string, over: Record<string, unknown> = {}, stage: Record<string, unknown> = {}) {
    const s = await store.createStage(sql, tenantId, j, { kind: "stage", title: "Stage", basis: "amount", amountCents: 10_000_00, percentBp: null, extraLines: [], retentionBp: null, plannedDate: null, note: null, ...stage }, actor);
    await store.beginSend(sql, tenantId, s.id, {
      jobCode: `${marker.toUpperCase()}${++n}`, grossCents: 10_000_00, retentionBp: 500, retentionCents: 500_00, netCents: 9_500_00,
      invoiceDate: "2026-11-22", dueDate: "2026-12-22", reference: "REF", externalTenantId: org,
      xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", build: (num: string) => `hash-of-${num}`,
    }, { expectedVersion: 1, actor });
    return store.markAccepted(sql, tenantId, s.id, { xeroInvoiceId: `${marker}-x${n}`, mirror: mirror(over), drift: null });
  }
  const due = async () => (await store.listForStatusCheck(sql, tenantId, org)).map((r: { id: string }) => r.id);
  const age = (id: string, interval: string) => sql`update public.customer_invoices set last_checked_at = now() - ${interval}::interval where id = ${id}`;

  beforeAll(async () => {
    sql = postgres(process.env.SUPABASE_DB_URL as string, { max: 1, prepare: false, onnotice: () => {} });
    tenantId = (await store.resolveTenant(sql)).id;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from public.customer_invoice_events where job_legacy_id like ${marker + "%"}`;
      await sql`update public.customer_invoices set replaced_by_id = null where job_legacy_id like ${marker + "%"}`;
      await sql`delete from public.customer_invoices where job_legacy_id like ${marker + "%"}`;
      await sql.end({ timeout: 5 });
    }
  });

  it("the hourly check asks about drafts and approved invoices every time, oldest check first", async () => {
    const j = job("due");
    const draft = await sentStage(j);
    const approved = await sentStage(j, { status: "AUTHORISED" });
    const submitted = await sentStage(j, { status: "SUBMITTED" });
    await age(approved.id, "3 hours");
    await age(submitted.id, "2 hours");
    await age(draft.id, "1 hour");
    expect(await due()).toEqual([approved.id, submitted.id, draft.id]);
    expect((await store.listForStatusCheck(sql, tenantId, org, { limit: 2 })).map((r: { id: string }) => r.id)).toEqual([approved.id, submitted.id]);
  });

  it("never asks about voided or deleted invoices, planned / sending / failed stages, another organisation's, or with no organisation", async () => {
    const j = job("skip");
    const voided = await sentStage(j, { status: "VOIDED" });
    const deleted = await sentStage(j, { status: "DELETED" });
    const planned = await store.createStage(sql, tenantId, j, { kind: "stage", title: "Later", basis: "amount", amountCents: 1_00, percentBp: null, extraLines: [], retentionBp: null, plannedDate: null, note: null }, actor);
    const ids = await due();
    for (const id of [voided.id, deleted.id, planned.id]) expect(ids).not.toContain(id);
    expect(await store.listForStatusCheck(sql, tenantId, `${org}-other`)).toEqual([]);
    expect(await store.listForStatusCheck(sql, tenantId, null)).toEqual([]);
    expect(await store.listJobSent(sql, tenantId, j, null)).toEqual([]);
    // …but "Check Xero now" for the job asks about every sent one, dead or not
    expect((await store.listJobSent(sql, tenantId, j, org)).map((r: { id: string }) => r.id)).toEqual([voided.id, deleted.id]);
    expect(await store.listJobSent(sql, tenantId, j, `${org}-other`)).toEqual([]);
  });

  it("a PAID invoice is re-checked once a day, and not at all 60 days after it was paid", async () => {
    const j = job("paid");
    const today = new Date().toISOString().slice(0, 10);
    const longAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const justPaid = await sentStage(j, { status: "PAID", amountDueCents: 0, amountPaidCents: 10_450_00, fullyPaidOn: today });
    const oldPaid = await sentStage(j, { status: "PAID", amountDueCents: 0, amountPaidCents: 10_450_00, fullyPaidOn: longAgo });
    expect(await due()).not.toContain(justPaid.id); // checked just now, at the send
    await age(justPaid.id, "25 hours");
    await age(oldPaid.id, "25 hours");
    const ids = await due();
    expect(ids).toContain(justPaid.id);
    expect(ids).not.toContain(oldPaid.id);
  });

  it("applyMirror writes Xero's figures, the drift and the time, and records what moved — only on a sent invoice", async () => {
    const j = job("mirror");
    const s = await sentStage(j);
    await age(s.id, "2 hours");
    const event = { from: { status: "DRAFT" }, to: { status: "AUTHORISED" }, changed: ["status"] };
    const row = await store.applyMirror(sql, tenantId, s.id, {
      mirror: mirror({ status: "AUTHORISED", subtotalCents: 9_000_00, taxCents: 900_00, totalCents: 9_900_00, amountDueCents: 4_900_00, amountPaidCents: 5_000_00, dueDate: "2027-01-15" }),
      drift: { mismatches: ["subtotal"], at: "2026-12-01T00:00:00.000Z" },
      event,
    });
    expect(row).toMatchObject({
      state: "sent", xeroStatus: "AUTHORISED", xeroSubtotalCents: 9_000_00, xeroTaxCents: 900_00, xeroTotalCents: 9_900_00,
      xeroAmountDueCents: 4_900_00, xeroAmountPaidCents: 5_000_00, xeroDueDate: "2027-01-15", xeroFullyPaidOn: null,
      netCents: 9_500_00, // what BuhlOS sent is untouched
      version: s.version + 1,
    });
    expect(row.drift).toMatchObject({ mismatches: ["subtotal"] });
    expect(Date.now() - Date.parse(row.lastCheckedAt)).toBeLessThan(60_000);
    const events = (await store.listJobEvents(sql, tenantId, j)).filter((e: { event: string }) => e.event === "status_changed");
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject(event);

    // paid in full, drift cleared, no event asked for → none written
    const paid = await store.applyMirror(sql, tenantId, s.id, { mirror: mirror({ status: "PAID", amountDueCents: 0, amountPaidCents: 10_450_00, fullyPaidOn: "2026-12-10" }), drift: null, event: null });
    expect(paid).toMatchObject({ xeroStatus: "PAID", xeroFullyPaidOn: "2026-12-10", drift: null });
    expect((await store.listJobEvents(sql, tenantId, j)).filter((e: { event: string }) => e.event === "status_changed")).toHaveLength(1);

    // a stage that isn't sent is never written to
    const planned = await store.createStage(sql, tenantId, j, { kind: "stage", title: "Later", basis: "amount", amountCents: 1_00, percentBp: null, extraLines: [], retentionBp: null, plannedDate: null, note: null }, actor);
    expect(await store.applyMirror(sql, tenantId, planned.id, { mirror: mirror(), drift: null, event })).toBeNull();
    expect(await store.getInvoice(sql, tenantId, planned.id)).toMatchObject({ state: "planned", xeroStatus: null, version: 1 });
  });

  it("touchChecked only notes the time — nothing else moves, not even the version", async () => {
    const j = job("touch");
    const a = await sentStage(j);
    const b = await sentStage(j);
    await age(a.id, "5 hours");
    await age(b.id, "5 hours");
    await store.touchChecked(sql, tenantId, [a.id]);
    await store.touchChecked(sql, tenantId, []);
    const [ra, rb] = [await store.getInvoice(sql, tenantId, a.id), await store.getInvoice(sql, tenantId, b.id)];
    expect(Date.now() - Date.parse(ra.lastCheckedAt)).toBeLessThan(60_000);
    expect(Date.now() - Date.parse(rb.lastCheckedAt)).toBeGreaterThan(4 * 3600_000);
    expect(ra).toMatchObject({ version: a.version, xeroStatus: "DRAFT", xeroSubtotalCents: 9_500_00 });
    expect((await due()).indexOf(b.id)).toBeLessThan((await due()).indexOf(a.id));
  });

  it("a deleted or voided invoice is raised again ONCE: the old row stays as history and the copy takes the next number", async () => {
    const j = job("raise");
    const s = await sentStage(j, {}, { title: "Deposit", basis: "percent", percentBp: 2000, amountCents: null, extraLines: [{ description: "Variation 1", amountCents: 1_000_00 }], plannedDate: "2026-12-01", note: "note" });
    await expect(store.raiseAgainSent(sql, tenantId, s.id, { actor })).rejects.toMatchObject({ reason: "not_raisable" }); // still a live draft
    await store.applyMirror(sql, tenantId, s.id, { mirror: mirror({ status: "DELETED", amountDueCents: 0 }), drift: null, event: null });

    const fresh = await store.raiseAgainSent(sql, tenantId, s.id, { actor });
    expect(fresh).toMatchObject({ state: "planned", title: "Deposit", basis: "percent", percentBp: 2000, seq: null, invoiceNumber: null, plannedDate: "2026-12-01", note: "note", version: 1, replacedById: null });
    expect(fresh.extraLines).toEqual([{ description: "Variation 1", amountCents: 1_000_00 }]);

    const old = await store.getInvoice(sql, tenantId, s.id);
    expect(old).toMatchObject({ state: "sent", seq: 1, invoiceNumber: s.invoiceNumber, xeroStatus: "DELETED", replacedById: fresh.id });
    // both stay on the job: the old one as history
    expect((await store.listJobInvoices(sql, tenantId, j)).map((r: { id: string }) => r.id).sort()).toEqual([s.id, fresh.id].sort());

    await expect(store.raiseAgainSent(sql, tenantId, s.id, { actor })).rejects.toMatchObject({ reason: "not_raisable" });
    await expect(store.raiseAgainSent(sql, tenantId, fresh.id, { actor })).rejects.toMatchObject({ reason: "not_raisable" });
    await expect(store.raiseAgainSent(sql, tenantId, "00000000-0000-4000-8000-000000000000", { actor })).rejects.toMatchObject({ reason: "not_found" });

    // the number is never reused
    expect(await store.peekNextSeq(sql, tenantId, j)).toBe(2);
    const events = (await store.listJobEvents(sql, tenantId, j)).map((e: { event: string }) => e.event);
    expect(events).toContain("raised_again");

    // removing the planned copy frees the old row to be raised again
    await store.removeStage(sql, tenantId, fresh.id, { expectedVersion: 1, actor });
    expect(await store.getInvoice(sql, tenantId, s.id)).toMatchObject({ replacedById: null });
    expect((await store.raiseAgainSent(sql, tenantId, s.id, { actor })).state).toBe("planned");
  });
});
