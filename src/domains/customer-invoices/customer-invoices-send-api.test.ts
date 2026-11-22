import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "@/domains/audit-log/schema";
import { JobInvoicingResponseSchema, SendPreviewSchema, SendResponseSchema } from "./schema";
import { createFakeXero, type FakeXero } from "./test-helpers/fake-xero";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * api/customer-invoices.js — the send routes (#1150): preview, send, retry,
 * reset, raise-again, retention-release. The REAL handler, the REAL send
 * service, the REAL lookups and the REAL sync-log recorder run; the stored
 * connection, the Xero HTTP call (a stand-in Xero that keeps invoices and can
 * be made to fail), Blob and the Postgres store are stand-ins.
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
  "../../../api/_lib/customer-invoices/sync-bridge.js",
  "../../../api/customer-invoices.js",
].map(resolve);

const SCOPES = "openid profile email offline_access payroll.employees.read payroll.settings.read accounting.settings.read accounting.invoices accounting.contacts.read";
const SETTINGS = { salesAccountCode: "200", salesAccountName: "Sales", taxType: "OUTPUT", taxName: "GST on Income", taxRateBp: 1000, paymentTermsDays: 30 };

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
async function call(opts: { method?: string; role?: string; userId?: string; anonymous?: boolean; query?: Record<string, string>; body?: unknown }): Promise<Res> {
  const res = createRes();
  const cookie = `buhl_session=${auth.signSession({ userId: opts.userId || "u_admin", role: opts.role || "admin", exp: Date.now() + 60_000 })}`;
  await handler({ method: opts.method || "GET", query: opts.query || {}, body: opts.body, headers: opts.anonymous ? {} : { cookie } }, res);
  return res;
}
const post = (action: string, id: string, body: unknown = {}) => call({ method: "POST", query: { action, id }, body });
const row = (id: string) => mem.rows.find((r) => r.id === id)!;
async function addStage(stage: Record<string, unknown> = { title: "Deposit", basis: "percent", percentBp: 2000 }, jobId = "tower") {
  const r = await call({ method: "POST", query: { action: "stage-add" }, body: { jobId, stage } });
  const p = JobInvoicingResponseSchema.parse(r.body);
  return p.stages[p.stages.length - 1]!;
}
const send = (id: string, body: Record<string, unknown> = {}) => post("send", id, { expectedVersion: row(id).version, invoiceDate: "2026-11-22", ...body });
function journal() {
  const out: Array<{ action: string; targetType: string; targetId: string; jobId?: string; summary: string; metadata?: Record<string, unknown> }> = [];
  for (const [k, v] of blob) if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  return out;
}

beforeEach(async () => {
  Object.assign(process.env, {
    SESSION_SECRET: "test-session-secret-long-enough",
    FLAG_CUSTOMER_INVOICES: "true",
    XERO_CLIENT_ID: "client-id-1",
    XERO_CLIENT_SECRET: "client-secret-1",
    XERO_TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "https://buhlos.com",
    SUPABASE_DB_URL: "postgres://user:pass@host:6543/db",
  });
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: [
      { id: "tower", name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", status: "active", contractValue: 250000 },
      { id: "nocode", name: "No Code Job", clientName: "Built Pty Ltd", status: "active", contractValue: 1000 },
    ] }],
    ["users.json", { users: [
      { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      { id: "u_lh", username: "lead", name: "Lead Hand", role: "leadingHand", assignedJobIds: ["tower"] },
    ] }],
  ]);
  mem = createMemoryStore();
  xero = createFakeXero();
  connection = { status: "connected", external_tenant_id: "org-1", external_tenant_name: "Buhl Electrical", granted_scopes: SCOPES };
  await mem.saveProfile({}, "t1", "tower", { xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", retentionBp: 0 }, { expectedVersion: null });
  await mem.saveProfile({}, "t1", "nocode", { xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", retentionBp: 0 }, { expectedVersion: null });
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
});

describe("api/customer-invoices — gating of the send routes", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const probes: Array<Parameters<typeof call>[0]> = [
    { method: "POST", query: { action: "preview", id }, body: {} },
    { method: "POST", query: { action: "send", id }, body: { expectedVersion: 1 } },
    { method: "POST", query: { action: "retry", id }, body: {} },
    { method: "POST", query: { action: "reset", id }, body: {} },
    { method: "POST", query: { action: "raise-again", id }, body: {} },
    { method: "POST", query: { action: "retention-release" }, body: { jobId: "tower", amountCents: 100 } },
  ];

  it("flag off → 404, no session → 401, below the office tier → 404 — and Xero is never called", async () => {
    for (const p of probes) expect((await call({ ...p, anonymous: true })).statusCode).toBe(401);
    for (const p of probes) expect((await call({ ...p, userId: "u_lh", role: "leadingHand" })).statusCode).toBe(404);
    delete process.env.FLAG_CUSTOMER_INVOICES;
    for (const p of probes) expect((await call(p)).statusCode).toBe(404);
    expect(xero.calls).toEqual([]);
  });

  it("404s a stage that doesn't exist and 400s a malformed id or body", async () => {
    for (const action of ["preview", "send", "retry", "reset", "raise-again"]) {
      const body = action === "send" ? { expectedVersion: 1 } : {};
      expect((await post(action, id, body)).body, action).toEqual({ error: "stage_not_found" });
      expect((await post(action, "not-a-uuid", body)).statusCode, action).toBe(400);
    }
    const s = await addStage();
    expect((await post("send", s.id, {})).statusCode).toBe(400); // no expectedVersion
    expect((await post("send", s.id, { expectedVersion: 1, invoiceDate: "22/11/2026" })).statusCode).toBe(400);
    expect((await post("send", s.id, { expectedVersion: 1, status: "AUTHORISED" })).statusCode).toBe(400); // nothing can ask for more than a draft
    expect((await post("retry", s.id, { force: true })).statusCode).toBe(400);
    expect(xero.calls).toEqual([]);
  });
});

describe("api/customer-invoices — preview", () => {
  it("answers exactly what would be sent and changes nothing", async () => {
    const s = await addStage();
    const r = await post("preview", s.id, { invoiceDate: "2026-11-22" });
    expect(r.statusCode).toBe(200);
    const p = SendPreviewSchema.parse(r.body);
    expect(p.blockers).toEqual([]);
    expect(p.invoice).toMatchObject({ invoiceNumber: "IV3345-1", contactName: "Built Pty Ltd", netCents: 50_000_00, estimatedTaxCents: 5_000_00, estimatedTotalCents: 55_000_00, dueDate: "2026-12-22" });
    expect(xero.calls).toEqual([]);
    expect(row(s.id)).toMatchObject({ state: "planned", version: 1 });
    expect(journal().map((e) => e.action)).toEqual(["customer_invoice.stage_added"]);
  });

  it("names the blockers", async () => {
    const s = await addStage({ title: "Deposit", basis: "amount", amountCents: 500_00 }, "nocode");
    const p = SendPreviewSchema.parse((await post("preview", s.id)).body);
    expect(p.blockers.map((b) => b.code)).toEqual(["no_job_code"]);
  });
});

describe("api/customer-invoices — send", () => {
  it("creates the draft, answers the refreshed job with how it ended, journals it and logs the sync", async () => {
    const s = await addStage();
    const r = await send(s.id);
    expect(r.statusCode).toBe(200);
    const p = SendResponseSchema.parse(r.body);
    expect(p.send).toEqual({ outcome: "sent", invoiceNumber: "IV3345-1", verified: true, mismatches: [], category: null, detail: null });
    const stage = p.stages[0]!;
    expect(stage).toMatchObject({ state: "sent", display: "draft_in_xero", invoiceNumber: "IV3345-1", xeroSubtotalCents: 50_000_00, xeroTaxCents: 5_000_00, xeroTotalCents: 55_000_00 });
    expect(stage.xeroInvoiceId).toBe(xero.invoices[0]!.InvoiceID);
    // sent stages count against the contract; nothing is "planned" any more
    expect(p.totals).toMatchObject({ sentCount: 1, claimedCents: 50_000_00, stillToInvoiceCents: 200_000_00, plannedCount: 0 });

    const last = journal().at(-1)!;
    expect(last).toMatchObject({ action: "customer_invoice.sent_to_xero", targetType: "customer_invoice", targetId: s.id, jobId: "tower" });
    expect(last.metadata).toMatchObject({ outcome: "sent", invoiceNumber: "IV3345-1", xeroInvoiceId: xero.invoices[0]!.InvoiceID, verified: true });
    expect(JSON.stringify(last)).not.toMatch(/50000|5000000|55000/); // never an amount
    expect(AUDIT_ACTIONS).toContain(last.action);

    const open = await syncLog.openState();
    expect(open.items).toEqual([]);
    expect(open.lastSuccessAt.invoice_export).toBeTruthy();
  });

  it("is refused with the blockers (409) when the job isn't ready — nothing claimed, nothing sent, nothing journalled", async () => {
    connection = { ...connection!, granted_scopes: "openid payroll.timesheets" };
    const s = await addStage();
    const before = journal().length;
    const r = await send(s.id);
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ error: "blocked" });
    expect((r.body as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code)).toEqual(["xero_not_ready"]);
    expect(row(s.id)).toMatchObject({ state: "planned", seq: null });
    expect(xero.calls).toEqual([]);
    expect(journal()).toHaveLength(before);
  });

  it("a double press: the second request is refused at the claim and Xero is created in once", async () => {
    const s = await addStage();
    const [a, b] = await Promise.all([send(s.id), send(s.id)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(["stage_not_editable", "stale_version"]).toContain((loser.body as { error: string }).error);
    expect(xero.puts()).toHaveLength(1);
    expect(xero.invoices).toHaveLength(1);
  });

  it("Xero refuses it: 200 with outcome failed and Xero's sentence; journalled; open on the sync log", async () => {
    const s = await addStage();
    xero.failNext("validation", "Account code '999' is not a valid code for this document.");
    const p = SendResponseSchema.parse((await send(s.id)).body);
    expect(p.send).toMatchObject({ outcome: "failed", category: "validation", detail: "Account code '999' is not a valid code for this document.", invoiceNumber: "IV3345-1" });
    expect(p.stages[0]).toMatchObject({ state: "failed", display: "failed", failureCategory: "validation" });
    expect(p.totals).toMatchObject({ sentCount: 0, claimedCents: 0 });
    expect(journal().at(-1)).toMatchObject({ action: "customer_invoice.send_failed", metadata: { outcome: "failed", category: "validation", invoiceNumber: "IV3345-1" } });
    const open = await syncLog.openState();
    expect(open.items).toHaveLength(1);
    expect(open.items[0]).toMatchObject({ syncType: "invoice_export", operation: `inv:${s.id}`, recordRef: "IV3345-1", category: "validation" });
  });

  it("no answer from Xero: outcome unknown, the stage stays 'sending', and the check adopts it without a second create", async () => {
    const s = await addStage();
    xero.failNext("timeout_after");
    const p = SendResponseSchema.parse((await send(s.id)).body);
    expect(p.send).toMatchObject({ outcome: "unknown", category: "timeout" });
    expect(p.stages[0]).toMatchObject({ state: "sending", display: "sending", failureCategory: "timeout" });

    const checked = SendResponseSchema.parse((await post("retry", s.id)).body);
    expect(checked.send).toMatchObject({ outcome: "adopted", verified: true, invoiceNumber: "IV3345-1" });
    expect(checked.stages[0]).toMatchObject({ state: "sent", display: "draft_in_xero" });
    expect(xero.puts()).toHaveLength(1);
    expect(xero.invoices).toHaveLength(1);
    expect(journal().slice(-2).map((e) => e.action)).toEqual(["customer_invoice.send_failed", "customer_invoice.send_retried"]);
    // the adopt closed the open sync-log item
    expect((await syncLog.openState()).items).toEqual([]);
  });

  it("a Xero outage on the look-up answers a stable xero_ error and leaves the stage as it was", async () => {
    const s = await addStage();
    xero.failNext("timeout_before");
    await send(s.id);
    const { XeroError } = requireFromHere("../../../api/_lib/xero/errors.js");
    const real = xero.xeroFetch;
    xero.xeroFetch = async () => { throw new XeroError("server", { status: 503 }); };
    const r = await post("retry", s.id);
    xero.xeroFetch = real;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: "xero_server" });
    expect(row(s.id).state).toBe("sending");
  });
});

describe("api/customer-invoices — the sync health panel's Retry travels the same guarded path", () => {
  it("retrying an unknown send from the sync log adopts what Xero has", async () => {
    const s = await addStage();
    xero.failNext("timeout_after");
    await send(s.id);
    const out = await syncLog.retry(`inv:${s.id}`);
    expect(out.outcome).toBe("resolved");
    expect(row(s.id).state).toBe("sent");
    expect(xero.puts()).toHaveLength(1);
  });

  it("…and says 'resolved meanwhile' when the stage has since been sent or put back", async () => {
    const s = await addStage();
    xero.failNext("validation");
    await send(s.id);
    await post("reset", s.id);
    const out = await syncLog.retry(`inv:${s.id}`);
    expect(out.outcome).toBe("resolved_meanwhile");
    expect(xero.puts()).toHaveLength(1);
  });
});

describe("api/customer-invoices — reset and raise again", () => {
  it("reset puts a refused stage back to planned (editable again) once Xero confirms nothing is there", async () => {
    const s = await addStage();
    xero.failNext("validation");
    await send(s.id);
    const p = SendResponseSchema.parse((await post("reset", s.id)).body);
    expect(p.send.outcome).toBe("reset");
    expect(p.stages[0]).toMatchObject({ state: "planned", display: "planned", invoiceNumber: null });
    expect(journal().at(-1)).toMatchObject({ action: "customer_invoice.send_reset" });
    // …and it can be edited and sent again
    const edit = await call({ method: "POST", query: { action: "stage-edit", id: s.id }, body: { stage: { title: "Deposit", basis: "percent", percentBp: 2500 }, expectedVersion: row(s.id).version } });
    expect(edit.statusCode).toBe(200);
    const again = SendResponseSchema.parse((await send(s.id)).body);
    expect(again.send).toMatchObject({ outcome: "sent", invoiceNumber: "IV3345-1" });
    expect(xero.invoices[0]!.SubTotal).toBe(62500);
  });

  it("raise again is only for a number Xero says is taken; it burns the number and adds a planned copy", async () => {
    const s = await addStage();
    expect((await post("raise-again", s.id)).body).toEqual({ error: "not_raisable" }); // a planned stage
    xero.seed({ InvoiceNumber: "IV3345-1" });
    const failed = SendResponseSchema.parse((await send(s.id)).body);
    expect(failed.send).toMatchObject({ outcome: "failed", category: "number_taken" });

    const r = await post("raise-again", s.id);
    expect(r.statusCode).toBe(201);
    const p = JobInvoicingResponseSchema.parse(r.body);
    expect(p.stages).toHaveLength(1); // the burned one is gone from the list
    expect(p.stages[0]).toMatchObject({ state: "planned", title: "Deposit", invoiceNumber: null });
    expect(p.stages[0]!.id).not.toBe(s.id);
    expect(row(s.id)).toMatchObject({ state: "cancelled", invoiceNumber: "IV3345-1" });
    expect(journal().at(-1)).toMatchObject({ action: "customer_invoice.raised_again", metadata: { burnedNumber: "IV3345-1", replaces: s.id } });

    const sent = SendResponseSchema.parse((await send(p.stages[0]!.id)).body);
    expect(sent.send).toMatchObject({ outcome: "sent", invoiceNumber: "IV3345-2" });
  });

  it("a refused stage whose number is NOT taken can't be raised again (use Try again / Edit and resend)", async () => {
    const s = await addStage();
    xero.failNext("validation");
    await send(s.id);
    expect((await post("raise-again", s.id)).statusCode).toBe(409);
    expect(row(s.id).state).toBe("failed");
  });
});

describe("api/customer-invoices — retention held and released", () => {
  beforeEach(async () => {
    await mem.saveProfile({}, "t1", "tower", { retentionBp: 500 }, { expectedVersion: 1 });
  });

  it("holds retention on a sent stage, then releases it as its own invoice with no retention taken off", async () => {
    const s = await addStage({ title: "Rough-in", basis: "amount", amountCents: 100_000_00 });
    const sent = SendResponseSchema.parse((await send(s.id)).body);
    expect(xero.invoices[0]!.LineItems.map((l) => l.UnitAmount)).toEqual([100000, -5000]);
    expect(sent.totals).toMatchObject({ claimedCents: 100_000_00, retentionHeldCents: 5_000_00, stillToInvoiceCents: 150_000_00 });

    const r = await call({ method: "POST", query: { action: "retention-release" }, body: { jobId: "tower", amountCents: 5_000_00 } });
    expect(r.statusCode).toBe(201);
    const release = JobInvoicingResponseSchema.parse(r.body).stages.find((x) => x.kind === "retention_release")!;
    expect(release).toMatchObject({ state: "planned", title: "Retention release" });
    expect(release.computed).toMatchObject({ grossCents: 5_000_00, retentionCents: 0, netCents: 5_000_00 });

    const done = SendResponseSchema.parse((await send(release.id)).body);
    expect(done.send).toMatchObject({ outcome: "sent", invoiceNumber: "IV3345-2", verified: true });
    expect(xero.invoices[1]!.LineItems.map((l) => l.UnitAmount)).toEqual([5000]);
    // released: nothing held any more, and a release is not a new claim on the contract
    expect(done.totals).toMatchObject({ claimedCents: 100_000_00, retentionHeldCents: 0, stillToInvoiceCents: 150_000_00 });
  });

  it("refuses to release more than is held — counting releases already planned", async () => {
    const s = await addStage({ title: "Rough-in", basis: "amount", amountCents: 100_000_00 });
    await send(s.id);
    const over = await call({ method: "POST", query: { action: "retention-release" }, body: { jobId: "tower", amountCents: 5_000_01 } });
    expect(over.statusCode).toBe(409);
    expect(over.body).toEqual({ error: "exceeds_retention_held", heldCents: 5_000_00, alreadyPlannedCents: 0 });
    await call({ method: "POST", query: { action: "retention-release" }, body: { jobId: "tower", amountCents: 3_000_00 } });
    const second = await call({ method: "POST", query: { action: "retention-release" }, body: { jobId: "tower", amountCents: 2_000_01 } });
    expect(second.body).toEqual({ error: "exceeds_retention_held", heldCents: 5_000_00, alreadyPlannedCents: 3_000_00 });
    expect((await call({ method: "POST", query: { action: "retention-release" }, body: { jobId: "tower", amountCents: 2_000_00 } })).statusCode).toBe(201);
  });

  it("nothing can be released when nothing is held", async () => {
    const r = await call({ method: "POST", query: { action: "retention-release" }, body: { jobId: "tower", amountCents: 100 } });
    expect(r.statusCode).toBe(409);
  });
});
