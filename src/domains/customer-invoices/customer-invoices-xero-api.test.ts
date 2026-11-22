import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "@/domains/audit-log/schema";
import {
  ContactSearchResponseSchema,
  InvoiceSettingsOptionsSchema,
  InvoiceSettingsResponseSchema,
  JobInvoicingResponseSchema,
} from "./schema";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * api/customer-invoices.js — the Xero set-up routes (#1149): where a job
 * stands with Xero, the client link, and the invoice defaults. The REAL
 * handler and the REAL lookups module run; only the stored connection
 * (token-store), the Xero HTTP call (client.xeroFetch), Blob and the Postgres
 * store are stand-ins. Every Xero call these routes make is a GET.
 */
const requireFromHere = createRequire(import.meta.url);
const resolve = (p: string) => requireFromHere.resolve(p);
const blobPath = resolve("../../../api/_lib/blob.js");
const authPath = resolve("../../../api/_lib/auth.js");
const flagsPath = resolve("../../../api/_lib/feature-flags.js");
const auditPath = resolve("../../../api/_lib/audit-log.js");
const dbPath = resolve("../../../api/_lib/supabase-db.js");
const storePath = resolve("../../../api/_lib/customer-invoices/store.js");
const lookupsPath = resolve("../../../api/_lib/customer-invoices/xero-lookups.js");
const tokenStorePath = resolve("../../../api/_lib/xero/token-store.js");
const clientPath = resolve("../../../api/_lib/xero/client.js");
const handlerPath = resolve("../../../api/customer-invoices.js");
const { XeroError } = requireFromHere("../../../api/_lib/xero/errors.js");

const BASE_SCOPES = "openid profile email offline_access payroll.employees.read payroll.settings.read accounting.settings.read";
const INVOICE_SCOPES = `${BASE_SCOPES} accounting.invoices accounting.contacts.read`;
const BUILT = "11111111-1111-4111-8111-111111111111";
const ACME = "22222222-2222-4222-8222-222222222222";
const ARCHIVED = "33333333-3333-4333-8333-333333333333";

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let mem: MemoryStore;
let dbMode: string[];
let connection: Record<string, unknown> | null;
let connectionThrows: boolean;
let xeroFetch: ReturnType<typeof vi.fn>;
let xeroAnswers: Record<string, unknown>;

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
function cookieFor(userId: string, role: string) {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(opts: { method?: string; role?: string; userId?: string; anonymous?: boolean; query?: Record<string, string>; body?: unknown }): Promise<Res> {
  const res = createRes();
  await handler({
    method: opts.method || "GET",
    query: opts.query || {},
    body: opts.body,
    headers: opts.anonymous ? {} : { cookie: cookieFor(opts.userId || "u_admin", opts.role || "admin") },
  }, res);
  return res;
}
const job = async (jobId = "tower") => JobInvoicingResponseSchema.parse((await call({ query: { jobId } })).body);
const link = (contactId: string, expectedVersion: number | null, jobId = "tower") =>
  call({ method: "PUT", query: { action: "contact-link" }, body: { jobId, contactId, expectedVersion } });
const saveSettings = (body: Record<string, unknown>) => call({ method: "PUT", query: { action: "settings" }, body });
const xeroUrls = () => xeroFetch.mock.calls.map((c) => String(c[0]));
function journal() {
  const out: Array<{ action: string; targetType: string; targetId: string; jobId?: string; summary: string; metadata?: Record<string, unknown> }> = [];
  for (const [k, v] of blob) if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  return out;
}

const connected = (over: Record<string, unknown> = {}) => ({
  status: "connected", external_tenant_id: "org-1", external_tenant_name: "Buhl Electrical", granted_scopes: INVOICE_SCOPES, ...over,
});

beforeEach(() => {
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
      { id: "tower2", name: "Tower Level 14", code: "IV3350", clientName: "  built  PTY ltd ", status: "active" },
      { id: "shop", name: "Corner Shop", code: "IV7001", clientName: "Acme Retail", status: "active" },
      { id: "noclient", name: "No Client Job", code: "IV7002", status: "active" },
      { id: "gone", name: "Deleted", clientName: "Built Pty Ltd", status: "active", deleted: true },
    ] }],
    ["users.json", { users: [
      { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      { id: "u_lh", username: "lead", name: "Lead Hand", role: "leadingHand", assignedJobIds: ["tower"] },
    ] }],
  ]);
  mem = createMemoryStore();
  dbMode = [];
  connection = connected();
  connectionThrows = false;
  xeroAnswers = {
    [`/Contacts/${BUILT}`]: { Contacts: [{ ContactID: BUILT, Name: "Built Pty Ltd", ContactStatus: "ACTIVE", EmailAddress: "accounts@built.example" }] },
    [`/Contacts/${ACME}`]: { Contacts: [{ ContactID: ACME, Name: "Acme Retail Group", ContactStatus: "ACTIVE" }] },
    [`/Contacts/${ARCHIVED}`]: { Contacts: [{ ContactID: ARCHIVED, Name: "Old Client", ContactStatus: "ARCHIVED" }] },
    "/Contacts/": new XeroError("not_found", { status: 404 }),
    "/Contacts?": { Contacts: [
      { ContactID: BUILT, Name: "Built Pty Ltd", ContactStatus: "ACTIVE", EmailAddress: "accounts@built.example", Phones: [{ PhoneNumber: "5550100" }] },
      { ContactID: ARCHIVED, Name: "Built (old)", ContactStatus: "ARCHIVED" },
    ] },
    "/Accounts": { Accounts: [
      { Code: "200", Name: "Sales", Class: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT" },
      { Code: "260", Name: "Other Revenue", Class: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT" },
      { Code: "400", Name: "Advertising", Class: "EXPENSE", Status: "ACTIVE" },
    ] },
    "/TaxRates": { TaxRates: [
      { Name: "GST on Income", TaxType: "OUTPUT", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: "10.0000" },
      { Name: "GST Free Income", TaxType: "EXEMPTOUTPUT", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: "0.0000" },
      { Name: "GST on Expenses", TaxType: "INPUT", Status: "ACTIVE", CanApplyToRevenue: false, EffectiveRate: "10.0000" },
    ] },
  };
  xeroFetch = vi.fn(async (url: string, opts: { method?: string } = {}) => {
    if (opts.method && opts.method !== "GET") throw new Error(`these routes must only READ from Xero, got ${opts.method}`);
    for (const [needle, data] of Object.entries(xeroAnswers)) {
      if (url.includes(needle)) {
        if (data instanceof Error) throw data;
        return { data: clone(data), correlationId: null };
      }
    }
    throw new Error(`unexpected Xero URL ${url}`);
  });

  for (const p of [authPath, flagsPath, auditPath, lookupsPath, handlerPath]) delete requireFromHere.cache[p];
  const mock = (path: string, exports: unknown) => {
    requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
  };
  mock(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
    writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
    setNoCache: vi.fn(),
  });
  mock(dbPath, { getDb: (o: { mode: string }) => { dbMode.push(o.mode); return {}; } });
  mock(storePath, mem);
  mock(tokenStorePath, {
    getConnection: vi.fn(async () => {
      if (connectionThrows) throw new Error("connection table unreadable");
      return connection ? { ...connection } : null;
    }),
  });
  mock(clientPath, { xeroFetch });
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.FLAG_CUSTOMER_INVOICES;
});

describe("api/customer-invoices — gating of the Xero routes", () => {
  const probes: Array<Parameters<typeof call>[0]> = [
    { query: { action: "contacts", q: "built" } },
    { method: "PUT", query: { action: "contact-link" }, body: { jobId: "tower", contactId: BUILT, expectedVersion: null } },
    { method: "PUT", query: { action: "contact-unlink" }, body: { jobId: "tower", expectedVersion: 1 } },
    { query: { action: "settings" } },
    { query: { action: "settings-options" } },
    { method: "PUT", query: { action: "settings" }, body: { salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: 30, expectedVersion: null } },
  ];

  it("404s every route while the flag is off, and never reaches Xero", async () => {
    delete process.env.FLAG_CUSTOMER_INVOICES;
    for (const p of probes) expect((await call(p)).statusCode).toBe(404);
    expect(xeroFetch).not.toHaveBeenCalled();
    expect(dbMode).toEqual([]);
  });

  it("401s with no session and stays invisible below the office tier, never reaching Xero", async () => {
    for (const p of probes) expect((await call({ ...p, anonymous: true })).statusCode).toBe(401);
    for (const p of probes) expect((await call({ ...p, userId: "u_lh", role: "leadingHand" })).statusCode).toBe(404);
    expect(xeroFetch).not.toHaveBeenCalled();
    expect(mem.profiles.size).toBe(0);
    expect(mem.settings.size).toBe(0);
  });

  it("opens the database for WRITING on the two reads that call Xero (a token refresh is a write)", async () => {
    await call({ query: { action: "contacts", q: "built" } });
    await call({ query: { action: "settings-options" } });
    await call({ query: { action: "settings" } });
    await call({ query: { jobId: "tower" } });
    expect(dbMode).toEqual(["write", "write", "read", "read"]);
  });
});

describe("api/customer-invoices — where a job stands with Xero", () => {
  it("connected, nothing chosen: usable, defaults incomplete, client not linked — and no Xero call to say so", async () => {
    const p = await job();
    expect(p.xero).toEqual({
      state: "connected", organisationName: "Buhl Electrical", settingsComplete: false,
      client: { linked: false, name: null, otherOrganisation: false, suggestion: null },
    });
    expect(xeroFetch).not.toHaveBeenCalled();
  });

  it("names each reason Xero can't be used yet", async () => {
    const stateWith = async (c: Record<string, unknown> | null) => { connection = c; return (await job()).xero.state; };
    expect(await stateWith(null)).toBe("disconnected");
    expect(await stateWith(connected({ granted_scopes: BASE_SCOPES }))).toBe("missing_permission");
    expect(await stateWith(connected({ granted_scopes: `${BASE_SCOPES} payroll.timesheets` }))).toBe("missing_permission");
    expect(await stateWith(connected({ status: "reconnect_required" }))).toBe("reconnect_required");
    expect(await stateWith(connected({ status: "pending_selection", external_tenant_id: null }))).toBe("connecting");
    delete process.env.XERO_CLIENT_ID;
    expect(await stateWith(connected())).toBe("not_configured");
  });

  it("the schedule still loads when the connection can't be read at all", async () => {
    connectionThrows = true;
    await call({ method: "POST", query: { action: "stage-add" }, body: { jobId: "tower", stage: { title: "Deposit", basis: "percent", percentBp: 2000 } } });
    const p = await job();
    expect(p.xero.state).toBe("unavailable");
    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.computed.grossCents).toBe(50_000_00);
  });
});

describe("api/customer-invoices — contact search", () => {
  it("returns id and name only, active contacts only", async () => {
    const r = await call({ query: { action: "contacts", q: "built" } });
    expect(r.statusCode).toBe(200);
    expect(ContactSearchResponseSchema.parse(r.body).contacts).toEqual([{ id: BUILT, name: "Built Pty Ltd" }]);
    expect(JSON.stringify(r.body)).not.toContain("accounts@built.example");
    expect(JSON.stringify(r.body)).not.toContain("5550100");
  });

  it("a short query answers an empty list without calling Xero", async () => {
    const r = await call({ query: { action: "contacts", q: "b" } });
    expect(r.body).toEqual({ contacts: [] });
    expect(xeroFetch).not.toHaveBeenCalled();
  });

  it("refuses before calling Xero when the connection can't do invoices, and says why", async () => {
    connection = connected({ granted_scopes: BASE_SCOPES });
    let r = await call({ query: { action: "contacts", q: "built" } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: "xero_reconnect_required", reason: "missing_invoice_scope" });

    connection = null;
    r = await call({ query: { action: "contacts", q: "built" } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: "xero_not_connected" });

    connection = connected({ status: "reconnect_required" });
    r = await call({ query: { action: "contacts", q: "built" } });
    expect(r.body).toEqual({ error: "xero_reconnect_required" });
    expect(xeroFetch).not.toHaveBeenCalled();
  });

  it("turns a Xero failure into a stable code and status — never the exception text", async () => {
    xeroAnswers["/Contacts?"] = new XeroError("rate_limit", { status: 429, retryAfterSeconds: 42 });
    let r = await call({ query: { action: "contacts", q: "built" } });
    expect(r.statusCode).toBe(429);
    expect(r.body).toEqual({ error: "xero_rate_limit", retryAfterSeconds: 42 });

    xeroAnswers["/Contacts?"] = new XeroError("server", { status: 503, detail: "secret-internal-detail" });
    r = await call({ query: { action: "contacts", q: "built" } });
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: "xero_server" });
  });
});

describe("api/customer-invoices — linking the job's client", () => {
  it("links to the contact Xero holds, storing XERO's name and the organisation", async () => {
    const r = await link(BUILT, null);
    expect(r.statusCode).toBe(200);
    const p = JobInvoicingResponseSchema.parse(r.body);
    expect(p.xero.client).toEqual({ linked: true, name: "Built Pty Ltd", otherOrganisation: false, suggestion: null });
    expect(p.profile).toMatchObject({ xeroContactId: BUILT, xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", version: 1 });
    // exactly one Xero call, a read of that one contact
    expect(xeroUrls()).toEqual([`https://api.xero.com/api.xro/2.0/Contacts/${BUILT}`]);
  });

  it("ignores any name the browser sends — an unknown field is refused outright", async () => {
    const r = await call({ method: "PUT", query: { action: "contact-link" }, body: { jobId: "tower", contactId: BUILT, contactName: "Mallory Ltd", expectedVersion: null } });
    expect(r.statusCode).toBe(400);
    expect(mem.profiles.size).toBe(0);
  });

  it("refuses a contact Xero doesn't have, an archived one, and a malformed id", async () => {
    const missing = await link("99999999-9999-4999-8999-999999999999", null);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ error: "contact_not_found" });
    const archived = await link(ARCHIVED, null);
    expect(archived.statusCode).toBe(409);
    expect(archived.body).toEqual({ error: "contact_not_active" });
    expect((await link("not-a-uuid", null)).statusCode).toBe(400);
    expect(mem.profiles.size).toBe(0);
  });

  it("keeps the job's retention when the client is linked, and the link when retention changes", async () => {
    await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 500, expectedVersion: null } });
    let p = JobInvoicingResponseSchema.parse((await link(BUILT, 1)).body);
    expect(p.profile).toMatchObject({ retentionBp: 500, xeroContactId: BUILT, version: 2 });
    p = JobInvoicingResponseSchema.parse((await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 250, expectedVersion: 2 } })).body);
    expect(p.profile).toMatchObject({ retentionBp: 250, xeroContactId: BUILT, xeroContactName: "Built Pty Ltd", version: 3 });
  });

  it("a stale link (someone else changed the job's set-up) is refused", async () => {
    await link(BUILT, null);
    const r = await link(ACME, null);
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: "stale_version" });
    expect(mem.profiles.get("tower")).toMatchObject({ xeroContactId: BUILT });
  });

  it("changing the link replaces it; removing it clears all three fields", async () => {
    await link(BUILT, null);
    let p = JobInvoicingResponseSchema.parse((await link(ACME, 1)).body);
    expect(p.xero.client).toMatchObject({ linked: true, name: "Acme Retail Group" });
    const r = await call({ method: "PUT", query: { action: "contact-unlink" }, body: { jobId: "tower", expectedVersion: 2 } });
    expect(r.statusCode).toBe(200);
    p = JobInvoicingResponseSchema.parse(r.body);
    expect(p.xero.client.linked).toBe(false);
    expect(p.profile).toMatchObject({ xeroContactId: null, xeroContactName: null, externalTenantId: null, version: 3 });
  });

  it("can't link while Xero can't do invoices, and can't link a job that doesn't exist", async () => {
    expect((await link(BUILT, null, "nope")).statusCode).toBe(404);
    expect((await link(BUILT, null, "gone")).statusCode).toBe(404);
    connection = connected({ granted_scopes: BASE_SCOPES });
    const r = await link(BUILT, null);
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: "xero_reconnect_required", reason: "missing_invoice_scope" });
    expect(mem.profiles.size).toBe(0);
  });

  it("flags a link made in a different Xero organisation than the one connected now", async () => {
    await link(BUILT, null);
    connection = connected({ external_tenant_id: "org-2", external_tenant_name: "Other Org" });
    const p = await job();
    expect(p.xero).toMatchObject({ state: "connected", organisationName: "Other Org" });
    expect(p.xero.client).toMatchObject({ linked: true, name: "Built Pty Ltd", otherOrganisation: true });
  });

  it("offers — never applies — the contact another job with the same client name uses", async () => {
    await link(BUILT, null, "tower");
    // same client, written differently ("  built  PTY ltd ")
    const sibling = await job("tower2");
    expect(sibling.xero.client).toEqual({ linked: false, name: null, otherOrganisation: false, suggestion: { id: BUILT, name: "Built Pty Ltd" } });
    expect(mem.profiles.has("tower2")).toBe(false);
    // a different client, and a job with no client name, get no suggestion
    expect((await job("shop")).xero.client.suggestion).toBeNull();
    expect((await job("noclient")).xero.client.suggestion).toBeNull();
  });

  it("offers no suggestion from another organisation, or while Xero isn't usable", async () => {
    await link(BUILT, null, "tower");
    connection = connected({ external_tenant_id: "org-2" });
    expect((await job("tower2")).xero.client.suggestion).toBeNull();
    connection = connected({ granted_scopes: BASE_SCOPES });
    expect((await job("tower2")).xero.client.suggestion).toBeNull();
  });
});

describe("api/customer-invoices — invoice defaults", () => {
  it("starts with nothing saved and says so", async () => {
    const r = await call({ query: { action: "settings" } });
    expect(InvoiceSettingsResponseSchema.parse(r.body)).toEqual({
      xero: { state: "connected", organisationName: "Buhl Electrical" }, settings: null, complete: false,
    });
    expect(xeroFetch).not.toHaveBeenCalled();
  });

  it("lists what an invoice line can use, live from Xero", async () => {
    const o = InvoiceSettingsOptionsSchema.parse((await call({ query: { action: "settings-options" } })).body);
    expect(o.accounts.map((a) => a.code)).toEqual(["200", "260"]);
    expect(o.taxRates).toEqual([
      { taxType: "EXEMPTOUTPUT", name: "GST Free Income", rateBp: 0 },
      { taxType: "OUTPUT", name: "GST on Income", rateBp: 1000 },
    ]);
  });

  it("saves the choices with Xero's own names and rate, and the job then reads as complete", async () => {
    const r = await saveSettings({ salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: 30, expectedVersion: null });
    expect(r.statusCode).toBe(200);
    const s = InvoiceSettingsResponseSchema.parse(r.body);
    expect(s.complete).toBe(true);
    expect(s.settings).toMatchObject({
      salesAccountCode: "200", salesAccountName: "Sales", taxType: "OUTPUT", taxName: "GST on Income", taxRateBp: 1000, paymentTermsDays: 30, version: 1,
    });
    expect((await job()).xero.settingsComplete).toBe(true);
  });

  it("refuses an account or tax rate Xero doesn't offer for sales — nothing made up is stored", async () => {
    const expense = await saveSettings({ salesAccountCode: "400", taxType: "OUTPUT", paymentTermsDays: 30, expectedVersion: null });
    expect(expense.statusCode).toBe(409);
    expect(expense.body).toEqual({ error: "account_not_in_xero" });
    const purchaseTax = await saveSettings({ salesAccountCode: "200", taxType: "INPUT", paymentTermsDays: 30, expectedVersion: null });
    expect(purchaseTax.body).toEqual({ error: "tax_rate_not_in_xero" });
    expect(mem.settings.size).toBe(0);
  });

  it("validates the body: terms 0–365 whole days, no extra fields, no names from the browser", async () => {
    const bad = [
      { salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: -1, expectedVersion: null },
      { salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: 366, expectedVersion: null },
      { salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: 30.5, expectedVersion: null },
      { salesAccountCode: "", taxType: "OUTPUT", paymentTermsDays: 30, expectedVersion: null },
      { salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: 30 },
      { salesAccountCode: "200", salesAccountName: "Fake", taxType: "OUTPUT", paymentTermsDays: 30, expectedVersion: null },
      { salesAccountCode: "200", taxType: "OUTPUT", taxRateBp: 0, paymentTermsDays: 30, expectedVersion: null },
    ];
    for (const b of bad) expect((await saveSettings(b)).statusCode).toBe(400);
    expect(mem.settings.size).toBe(0);
    expect(xeroFetch).not.toHaveBeenCalled();
  });

  it("0 days is a real choice (due on the invoice date), and a second save needs the current version", async () => {
    const first = InvoiceSettingsResponseSchema.parse((await saveSettings({ salesAccountCode: "200", taxType: "EXEMPTOUTPUT", paymentTermsDays: 0, expectedVersion: null })).body);
    expect(first.settings).toMatchObject({ paymentTermsDays: 0, taxRateBp: 0 });
    expect(first.complete).toBe(true);
    expect((await saveSettings({ salesAccountCode: "260", taxType: "OUTPUT", paymentTermsDays: 14, expectedVersion: null })).statusCode).toBe(409);
    const second = InvoiceSettingsResponseSchema.parse((await saveSettings({ salesAccountCode: "260", taxType: "OUTPUT", paymentTermsDays: 14, expectedVersion: 1 })).body);
    expect(second.settings).toMatchObject({ salesAccountCode: "260", salesAccountName: "Other Revenue", paymentTermsDays: 14, version: 2 });
  });

  it("defaults belong to one Xero organisation: another organisation starts empty", async () => {
    await saveSettings({ salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: 30, expectedVersion: null });
    connection = connected({ external_tenant_id: "org-2", external_tenant_name: "Other Org" });
    const s = InvoiceSettingsResponseSchema.parse((await call({ query: { action: "settings" } })).body);
    expect(s).toEqual({ xero: { state: "connected", organisationName: "Other Org" }, settings: null, complete: false });
    expect((await job()).xero.settingsComplete).toBe(false);
  });

  it("can't read options or save while Xero can't do invoices", async () => {
    connection = connected({ granted_scopes: BASE_SCOPES });
    expect((await call({ query: { action: "settings-options" } })).body).toEqual({ error: "xero_reconnect_required", reason: "missing_invoice_scope" });
    expect((await saveSettings({ salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: 30, expectedVersion: null })).statusCode).toBe(409);
    // …but the settings read itself still answers, with the reason
    const s = InvoiceSettingsResponseSchema.parse((await call({ query: { action: "settings" } })).body);
    expect(s.xero.state).toBe("missing_permission");
    expect(xeroFetch).not.toHaveBeenCalled();
  });
});

describe("api/customer-invoices — audit journal for the Xero set-up", () => {
  it("journals the link, the unlink and the defaults with registered verbs", async () => {
    await link(BUILT, null);
    await call({ method: "PUT", query: { action: "contact-unlink" }, body: { jobId: "tower", expectedVersion: 1 } });
    await saveSettings({ salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: 30, expectedVersion: null });
    const entries = journal();
    expect(entries.map((e) => e.action)).toEqual([
      "customer_invoice.profile_updated",
      "customer_invoice.profile_updated",
      "customer_invoice.settings_updated",
    ]);
    for (const e of entries) {
      expect(AUDIT_ACTIONS).toContain(e.action);
      expect(e.targetType).toBe("customer_invoice");
    }
    expect(entries[0]).toMatchObject({ jobId: "tower", targetId: "tower", metadata: { fields: ["xeroContact"], xeroContactId: BUILT } });
    expect(entries[0]!.summary).toContain("Built Pty Ltd");
    expect(entries[2]).toMatchObject({ targetId: "settings", metadata: { salesAccountCode: "200", taxType: "OUTPUT", paymentTermsDays: 30 } });
  });

  it("writes nothing for a refused link or a refused save", async () => {
    await link(ARCHIVED, null);
    await saveSettings({ salesAccountCode: "400", taxType: "OUTPUT", paymentTermsDays: 30, expectedVersion: null });
    expect(journal()).toEqual([]);
  });
});
