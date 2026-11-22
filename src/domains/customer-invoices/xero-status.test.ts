import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeXero, type FakeXero } from "./test-helpers/fake-xero";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * api/_lib/customer-invoices/xero-status.js (#1151) — what happened to an
 * invoice AFTER it was sent. The real status service (and the real send
 * service, to get stages into "Xero") run against the in-memory store and a
 * stand-in Xero in which a test plays the office: approve, take a payment,
 * edit, void, delete.
 *
 * What it defends: BuhlOS shows XERO'S figures and never its own guess, a
 * dead invoice drops out of the job's money, and the check only ever READS.
 */
const requireFromHere = createRequire(import.meta.url);
const Send = requireFromHere("../../../api/_lib/customer-invoices/xero-send.js");
const Status = requireFromHere("../../../api/_lib/customer-invoices/xero-status.js");
const A = requireFromHere("../../../api/_lib/customer-invoices/amounts.js");
const { displayStatus } = requireFromHere("../../../api/_lib/customer-invoices/status.js");
const { XeroError } = requireFromHere("../../../api/_lib/xero/errors.js");

const tenant = { id: "t1" };
const actor = { id: "u_admin", name: "Karen Boss" };
const job = { id: "tower", name: "Tower Fit-out", code: "IV3345", contractValue: 250000 };
const job2 = { id: "shop", name: "Corner Shop", code: "IV7001", contractValue: 50000 };
const SETTINGS = { salesAccountCode: "200", salesAccountName: "Sales", taxType: "OUTPUT", taxName: "GST on Income", taxRateBp: 1000, paymentTermsDays: 30 };
const NOW = Date.parse("2026-12-01T00:00:00Z");

let mem: MemoryStore;
let xero: FakeXero;
let ready: { state: string; organisationName: string | null; externalTenantId: string | null };
let clock: number;

const lookups = () => ({
  readiness: async () => ready,
  assertReady: (r: { state: string }) => {
    if (r.state !== "connected") throw new XeroError(r.state === "disconnected" ? "not_connected" : "reconnect_required");
  },
});
const deps = () => ({ sql: {}, store: mem, xeroFetch: xero.xeroFetch, lookups: lookups(), env: { APP_BASE_URL: "https://buhlos.com" }, now: () => clock });

async function sendStage(j: typeof job, stage: Record<string, unknown>) {
  const s = await mem.createStage({}, "t1", j.id, { kind: "stage", basis: "amount", percentBp: null, extraLines: [], retentionBp: null, plannedDate: null, note: null, ...stage });
  const out = await Send.send({ tenant, invoice: mem.rows.find((r) => r.id === s.id), job: j, options: { expectedVersion: 1, invoiceDate: "2026-11-22" }, actor, deps: deps() });
  expect(out.outcome).toBe("sent");
  return s.id as string;
}
const row = (id: string) => mem.rows.find((r) => r.id === id)!;
const refresh = (j: typeof job = job) => Status.refreshJob({ tenant, job: j, deps: deps() });
const poll = (budgetMs?: number) => Status.pollAll({ tenant, deps: deps(), ...(budgetMs == null ? {} : { budgetMs }) });
const totals = (j: typeof job = job) => A.jobTotals(mem.rows.filter((r) => r.jobId === j.id && r.state !== "cancelled"), { contractCents: A.contractCentsOf(j.contractValue), retentionBp: 0 });
const show = (id: string, today = "2026-12-01") => displayStatus(row(id), today);
const statusEvents = (id: string) => mem.events.filter((e) => e.invoiceId === id && e.event === "status_changed");

beforeEach(async () => {
  mem = createMemoryStore();
  xero = createFakeXero();
  clock = NOW;
  mem.setNow(clock);
  ready = { state: "connected", organisationName: "Buhl Electrical", externalTenantId: "org-1" };
  for (const j of [job, job2]) {
    await mem.saveProfile({}, "t1", j.id, { xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", retentionBp: 0 }, { expectedVersion: null });
  }
  await mem.saveSettings({}, "t1", "org-1", SETTINGS, { expectedVersion: null });
});

describe("following an invoice through Xero", () => {
  it("draft → approved → part paid → paid, each step mirrored with Xero's own figures", async () => {
    const id = await sendStage(job, { title: "Deposit", amountCents: 50_000_00 });
    expect(show(id)).toBe("draft_in_xero");
    expect(totals()).toMatchObject({ draftedCents: 50_000_00, invoicedCents: 0, paidIncGstCents: 0, dueIncGstCents: 0 });

    // nothing has happened in Xero yet → nothing changes, but it was checked
    let out = await refresh();
    expect(out).toMatchObject({ checked: 1, changed: 0, notFound: 0 });
    expect(statusEvents(id)).toHaveLength(0);

    xero.approve("IV3345-1");
    out = await refresh();
    expect(out).toMatchObject({ checked: 1, changed: 1 });
    expect(out.changes).toEqual([{ id, invoiceNumber: "IV3345-1", jobId: "tower", from: "DRAFT", to: "AUTHORISED" }]);
    expect(row(id)).toMatchObject({ xeroStatus: "AUTHORISED", xeroAmountDueCents: 55_000_00, xeroAmountPaidCents: 0 });
    expect(show(id)).toBe("awaiting_payment");
    expect(totals()).toMatchObject({ draftedCents: 0, invoicedCents: 50_000_00, dueIncGstCents: 55_000_00, paidIncGstCents: 0 });

    xero.pay("IV3345-1", 20000);
    await refresh();
    expect(row(id)).toMatchObject({ xeroStatus: "AUTHORISED", xeroAmountPaidCents: 20_000_00, xeroAmountDueCents: 35_000_00 });
    expect(show(id)).toBe("part_paid");
    // 20,000 inc GST is 18,181.82 ex GST — split on Xero's own subtotal / total
    expect(totals()).toMatchObject({ paidIncGstCents: 20_000_00, paidCents: 18_181_82, dueIncGstCents: 35_000_00 });

    xero.pay("IV3345-1", 35000, "2026-12-10");
    await refresh();
    expect(row(id)).toMatchObject({ xeroStatus: "PAID", xeroAmountPaidCents: 55_000_00, xeroAmountDueCents: 0, xeroFullyPaidOn: "2026-12-10" });
    expect(show(id)).toBe("paid");
    expect(totals()).toMatchObject({ invoicedCents: 50_000_00, paidIncGstCents: 55_000_00, paidCents: 50_000_00, dueIncGstCents: 0 });

    expect(statusEvents(id)).toHaveLength(3);
    expect(statusEvents(id)[0]!.detail).toMatchObject({ from: { status: "DRAFT" }, to: { status: "AUTHORISED" } });
  });

  it("is overdue once Xero's due date has passed and money is still owing", async () => {
    const id = await sendStage(job, { title: "Deposit", amountCents: 50_000_00 });
    xero.approve("IV3345-1");
    await refresh();
    expect(row(id).xeroDueDate).toBe("2026-12-22");
    expect(show(id, "2026-12-22")).toBe("awaiting_payment");
    expect(show(id, "2026-12-23")).toBe("overdue");
    xero.pay("IV3345-1", 10000);
    await refresh();
    expect(show(id, "2026-12-23")).toBe("overdue"); // part paid but late is still overdue
    expect(show(id, "2026-12-01")).toBe("part_paid");
  });

  it("the office edits the draft in Xero: BuhlOS takes Xero's figures and says it was changed", async () => {
    const id = await sendStage(job, { title: "Deposit", amountCents: 50_000_00 });
    xero.editSubtotal("IV3345-1", 48000);
    const out = await refresh();
    expect(out.changed).toBe(1);
    expect(row(id)).toMatchObject({ xeroSubtotalCents: 48_000_00, xeroTaxCents: 4_800_00, xeroTotalCents: 52_800_00, netCents: 50_000_00 });
    expect((row(id).drift as { mismatches: string[] }).mismatches).toEqual(["subtotal"]);
    // the job's money uses Xero's figure, not what BuhlOS sent
    expect(totals().draftedCents).toBe(48_000_00);

    // …and when Xero is put back, the note clears
    xero.editSubtotal("IV3345-1", 50000);
    await refresh();
    expect(row(id).drift).toBeNull();
  });

  it("voided in Xero: drops out of every total, and isn't called 'changed'", async () => {
    const id = await sendStage(job, { title: "Deposit", amountCents: 50_000_00 });
    xero.approve("IV3345-1");
    await refresh();
    expect(totals()).toMatchObject({ sentCount: 1, claimedCents: 50_000_00, stillToInvoiceCents: 200_000_00 });
    xero.void("IV3345-1");
    await refresh();
    expect(row(id)).toMatchObject({ xeroStatus: "VOIDED", drift: null });
    expect(show(id)).toBe("voided");
    expect(totals()).toMatchObject({ sentCount: 0, claimedCents: 0, invoicedCents: 0, dueIncGstCents: 0, stillToInvoiceCents: 250_000_00 });
  });

  it("deleted in Xero — even when the list read leaves it out, the single read finds it", async () => {
    const id = await sendStage(job, { title: "Deposit", amountCents: 50_000_00 });
    xero.delete("IV3345-1");
    xero.leaveOutOfLists("IV3345-1");
    const out = await refresh();
    expect(out).toMatchObject({ checked: 1, changed: 1, notFound: 0 });
    expect(row(id).xeroStatus).toBe("DELETED");
    expect(show(id)).toBe("deleted_in_xero");
    // it asked for the list, then for that one invoice
    const urls = xero.gets().slice(-2).map((c) => new URL(c.url));
    expect(urls[0]!.search).toContain("IDs=");
    expect(urls[1]!.pathname).toMatch(/\/Invoices\/aaaaaaaa-/);
  });

  it("Xero has nothing at all under the stored id: the last figures are KEPT and the row says so — no status is invented", async () => {
    const id = await sendStage(job, { title: "Deposit", amountCents: 50_000_00 });
    xero.approve("IV3345-1");
    await refresh();
    xero.vanish("IV3345-1");
    const out = await refresh();
    expect(out).toMatchObject({ checked: 1, changed: 1, notFound: 1 });
    expect(row(id)).toMatchObject({ xeroStatus: "AUTHORISED", xeroSubtotalCents: 50_000_00, xeroAmountDueCents: 55_000_00 });
    expect((row(id).drift as { mismatches: string[] }).mismatches).toEqual(["not_found_in_xero"]);
    // a second check doesn't record the same thing again
    const again = await refresh();
    expect(again).toMatchObject({ checked: 1, changed: 0, notFound: 1 });
    expect(statusEvents(id)).toHaveLength(2);
  });
});

describe("the check only reads, and only what it should", () => {
  it("never writes to Xero", async () => {
    await sendStage(job, { title: "Deposit", amountCents: 50_000_00 });
    const putsBefore = xero.puts().length;
    xero.approve("IV3345-1");
    await refresh();
    await poll();
    expect(xero.puts()).toHaveLength(putsBefore);
    expect(xero.calls.slice(-2).every((c) => c.method === "GET")).toBe(true);
  });

  it("asks about many invoices in batches of 40 — one request per batch", async () => {
    for (let i = 0; i < 45; i++) await sendStage(job, { title: `Stage ${i}`, amountCents: 1_000_00 });
    const before = xero.gets().length;
    const out = await poll();
    expect(out).toMatchObject({ checked: 45, changed: 0, stoppedEarly: false });
    const reads = xero.gets().slice(before).map((c) => new URL(c.url).searchParams.get("IDs")!.split(",").length);
    expect(reads).toEqual([40, 5]);
  });

  it("\"Check Xero now\" covers one job; the hourly check covers every job in the connected organisation", async () => {
    const a = await sendStage(job, { title: "Tower deposit", amountCents: 50_000_00 });
    const b = await sendStage(job2, { title: "Shop deposit", amountCents: 10_000_00 });
    xero.approve("IV3345-1");
    xero.approve("IV7001-1");
    await refresh(job);
    expect(row(a).xeroStatus).toBe("AUTHORISED");
    expect(row(b).xeroStatus).toBe("DRAFT");
    const out = await poll();
    expect(out).toMatchObject({ checked: 2, changed: 1 });
    expect(row(b).xeroStatus).toBe("AUTHORISED");
  });

  it("the hourly check leaves voided and deleted invoices alone, and re-checks a paid one only once a day", async () => {
    const paid = await sendStage(job, { title: "Paid", amountCents: 10_000_00 });
    const voided = await sendStage(job, { title: "Voided", amountCents: 10_000_00 });
    const open = await sendStage(job, { title: "Open", amountCents: 10_000_00 });
    xero.approve("IV3345-1");
    xero.pay("IV3345-1", 11000, "2026-11-30");
    xero.void("IV3345-2");
    xero.approve("IV3345-3");
    await poll();
    expect([row(paid).xeroStatus, row(voided).xeroStatus, row(open).xeroStatus]).toEqual(["PAID", "VOIDED", "AUTHORISED"]);

    // an hour later: only the open one is asked about
    clock += 3600_000;
    mem.setNow(clock);
    let out = await poll();
    expect(out.checked).toBe(1);

    // a day later: the paid one is checked again too (a payment can be removed)
    clock += 25 * 3600_000;
    mem.setNow(clock);
    out = await poll();
    expect(out.checked).toBe(2);

    // …and Check Xero now always asks about all three
    expect((await refresh()).checked).toBe(3);
  });

  it("a payment removed in Xero after it was paid is picked up", async () => {
    const id = await sendStage(job, { title: "Deposit", amountCents: 10_000_00 });
    xero.approve("IV3345-1");
    xero.pay("IV3345-1", 11000);
    await refresh();
    expect(show(id)).toBe("paid");
    Object.assign(xero.get("IV3345-1"), { Status: "AUTHORISED", AmountPaid: 0, AmountDue: 11000, FullyPaidOnDate: undefined });
    await refresh();
    expect(row(id)).toMatchObject({ xeroStatus: "AUTHORISED", xeroAmountPaidCents: 0, xeroAmountDueCents: 11_000_00, xeroFullyPaidOn: null });
    expect(show(id)).toBe("awaiting_payment");
  });

  it("only asks about invoices in the organisation that is connected now", async () => {
    const id = await sendStage(job, { title: "Deposit", amountCents: 10_000_00 });
    xero.approve("IV3345-1");
    ready = { state: "connected", organisationName: "Other Org", externalTenantId: "org-2" };
    const before = xero.gets().length;
    expect(await poll()).toMatchObject({ checked: 0, changed: 0 });
    expect(await refresh()).toMatchObject({ checked: 0 });
    expect(xero.gets()).toHaveLength(before);
    expect(row(id).xeroStatus).toBe("DRAFT");
  });
});

describe("when Xero can't be asked", () => {
  it("the hourly check is skipped — with the reason — when Xero isn't usable; that is not a failure", async () => {
    await sendStage(job, { title: "Deposit", amountCents: 10_000_00 });
    const before = xero.gets().length;
    for (const state of ["disconnected", "reconnect_required", "missing_permission", "connecting"]) {
      ready = { state, organisationName: null, externalTenantId: "org-1" };
      expect(await poll()).toMatchObject({ skipped: state, checked: 0, changed: 0 });
    }
    expect(xero.gets()).toHaveLength(before);
  });

  it("\"Check Xero now\" refuses outright when Xero isn't usable", async () => {
    ready = { state: "reconnect_required", organisationName: null, externalTenantId: "org-1" };
    await expect(refresh()).rejects.toMatchObject({ category: "reconnect_required" });
  });

  it("a failed read throws and changes NOTHING — a stale figure is never replaced by a guess", async () => {
    const id = await sendStage(job, { title: "Deposit", amountCents: 10_000_00 });
    xero.approve("IV3345-1");
    const before = { ...row(id) };
    xero.failReads(new XeroError("server", { status: 503 }));
    await expect(refresh()).rejects.toMatchObject({ category: "server" });
    await expect(poll()).rejects.toMatchObject({ category: "server" });
    expect(row(id)).toEqual(before);
    xero.failReads(null);
    await refresh();
    expect(row(id).xeroStatus).toBe("AUTHORISED");
  });

  it("stops between batches when it runs out of time and says so; the rest go next run", async () => {
    for (let i = 0; i < 45; i++) await sendStage(job, { title: `Stage ${i}`, amountCents: 1_000_00 });
    // every batch "takes" a minute; the budget is 30 seconds
    const slow = { ...deps(), xeroFetch: async (url: string, opts: Record<string, unknown>) => { clock += 60_000; return xero.xeroFetch(url, opts); } };
    const out = await Status.pollAll({ tenant, deps: { ...slow, now: () => clock }, budgetMs: 30_000 });
    expect(out).toMatchObject({ checked: 40, stoppedEarly: true });
  });
});

describe("pure helpers", () => {
  const base = { invoiceNumber: "IV3345-1", xeroContactId: "c-built", netCents: 50_000_00, drift: null };
  const got = (over: Record<string, unknown> = {}) => ({ status: "DRAFT", invoiceNumber: "IV3345-1", contactId: "c-built", subtotalCents: 50_000_00, ...over });

  it("driftOf names what a status read can see has changed", () => {
    expect(Status.driftOf(base, got(), "t")).toBeNull();
    expect(Status.driftOf(base, got({ subtotalCents: 1 }), "t")).toEqual({ mismatches: ["subtotal"], at: "t" });
    expect(Status.driftOf(base, got({ contactId: "someone-else" }), "t")!.mismatches).toEqual(["contact"]);
    expect(Status.driftOf(base, got({ invoiceNumber: "INV-9" }), "t")!.mismatches).toEqual(["invoice_number"]);
  });

  it("a dead invoice is not 'changed', and a status change alone is not drift", () => {
    expect(Status.driftOf(base, got({ status: "VOIDED", subtotalCents: 1 }), "t")).toBeNull();
    expect(Status.driftOf(base, got({ status: "DELETED" }), "t")).toBeNull();
    expect(Status.driftOf(base, got({ status: "PAID" }), "t")).toBeNull();
  });

  it("keeps a line mismatch found at the send (this read can't see lines) and the time a difference was first seen", () => {
    expect(Status.driftOf({ ...base, drift: { mismatches: ["lines"], at: "t0" } }, got(), "t1")).toEqual({ mismatches: ["lines"], at: "t0" });
    expect(Status.driftOf({ ...base, drift: { mismatches: ["subtotal"], at: "t0" } }, got({ subtotalCents: 1 }), "t1")).toEqual({ mismatches: ["subtotal"], at: "t0" });
    // a readback that failed at send clears once Xero answers and matches
    expect(Status.driftOf({ ...base, drift: { mismatches: ["readback_failed:timeout"], at: "t0" } }, got(), "t1")).toBeNull();
  });

  it("whatMoved lists exactly the figures that differ", () => {
    const stored = { xeroStatus: "AUTHORISED", xeroSubtotalCents: 100, xeroTaxCents: 10, xeroTotalCents: 110, xeroAmountDueCents: 110, xeroAmountPaidCents: 0, xeroAmountCreditedCents: 0, xeroDueDate: "2026-12-22", xeroFullyPaidOn: null };
    const same = { status: "AUTHORISED", subtotalCents: 100, taxCents: 10, totalCents: 110, amountDueCents: 110, amountPaidCents: 0, amountCreditedCents: 0, dueDate: "2026-12-22", fullyPaidOn: null };
    expect(Status.whatMoved(stored, same)).toEqual([]);
    expect(Status.whatMoved(stored, { ...same, status: "PAID", amountDueCents: 0, amountPaidCents: 110, fullyPaidOn: "2026-12-10" })).toEqual(["status", "amountDueCents", "amountPaidCents", "fullyPaidOn"]);
  });
});
