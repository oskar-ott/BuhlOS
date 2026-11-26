import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobInvoicingResponseSchema, NO_JOB_ID, SendPreviewSchema, SendResponseSchema } from "./schema";
import { createFakeXero, type FakeXero } from "./test-helpers/fake-xero";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * api/customer-invoices.js — an invoice with NO job (#1166). The REAL handler,
 * the REAL send service, the REAL lookups and the REAL sync-log recorder run;
 * the stored connection, the Xero HTTP call (a stand-in Xero that keeps
 * invoices and answers for two contacts), Blob and the Postgres store are
 * stand-ins. The real SQL is in customer-invoices-no-job.pg.test.ts.
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
const BUILT = "11111111-1111-4111-8111-111111111111";
const ARCHIVED = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let syncLog: { retry: (operation: string) => Promise<{ outcome: string; reason?: string }> };
let mem: MemoryStore;
let xero: FakeXero;
let connection: Record<string, unknown> | null;
/** GETs of a single contact that reached "Xero". */
let contactReads: string[];

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
const err = (r: Res) => (r.body as { error?: string }).error;
const charge = (over: Record<string, unknown> = {}) => ({ type: "line", description: "Progress claim 4", quantityMilli: 1000, unit: "ea", unitCents: 1250000, ...over });
const stageOf = (over: Record<string, unknown> = {}) => ({ kind: "itemised", title: "Progress claim, November 2026", items: [charge()], contactId: BUILT, ...over });
const add = (over: Record<string, unknown> = {}, jobId: string = NO_JOB_ID) =>
  call({ method: "POST", query: { action: "stage-add" }, body: { jobId, stage: stageOf(over) } });
async function added(over: Record<string, unknown> = {}) {
  const r = await add(over);
  expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
  const p = JobInvoicingResponseSchema.parse(r.body);
  return p.stages[p.stages.length - 1]!;
}
const ledger = async () => JobInvoicingResponseSchema.parse((await call({ query: { jobId: NO_JOB_ID } })).body);
const send = (id: string, body: Record<string, unknown> = {}) => post("send", id, { expectedVersion: row(id).version, invoiceDate: "2026-11-25", ...body });
function journal() {
  const out: Array<{ action: string; targetId: string; jobId?: string | null; summary: string; metadata?: Record<string, unknown> }> = [];
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
    ] }],
    ["users.json", { users: [
      { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      { id: "u_lh", username: "lead", name: "Lead Hand", role: "leadingHand", assignedJobIds: ["tower"] },
    ] }],
  ]);
  mem = createMemoryStore();
  xero = createFakeXero();
  contactReads = [];
  connection = { status: "connected", external_tenant_id: "org-1", external_tenant_name: "Buhl Electrical", granted_scopes: SCOPES };
  await mem.saveProfile({}, "t1", "tower", { xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", retentionBp: 0 }, { expectedVersion: null });
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
  const { XeroError } = requireFromHere("../../../api/_lib/xero/errors.js");
  mock(clientPath, {
    // The stand-in Xero keeps invoices; contacts are answered here.
    xeroFetch: async (url: string, opts: Record<string, unknown>) => {
      const m = /\/Contacts\/([0-9a-f-]{36})$/i.exec(new URL(url).pathname);
      if (!m) return xero.xeroFetch(url, opts);
      contactReads.push(m[1]!);
      if (m[1] === BUILT) return { data: { Contacts: [{ ContactID: BUILT, Name: "Built Pty Ltd", ContactStatus: "ACTIVE" }] } };
      if (m[1] === OTHER) return { data: { Contacts: [{ ContactID: OTHER, Name: "Hutchinson Builders", ContactStatus: "ACTIVE" }] } };
      if (m[1] === ARCHIVED) return { data: { Contacts: [{ ContactID: ARCHIVED, Name: "Old Client", ContactStatus: "ARCHIVED" }] } };
      throw new XeroError("not_found", { status: 404 });
    },
  });
  auth = requireFromHere(resolve("../../../api/_lib/auth.js"));
  syncLog = requireFromHere(resolve("../../../api/_lib/xero-sync-log.js"));
  handler = requireFromHere(resolve("../../../api/customer-invoices.js"));
});

afterEach(() => {
  delete process.env.FLAG_CUSTOMER_INVOICES;
});

describe("an invoice with no job — who may see it", () => {
  it("flag off → 404, no session → 401, below the office tier → 404, and Xero is never called", async () => {
    const probes: Array<Parameters<typeof call>[0]> = [
      { query: { jobId: NO_JOB_ID } },
      { method: "POST", query: { action: "stage-add" }, body: { jobId: NO_JOB_ID, stage: stageOf() } },
      { method: "POST", query: { action: "refresh" }, body: { jobId: NO_JOB_ID } },
    ];
    for (const p of probes) expect((await call({ ...p, anonymous: true })).statusCode).toBe(401);
    for (const p of probes) expect((await call({ ...p, userId: "u_lh", role: "leadingHand" })).statusCode).toBe(404);
    delete process.env.FLAG_CUSTOMER_INVOICES;
    for (const p of probes) expect((await call(p)).statusCode).toBe(404);
    expect(xero.calls).toEqual([]);
    expect(contactReads).toEqual([]);
    expect(mem.rows).toEqual([]);
  });

  it("the ledger id can never be a job's id", () => {
    const { slugify } = requireFromHere("../../../api/_lib/job-fields.js");
    expect(slugify(NO_JOB_ID)).toBe("no-job");
    expect(slugify(NO_JOB_ID)).not.toBe(NO_JOB_ID);
    const noJob = requireFromHere("../../../api/_lib/customer-invoices/no-job.js");
    expect(noJob.NO_JOB_ID).toBe(NO_JOB_ID);
    expect(noJob.numberFor(1)).toBe("GEN-0001");
    expect(noJob.numberFor(12345)).toBe("GEN-12345");
    expect(() => noJob.numberFor(0)).toThrow();
  });

  it("a job that really is called 'no job' is an ordinary job, not the ledger", async () => {
    blob.set("jobs.json", { jobs: [{ id: "no-job", name: "No Job", code: "IV7002", status: "active" }] });
    const p = JobInvoicingResponseSchema.parse((await call({ query: { jobId: "no-job" } })).body);
    expect(p.noJob).toBe(false);
    expect(p.job.name).toBe("No Job");
  });
});

describe("an invoice with no job — the list", () => {
  it("starts empty, says it is the no-job list, and is ready to send when Xero is", async () => {
    const p = await ledger();
    expect(p).toMatchObject({ jobId: NO_JOB_ID, noJob: true, stages: [], variations: [] });
    expect(p.job).toMatchObject({ code: null, clientName: null, contractCents: null });
    expect(p.xero).toMatchObject({ state: "connected", organisationName: "Buhl Electrical", settingsComplete: true, sendReady: true });
    expect(p.totals).toMatchObject({ sentCount: 0, plannedCount: 0 });
  });

  it("is not ready to send while the invoice defaults aren't chosen, or Xero isn't connected", async () => {
    mem.settings.clear();
    expect((await ledger()).xero).toMatchObject({ settingsComplete: false, sendReady: false });
    connection = null;
    expect((await ledger()).xero).toMatchObject({ state: "disconnected", sendReady: false });
  });

  it("never shows a job's invoices, and a job never shows these", async () => {
    await call({ method: "POST", query: { action: "stage-add" }, body: { jobId: "tower", stage: { title: "Deposit", basis: "percent", percentBp: 2000 } } });
    await added();
    expect((await ledger()).stages.map((s) => s.title)).toEqual(["Progress claim, November 2026"]);
    const tower = JobInvoicingResponseSchema.parse((await call({ query: { jobId: "tower" } })).body);
    expect(tower.stages.map((s) => s.title)).toEqual(["Deposit"]);
    expect(tower.noJob).toBe(false);
  });
});

describe("an invoice with no job — writing one", () => {
  it("stores the client under Xero's own name, never one the browser sent", async () => {
    const s = await added();
    expect(s).toMatchObject({
      jobId: NO_JOB_ID, kind: "itemised", state: "planned", title: "Progress claim, November 2026",
      clientContactId: BUILT, clientContactName: "Built Pty Ltd", clientOtherOrganisation: false,
    });
    expect(row(s.id)).toMatchObject({ clientContactId: BUILT, clientContactName: "Built Pty Ltd", clientExternalTenantId: "org-1" });
    expect(s.computed).toMatchObject({ grossCents: 1250000, retentionCents: 0, netCents: 1250000 });
    expect(contactReads).toEqual([BUILT]);
    // a name in the body is refused outright
    const r = await add({ contactName: "Whoever I Like" });
    expect(r.statusCode).toBe(400);
  });

  it("can be saved with no client and given one later", async () => {
    const s = await added({ contactId: null });
    expect(s).toMatchObject({ clientContactId: null, clientContactName: null });
    expect(contactReads).toEqual([]);
    const s2 = await added({ contactId: undefined });
    expect(s2.clientContactId).toBeNull();
  });

  it("refuses a contact Xero doesn't have, or has archived", async () => {
    const gone = await add({ contactId: UNKNOWN });
    expect([gone.statusCode, err(gone)]).toEqual([404, "contact_not_found"]);
    const old = await add({ contactId: ARCHIVED });
    expect([old.statusCode, err(old)]).toEqual([409, "contact_not_active"]);
    expect(mem.rows).toEqual([]);
  });

  it("can't choose a client while Xero isn't connected, but can still be saved without one", async () => {
    connection = null;
    const r = await add();
    expect(r.statusCode).toBe(409);
    expect(err(r)).toBe("xero_not_connected");
    expect((await add({ contactId: null })).statusCode).toBe(201);
  });

  it("is itemised with typed lines only: no stage, no job data, no retention", async () => {
    const stage = await call({ method: "POST", query: { action: "stage-add" }, body: { jobId: NO_JOB_ID, stage: { title: "Deposit", basis: "amount", amountCents: 50000 } } });
    expect([stage.statusCode, err(stage)]).toEqual([400, "no_job_itemised_only"]);
    const pulled = await add({ items: [charge({ refs: [{ t: "h", u: "u_lh", d: "2026-11-03", m: 480 }] })] });
    expect([pulled.statusCode, err(pulled)]).toEqual([400, "no_job_typed_lines_only"]);
    const variation = await add({ items: [charge({ refs: [{ t: "v", id: "v1" }] })] });
    expect([variation.statusCode, err(variation)]).toEqual([400, "no_job_typed_lines_only"]);
    const held = await add({ retentionBp: 500 });
    expect([held.statusCode, err(held)]).toEqual([400, "no_job_no_retention"]);
    expect(mem.rows).toEqual([]);
  });

  it("a job's invoice can't carry a client of its own", async () => {
    const r = await add({}, "tower");
    expect([r.statusCode, err(r)]).toEqual([400, "client_is_the_jobs"]);
    const ok = await add({ contactId: undefined }, "tower");
    expect(ok.statusCode).toBe(201);
    expect(mem.rows[0]).toMatchObject({ jobId: "tower", clientContactId: null });
  });

  it("journals it with no job, no client name and no amount", async () => {
    const s = await added();
    const e = journal().at(-1)!;
    expect(e).toMatchObject({ action: "customer_invoice.stage_added", targetId: s.id, summary: 'Added invoice "Progress claim, November 2026" with no job' });
    expect(e.jobId ?? null).toBeNull();
    expect(e.metadata).toEqual({ kind: "itemised", noJob: true, lines: 1, client: true });
    expect(JSON.stringify(e)).not.toMatch(/12500|Built/);
  });
});

describe("an invoice with no job — editing and removing", () => {
  it("keeps its client without asking Xero again, changes it when asked, and clears it on null", async () => {
    const s = await added();
    contactReads.length = 0;
    const edit = (stage: Record<string, unknown>, version: number) =>
      post("stage-edit", s.id, { stage: { kind: "itemised", title: "Progress claim 4", items: [charge({ unitCents: 990000 })], ...stage }, expectedVersion: version });

    // left out → kept
    const kept = JobInvoicingResponseSchema.parse((await edit({}, 1)).body).stages[0]!;
    expect(kept).toMatchObject({ title: "Progress claim 4", clientContactId: BUILT, clientContactName: "Built Pty Ltd" });
    // the same contact → kept, no Xero call
    await edit({ contactId: BUILT }, 2);
    expect(contactReads).toEqual([]);
    // another contact → confirmed against Xero
    const moved = JobInvoicingResponseSchema.parse((await edit({ contactId: OTHER }, 3)).body).stages[0]!;
    expect(moved).toMatchObject({ clientContactId: OTHER, clientContactName: "Hutchinson Builders" });
    expect(contactReads).toEqual([OTHER]);
    // null → no client
    const cleared = JobInvoicingResponseSchema.parse((await edit({ contactId: null }, 4)).body).stages[0]!;
    expect(cleared).toMatchObject({ clientContactId: null, clientContactName: null });
    // a stale version is refused
    const stale = await edit({}, 1);
    expect(stale.statusCode).toBe(409);
  });

  it("an edit is held to the same rules as a new one", async () => {
    const s = await added();
    const r = await post("stage-edit", s.id, { stage: stageOf({ items: [charge({ refs: [{ t: "sl", id: "x" }] })] }), expectedVersion: 1 });
    expect([r.statusCode, err(r)]).toEqual([400, "no_job_typed_lines_only"]);
    const kind = await post("stage-edit", s.id, { stage: { title: "Deposit", basis: "amount", amountCents: 100 }, expectedVersion: 1 });
    expect(kind.statusCode).toBe(409);
    expect(row(s.id).version).toBe(1);
  });

  it("a planned one can be removed", async () => {
    const s = await added();
    const r = await post("stage-remove", s.id, { expectedVersion: 1 });
    expect(JobInvoicingResponseSchema.parse(r.body)).toMatchObject({ noJob: true, stages: [] });
    expect(journal().at(-1)).toMatchObject({ action: "customer_invoice.stage_removed" });
    expect(journal().at(-1)!.jobId ?? null).toBeNull();
  });
});

describe("an invoice with no job — sending it to Xero as a draft", () => {
  it("previews exactly what will be sent, under the next number of its own series", async () => {
    const s = await added({ items: [charge(), { type: "note", description: "As per payment schedule 4." }, charge({ description: "Variation V2", unitCents: 80000 })] });
    const p = SendPreviewSchema.parse((await post("preview", s.id, { invoiceDate: "2026-11-25" })).body);
    expect(p.blockers).toEqual([]);
    expect(p.invoice).toMatchObject({
      invoiceNumber: "GEN-0001", contactName: "Built Pty Ltd", organisationName: "Buhl Electrical",
      invoiceDate: "2026-11-25", dueDate: "2026-12-25", reference: "Progress claim, November 2026",
      netCents: 1330000, estimatedTaxCents: 133000, estimatedTotalCents: 1463000,
    });
    // the heading is what it is for — no job name or address under it
    expect(p.invoice!.lines[0]).toMatchObject({ description: "Progress claim, November 2026", amountCents: 0 });
    expect(xero.calls).toEqual([]);
    expect(row(s.id).state).toBe("planned");
  });

  it("names what stops it: no client, or a client from another Xero organisation", async () => {
    const none = await added({ contactId: null });
    const p = SendPreviewSchema.parse((await post("preview", none.id, {})).body);
    expect(p.blockers.map((b) => b.code)).toEqual(["no_client_chosen"]);
    const blocked = await send(none.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toMatchObject({ error: "blocked", blockers: [{ code: "no_client_chosen" }] });

    const s = await added();
    connection = { ...connection!, external_tenant_id: "org-2", external_tenant_name: "Demo Company (AU)" };
    await mem.saveSettings({}, "t1", "org-2", SETTINGS, { expectedVersion: null });
    expect((await ledger()).stages.find((x) => x.id === s.id)).toMatchObject({ clientOtherOrganisation: true });
    const other = SendPreviewSchema.parse((await post("preview", s.id, {})).body);
    expect(other.blockers.map((b) => b.code)).toEqual(["client_chosen_other_organisation"]);
    expect(xero.puts()).toEqual([]);
  });

  it("creates ONE draft for the chosen client, numbered GEN-0001, and the next one GEN-0002", async () => {
    const s = await added();
    const p = SendResponseSchema.parse((await send(s.id)).body);
    expect(p.send).toMatchObject({ outcome: "sent", verified: true, invoiceNumber: "GEN-0001" });
    expect(p.noJob).toBe(true);
    expect(p.stages[0]).toMatchObject({ state: "sent", display: "draft_in_xero", invoiceNumber: "GEN-0001", xeroContactId: BUILT });

    expect(xero.puts()).toHaveLength(1);
    const sent = (xero.puts()[0]!.body as { Invoices: Array<Record<string, unknown>> }).Invoices[0]!;
    expect(sent).toMatchObject({
      Type: "ACCREC", Status: "DRAFT", LineAmountTypes: "Exclusive", InvoiceNumber: "GEN-0001",
      Contact: { ContactID: BUILT }, Reference: "Progress claim, November 2026",
      Date: "2026-11-25", DueDate: "2026-12-25", Url: "https://buhlos.com/getting-paid",
    });
    expect(sent.LineItems).toEqual([
      { Description: "Progress claim, November 2026" },
      { Description: "Progress claim 4", Quantity: 1, UnitAmount: 12500, AccountCode: "200", TaxType: "OUTPUT" },
    ]);
    // only the contact's id goes to Xero: BuhlOS can never edit a contact
    expect(Object.keys(sent.Contact as object)).toEqual(["ContactID"]);

    const e = journal().at(-1)!;
    expect(e).toMatchObject({ action: "customer_invoice.sent_to_xero", summary: "Sent GEN-0001 to Xero as a draft (invoices with no job)" });
    expect(e.jobId ?? null).toBeNull();

    const second = await added({ title: "Progress claim, December 2026", contactId: OTHER });
    const p2 = SendResponseSchema.parse((await send(second.id, { reference: "PO 4471" })).body);
    expect(p2.send).toMatchObject({ outcome: "sent", invoiceNumber: "GEN-0002" });
    expect(xero.get("GEN-0002")).toMatchObject({ Reference: "PO 4471", Contact: { ContactID: OTHER } });
  });

  it("its numbers are its own: a job's invoices keep the job's number", async () => {
    await send((await added()).id);
    const t = await call({ method: "POST", query: { action: "stage-add" }, body: { jobId: "tower", stage: { title: "Deposit", basis: "percent", percentBp: 2000 } } });
    const stage = JobInvoicingResponseSchema.parse(t.body).stages[0]!;
    const p = SendResponseSchema.parse((await send(stage.id)).body);
    expect(p.send.invoiceNumber).toBe("IV3345-1");
    expect((xero.puts()[1]!.body as { Invoices: Array<{ Url: string }> }).Invoices[0]!.Url).toBe("https://buhlos.com/v2/jobs/tower");
    expect(xero.invoices.map((i) => i.InvoiceNumber).sort()).toEqual(["GEN-0001", "IV3345-1"]);
  });

  it("a double press creates it once", async () => {
    const s = await added();
    const [a, b] = await Promise.all([send(s.id), send(s.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(xero.puts()).toHaveLength(1);
  });

  it("no answer from Xero: it is looked up by its number and taken over, never sent twice", async () => {
    const s = await added();
    xero.failNext("timeout_after");
    const p = SendResponseSchema.parse((await send(s.id)).body);
    expect(p.send).toMatchObject({ outcome: "unknown", category: "timeout" });
    expect(p.stages[0]).toMatchObject({ state: "sending", invoiceNumber: "GEN-0001" });
    const checked = SendResponseSchema.parse((await post("retry", s.id)).body);
    expect(checked.send).toMatchObject({ outcome: "adopted", verified: true, invoiceNumber: "GEN-0001" });
    expect(xero.puts()).toHaveLength(1);
    expect(xero.invoices).toHaveLength(1);
  });

  it("the sync panel's Retry works for it too (there is no job record to find)", async () => {
    const s = await added();
    xero.failNext("timeout_after");
    await send(s.id);
    const out = await syncLog.retry(`inv:${s.id}`);
    expect(out.outcome).toBe("resolved");
    expect(row(s.id).state).toBe("sent");
    expect(xero.puts()).toHaveLength(1);
  });

  it("Xero refuses it: it can be put back to planned, edited and sent under the same number", async () => {
    const s = await added();
    xero.failNext("validation", "Account code '200' is not a valid code");
    const refused = SendResponseSchema.parse((await send(s.id)).body);
    expect(refused.send).toMatchObject({ outcome: "failed", category: "validation" });
    const reset = SendResponseSchema.parse((await post("reset", s.id)).body);
    expect(reset.stages[0]).toMatchObject({ state: "planned", invoiceNumber: null, clientContactId: BUILT });
    const again = SendResponseSchema.parse((await send(s.id)).body);
    expect(again.send).toMatchObject({ outcome: "sent", invoiceNumber: "GEN-0001" });
  });
});

describe("an invoice with no job — after it is sent", () => {
  it("Check Xero now brings back what Xero says was approved and paid", async () => {
    const s = await added();
    await send(s.id);
    xero.approve("GEN-0001");
    xero.pay("GEN-0001", 13750);
    const r = await call({ method: "POST", query: { action: "refresh" }, body: { jobId: NO_JOB_ID } });
    const p = JobInvoicingResponseSchema.parse(r.body);
    expect((r.body as { refresh: { checked: number; changed: number } }).refresh).toMatchObject({ checked: 1, changed: 1 });
    expect(p.stages[0]).toMatchObject({ xeroStatus: "PAID", display: "paid", xeroAmountPaidCents: 1375000 });
    expect(p.totals).toMatchObject({ sentCount: 1, paidIncGstCents: 1375000, dueIncGstCents: 0 });
    const e = journal().at(-1)!;
    expect(e.action).toBe("customer_invoice.status_checked");
    expect(e.jobId ?? null).toBeNull();
  });

  it("deleted in Xero: it can be raised again, keeps its client, and takes the next number", async () => {
    const s = await added();
    await send(s.id);
    xero.delete("GEN-0001");
    await call({ method: "POST", query: { action: "refresh" }, body: { jobId: NO_JOB_ID } });
    const raised = await post("raise-again", s.id);
    expect(raised.statusCode).toBe(201);
    const p = JobInvoicingResponseSchema.parse(raised.body);
    const copy = p.stages.find((x) => x.state === "planned")!;
    expect(copy).toMatchObject({ title: "Progress claim, November 2026", clientContactId: BUILT, clientContactName: "Built Pty Ltd" });
    const again = SendResponseSchema.parse((await send(copy.id)).body);
    expect(again.send).toMatchObject({ outcome: "sent", invoiceNumber: "GEN-0002" });
  });
});

describe("an invoice with no job — what it can't do", () => {
  it("everything that needs a job answers 'no such job' for the ledger", async () => {
    const probes: Array<Parameters<typeof call>[0]> = [
      { query: { action: "billable", jobId: NO_JOB_ID } },
      { method: "POST", query: { action: "variation-add" }, body: { jobId: NO_JOB_ID, variation: { title: "Extra GPOs", quotedCents: 1000 } } },
      { method: "PUT", query: { action: "profile" }, body: { jobId: NO_JOB_ID, retentionBp: 500, expectedVersion: null } },
      { method: "PUT", query: { action: "payment-claim" }, body: { jobId: NO_JOB_ID, on: true, expectedVersion: null } },
      { method: "PUT", query: { action: "contact-link" }, body: { jobId: NO_JOB_ID, contactId: BUILT, expectedVersion: null } },
      { method: "POST", query: { action: "retention-release" }, body: { jobId: NO_JOB_ID, amountCents: 100 } },
    ];
    for (const p of probes) {
      const r = await call(p);
      expect([p.query!.action, r.statusCode, err(r)]).toEqual([p.query!.action, 404, "job_not_found"]);
    }
    expect(mem.rows).toEqual([]);
    expect(mem.profiles.has(NO_JOB_ID)).toBe(false);
  });
});
