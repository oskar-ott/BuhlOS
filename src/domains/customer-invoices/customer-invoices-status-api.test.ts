import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "@/domains/audit-log/schema";
import { JobInvoicingResponseSchema, RefreshResponseSchema } from "./schema";
import { createFakeXero, type FakeXero } from "./test-helpers/fake-xero";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * api/customer-invoices.js — what happens AFTER a send (#1151): "Check Xero
 * now" (`refresh`), the hourly check (`poll`, cron-only) and raising a
 * deleted / voided invoice again. The REAL handler, send service, status
 * service, lookups and sync-log recorder run; the stored connection, the Xero
 * HTTP call (a stand-in in which the test plays the office), Blob and the
 * Postgres store are stand-ins.
 */
const requireFromHere = createRequire(import.meta.url);
const resolve = (p: string) => requireFromHere.resolve(p);
const blobPath = resolve("../../../api/_lib/blob.js");
const dbPath = resolve("../../../api/_lib/supabase-db.js");
const storePath = resolve("../../../api/_lib/customer-invoices/store.js");
const tokenStorePath = resolve("../../../api/_lib/xero/token-store.js");
const clientPath = resolve("../../../api/_lib/xero/client.js");
const fresh = [
  "../../../api/_lib/auth.js",
  "../../../api/_lib/feature-flags.js",
  "../../../api/_lib/audit-log.js",
  "../../../api/_lib/xero-sync-log.js",
  "../../../api/_lib/customer-invoices/xero-lookups.js",
  "../../../api/_lib/customer-invoices/xero-send.js",
  "../../../api/_lib/customer-invoices/xero-status.js",
  "../../../api/_lib/customer-invoices/sync-bridge.js",
  "../../../api/customer-invoices.js",
].map(resolve);

const SCOPES = "openid profile email offline_access payroll.employees.read payroll.settings.read accounting.settings.read accounting.invoices accounting.contacts.read";
const SETTINGS = { salesAccountCode: "200", salesAccountName: "Sales", taxType: "OUTPUT", taxName: "GST on Income", taxRateBp: 1000, paymentTermsDays: 30 };
const { XeroError } = requireFromHere("../../../api/_lib/xero/errors.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let syncLog: { retry: (operation: string) => Promise<{ outcome: string; reason?: string }>; openState: () => Promise<{ items: Array<{ operation: string; syncType: string; category?: string; reason?: string; recordRef: string }>; lastSuccessAt: Record<string, string> }> };
let mem: MemoryStore;
let xero: FakeXero;
let connection: Record<string, unknown> | null;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}
async function call(opts: { method?: string; role?: string; userId?: string; anonymous?: boolean; headers?: Record<string, string>; query?: Record<string, string>; body?: unknown }): Promise<Res> {
  const res = createRes();
  const cookie = `buhl_session=${auth.signSession({ userId: opts.userId || "u_admin", role: opts.role || "admin", exp: Date.now() + 60_000 })}`;
  await handler({ method: opts.method || "GET", query: opts.query || {}, body: opts.body, headers: opts.headers || (opts.anonymous ? {} : { cookie }) }, res);
  return res;
}
const row = (id: string) => mem.rows.find((r) => r.id === id)!;
async function addAndSend(stage: Record<string, unknown> = { title: "Deposit", basis: "percent", percentBp: 2000 }, jobId = "tower") {
  const added = await call({ method: "POST", query: { action: "stage-add" }, body: { jobId, stage } });
  const p = JobInvoicingResponseSchema.parse(added.body);
  const s = p.stages[p.stages.length - 1]!;
  const sent = await call({ method: "POST", query: { action: "send", id: s.id }, body: { expectedVersion: row(s.id).version, invoiceDate: "2026-11-22" } });
  expect(sent.statusCode).toBe(200);
  return s.id;
}
const refresh = (jobId = "tower", opts: Partial<Parameters<typeof call>[0]> = {}) => call({ method: "POST", query: { action: "refresh" }, body: { jobId }, ...opts });
const poll = (headers: Record<string, string> = { authorization: "Bearer cron-secret-1" }) => call({ method: "GET", query: { action: "poll" }, headers });
const raiseAgain = (id: string) => call({ method: "POST", query: { action: "raise-again", id }, body: {} });
const jobView = async (jobId = "tower") => JobInvoicingResponseSchema.parse((await call({ query: { jobId } })).body);
function journal() {
  const out: Array<{ action: string; targetType: string; targetId: string; jobId?: string; summary: string; metadata?: Record<string, unknown> }> = [];
  for (const [k, v] of blob) if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  return out;
}

beforeEach(async () => {
  Object.assign(process.env, {
    SESSION_SECRET: "test-session-secret-long-enough",
    FLAG_CUSTOMER_INVOICES: "true",
    CRON_SECRET: "cron-secret-1",
    XERO_CLIENT_ID: "client-id-1",
    XERO_CLIENT_SECRET: "client-secret-1",
    XERO_TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "https://buhlos.com",
    SUPABASE_DB_URL: "postgres://user:pass@host:6543/db",
  });
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: [
      { id: "tower", name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", status: "active", contractValue: 250000 },
      { id: "shop", name: "Corner Shop", code: "IV7001", clientName: "Built Pty Ltd", status: "active", contractValue: 50000 },
    ] }],
    ["users.json", { users: [
      { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      { id: "u_lh", username: "lead", name: "Lead Hand", role: "leadingHand", assignedJobIds: ["tower"] },
    ] }],
  ]);
  mem = createMemoryStore();
  xero = createFakeXero();
  connection = { status: "connected", external_tenant_id: "org-1", external_tenant_name: "Buhl Electrical", granted_scopes: SCOPES };
  for (const jobId of ["tower", "shop"]) {
    await mem.saveProfile({}, "t1", jobId, { xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", retentionBp: 0 }, { expectedVersion: null });
  }
  await mem.saveSettings({}, "t1", "org-1", SETTINGS, { expectedVersion: null });

  for (const p of fresh) delete requireFromHere.cache[p];
  const mock = (path: string, exports: unknown) => {
    requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
  };
  mock(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
    writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
    setNoCache: vi.fn(),
  });
  mock(dbPath, { getDb: () => ({}) });
  mock(storePath, mem);
  mock(tokenStorePath, { getConnection: vi.fn(async () => (connection ? { ...connection } : null)) });
  mock(clientPath, { xeroFetch: (url: string, opts: Record<string, unknown>) => xero.xeroFetch(url, opts) });
  auth = requireFromHere(resolve("../../../api/_lib/auth.js"));
  syncLog = requireFromHere(resolve("../../../api/_lib/xero-sync-log.js"));
  handler = requireFromHere(resolve("../../../api/customer-invoices.js"));
});

afterEach(() => {
  delete process.env.FLAG_CUSTOMER_INVOICES;
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_ENV;
});

describe("\"Check Xero now\" — POST ?action=refresh", () => {
  it("flag off → 404, no session → 401, below the office tier → 404, unknown job → 404, bad body → 400 — and Xero is never asked", async () => {
    expect((await refresh("tower", { anonymous: true })).statusCode).toBe(401);
    expect((await refresh("tower", { userId: "u_lh", role: "leadingHand" })).statusCode).toBe(404);
    expect((await refresh("nope")).body).toEqual({ error: "job_not_found" });
    expect((await call({ method: "POST", query: { action: "refresh" }, body: {} })).statusCode).toBe(400);
    expect((await call({ method: "POST", query: { action: "refresh" }, body: { jobId: "tower", status: "PAID" } })).statusCode).toBe(400);
    delete process.env.FLAG_CUSTOMER_INVOICES;
    expect((await refresh()).statusCode).toBe(404);
    expect(xero.calls).toEqual([]);
  });

  it("brings back what the office did in Xero — the job's refreshed figures and what the check found", async () => {
    const id = await addAndSend();
    xero.approve("IV3345-1");
    xero.pay("IV3345-1", 20000);
    const putsBefore = xero.puts().length;
    const r = await refresh();
    expect(r.statusCode).toBe(200);
    const p = RefreshResponseSchema.parse(r.body);
    expect(p.refresh).toEqual({ checked: 1, changed: 1, notFound: 0 });
    expect(p.stages[0]).toMatchObject({ id, display: "part_paid", xeroStatus: "AUTHORISED", xeroAmountPaidCents: 20_000_00, xeroAmountDueCents: 35_000_00, canRaiseAgain: false });
    expect(p.totals).toMatchObject({ invoicedCents: 50_000_00, paidIncGstCents: 20_000_00, dueIncGstCents: 35_000_00, draftedCents: 0 });
    expect(p.statusAsOf).toBeTruthy();
    expect(xero.puts()).toHaveLength(putsBefore); // it only read

    const last = journal().at(-1)!;
    expect(last).toMatchObject({ action: "customer_invoice.status_checked", jobId: "tower", targetId: "tower" });
    expect(last.metadata).toEqual({ checked: 1, changed: 1, notFound: 0 });
    expect(JSON.stringify(last)).not.toMatch(/20000|35000|50000/); // never an amount
    expect(AUDIT_ACTIONS).toContain(last.action);
  });

  it("a job with nothing sent answers quietly: nothing checked, Xero not asked", async () => {
    const p = RefreshResponseSchema.parse((await refresh("shop")).body);
    expect(p.refresh).toEqual({ checked: 0, changed: 0, notFound: 0 });
    expect(p.statusAsOf).toBeNull();
    expect(xero.gets()).toEqual([]);
  });

  it("says so — and changes nothing — when Xero can't be read", async () => {
    const id = await addAndSend();
    xero.approve("IV3345-1");
    const before = clone(row(id));
    const entries = journal().length;

    xero.failReads(new XeroError("server", { status: 503 }));
    let r = await refresh();
    expect(r.statusCode).toBe(502);
    expect(r.body).toMatchObject({ error: "xero_server" });

    xero.failReads(null);
    connection = { ...connection!, status: "reconnect_required" };
    r = await refresh();
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ error: "xero_reconnect_required" });

    connection = null;
    r = await refresh();
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ error: "xero_not_connected" });

    expect(row(id)).toEqual(before);
    expect(journal()).toHaveLength(entries);
  });
});

describe("the hourly check — GET ?action=poll (cron only)", () => {
  it("needs the cron secret: a browser session is not enough", async () => {
    await addAndSend();
    const reads = xero.gets().length;
    expect((await call({ method: "GET", query: { action: "poll" } })).statusCode).toBe(401); // an admin's cookie
    expect((await poll({})).statusCode).toBe(401);
    expect((await poll({ authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect(xero.gets()).toHaveLength(reads);
    expect((await poll({ "x-cron-secret": "cron-secret-1" })).statusCode).toBe(200);
  });

  it("refuses outright in production when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;
    process.env.VERCEL_ENV = "production";
    expect((await poll({})).statusCode).toBe(503);
    expect(xero.calls).toEqual([]);
  });

  it("does nothing at all while the feature is switched off", async () => {
    await addAndSend();
    xero.approve("IV3345-1");
    const reads = xero.gets().length;
    delete process.env.FLAG_CUSTOMER_INVOICES;
    const r = await poll();
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ skipped: "flag_off" });
    expect(xero.gets()).toHaveLength(reads);
    expect((await syncLog.openState()).lastSuccessAt.invoice_status).toBeFalsy();
  });

  it("checks every job's invoices, mirrors what moved, and records the run on the sync log", async () => {
    const a = await addAndSend();
    const b = await addAndSend({ title: "Shop deposit", basis: "amount", amountCents: 10_000_00 }, "shop");
    xero.approve("IV3345-1");
    xero.approve("IV7001-1");
    xero.pay("IV7001-1", 11000);
    const entries = journal().length;
    const r = await poll();
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, checked: 2, changed: 2, notFound: 0, stoppedEarly: false });
    expect(row(a).xeroStatus).toBe("AUTHORISED");
    expect(row(b)).toMatchObject({ xeroStatus: "PAID", xeroAmountPaidCents: 11_000_00, xeroAmountDueCents: 0 });
    expect((await jobView("shop")).stages[0]).toMatchObject({ display: "paid" });

    const open = await syncLog.openState();
    expect(open.items).toEqual([]);
    expect(open.lastSuccessAt.invoice_status).toBeTruthy();
    // the hourly check is not a person's action — nothing is journalled
    expect(journal()).toHaveLength(entries);
  });

  it("Xero down: still answers 200, says what failed, changes nothing, and leaves ONE open item that a later good run closes", async () => {
    const id = await addAndSend();
    xero.approve("IV3345-1");
    xero.failReads(new XeroError("server", { status: 503 }));
    let r = await poll();
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: false, error: "xero_server" });
    await poll(); // a second failed hour doesn't stack a second item
    expect(row(id).xeroStatus).toBe("DRAFT");
    let open = await syncLog.openState();
    expect(open.items.filter((i) => i.syncType === "invoice_status")).toHaveLength(1);
    expect(open.items[0]).toMatchObject({ operation: "invstatus:poll", syncType: "invoice_status", category: "server" });

    xero.failReads(null);
    r = await poll();
    expect(r.body).toMatchObject({ ok: true, checked: 1, changed: 1 });
    open = await syncLog.openState();
    expect(open.items).toEqual([]);
    expect(row(id).xeroStatus).toBe("AUTHORISED");
  });

  it("Retry on the sync panel simply runs the check again", async () => {
    const id = await addAndSend();
    xero.approve("IV3345-1");
    xero.failReads(new XeroError("timeout", {}));
    await poll();
    let out = await syncLog.retry("invstatus:poll");
    expect(out.outcome).toBe("failed");
    xero.failReads(null);
    out = await syncLog.retry("invstatus:poll");
    expect(out.outcome).toBe("resolved");
    expect(row(id).xeroStatus).toBe("AUTHORISED");
    expect((await syncLog.openState()).items).toEqual([]);
  });

  it("Xero not connected: skipped with the reason — not a failure, nothing on the sync log", async () => {
    await addAndSend();
    const reads = xero.gets().length;
    connection = null;
    const r = await poll();
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ ok: true, skipped: "disconnected", checked: 0, changed: 0 });
    expect(xero.gets()).toHaveLength(reads);
    const open = await syncLog.openState();
    expect(open.items).toEqual([]);
    expect(open.lastSuccessAt.invoice_status).toBeFalsy();
  });
});

describe("an invoice deleted or voided in Xero — raise it again", () => {
  it("a live invoice can't be raised again", async () => {
    const id = await addAndSend();
    expect((await raiseAgain(id)).body).toEqual({ error: "not_raisable" });
    xero.approve("IV3345-1");
    await refresh();
    expect((await raiseAgain(id)).body).toEqual({ error: "not_raisable" });
    expect((await jobView()).stages).toHaveLength(1);
  });

  for (const [how, status, word] of [["delete", "DELETED", "deleted"], ["void", "VOIDED", "voided"]] as const) {
    it(`${word}: it drops out of the job's money, offers "Raise again" once, and the new stage takes the NEXT number`, async () => {
      const id = await addAndSend();
      if (how === "delete") xero.delete("IV3345-1");
      else { xero.approve("IV3345-1"); xero.void("IV3345-1"); }
      const checked = RefreshResponseSchema.parse((await refresh()).body);
      expect(checked.stages[0]).toMatchObject({ id, display: how === "delete" ? "deleted_in_xero" : "voided", canRaiseAgain: true });
      expect(checked.totals).toMatchObject({ sentCount: 0, claimedCents: 0, stillToInvoiceCents: 250_000_00, invoicedCents: 0, dueIncGstCents: 0 });

      const r = await raiseAgain(id);
      expect(r.statusCode).toBe(201);
      const p = JobInvoicingResponseSchema.parse(r.body);
      expect(p.stages).toHaveLength(2);
      const [old, copy] = [p.stages.find((s) => s.id === id)!, p.stages.find((s) => s.id !== id)!];
      // the old row stays as history, with its number, marked as replaced
      expect(old).toMatchObject({ state: "sent", invoiceNumber: "IV3345-1", xeroStatus: status, replacedById: copy.id, canRaiseAgain: false });
      expect(copy).toMatchObject({ state: "planned", title: "Deposit", basis: "percent", percentBp: 2000, invoiceNumber: null });
      expect(p.totals).toMatchObject({ plannedCount: 1, plannedGrossCents: 50_000_00 });

      const last = journal().at(-1)!;
      expect(last).toMatchObject({ action: "customer_invoice.raised_again", targetId: copy.id, jobId: "tower" });
      expect(last.summary).toContain(`IV3345-1 was ${word} in Xero`);
      expect(last.metadata).toMatchObject({ burnedNumber: "IV3345-1", replaces: id, xeroStatus: status });

      // only once
      expect((await raiseAgain(id)).body).toEqual({ error: "not_raisable" });
      expect((await jobView()).stages).toHaveLength(2);

      // the copy is sent as a brand-new invoice: the next number, never the old one
      const sent = await call({ method: "POST", query: { action: "send", id: copy.id }, body: { expectedVersion: row(copy.id).version, invoiceDate: "2026-12-01" } });
      expect(sent.statusCode).toBe(200);
      expect(row(copy.id)).toMatchObject({ state: "sent", invoiceNumber: "IV3345-2" });
      expect(xero.invoices.map((i) => `${i.InvoiceNumber}:${i.Status}`)).toEqual([`IV3345-1:${status}`, "IV3345-2:DRAFT"]);
    });
  }
});

describe("raising again — changing your mind", () => {
  it("removing the planned copy lets the deleted invoice be raised again", async () => {
    const id = await addAndSend();
    xero.delete("IV3345-1");
    await refresh();
    const first = JobInvoicingResponseSchema.parse((await raiseAgain(id)).body).stages.find((s) => s.id !== id)!;
    const removed = await call({ method: "POST", query: { action: "stage-remove", id: first.id }, body: { expectedVersion: first.version } });
    expect(removed.statusCode).toBe(200);
    const after = await jobView();
    expect(after.stages).toHaveLength(1);
    expect(after.stages[0]).toMatchObject({ id, replacedById: null, canRaiseAgain: true });
    expect((await raiseAgain(id)).statusCode).toBe(201);
  });
});

describe("the job's payload after a send", () => {
  it("statusAsOf is the OLDEST check among the job's sent invoices; planned stages don't count", async () => {
    expect((await jobView()).statusAsOf).toBeNull();
    const a = await addAndSend({ title: "One", basis: "amount", amountCents: 1_000_00 });
    const b = await addAndSend({ title: "Two", basis: "amount", amountCents: 1_000_00 });
    await call({ method: "POST", query: { action: "stage-add" }, body: { jobId: "tower", stage: { title: "Later", basis: "amount", amountCents: 1_000_00 } } });
    row(a).lastCheckedAt = "2026-11-20T00:00:00.000Z";
    row(b).lastCheckedAt = "2026-11-22T00:00:00.000Z";
    expect((await jobView()).statusAsOf).toBe("2026-11-20T00:00:00.000Z");
  });

  it("splits the money by what Xero says: drafts, approved, paid and owing", async () => {
    await addAndSend({ title: "Draft", basis: "amount", amountCents: 10_000_00 });
    await addAndSend({ title: "Approved", basis: "amount", amountCents: 20_000_00 });
    await addAndSend({ title: "Paid", basis: "amount", amountCents: 30_000_00 });
    xero.approve("IV3345-2");
    xero.approve("IV3345-3");
    xero.pay("IV3345-3", 33000);
    const p = RefreshResponseSchema.parse((await refresh()).body);
    expect(p.stages.map((s) => s.display)).toEqual(["draft_in_xero", "awaiting_payment", "paid"]);
    expect(p.totals).toMatchObject({
      sentCount: 3, claimedCents: 60_000_00, stillToInvoiceCents: 190_000_00,
      draftedCents: 10_000_00, invoicedCents: 50_000_00, paidCents: 30_000_00, paidIncGstCents: 33_000_00, dueIncGstCents: 22_000_00,
    });
  });
});
