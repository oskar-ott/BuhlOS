import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "@/domains/audit-log/schema";
import { BillableResponseSchema, JobInvoicingResponseSchema } from "./schema";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * api/customer-invoices.js, part 2 — the real handler with signed sessions,
 * the flags via env, an in-memory Blob and an in-memory stand-in for the
 * Postgres store (the real SQL is in customer-invoices-itemised.pg.test.ts).
 *
 * Itemised invoices (#1161), filling them from the job's hours and materials
 * with nothing billed twice (#1162), the variations register (#1163) and the
 * payment-claim switch (#1164).
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
const entriesPath = resolve("../../../api/_lib/time-entry-blobs.js");
const supplierPath = resolve("../../../api/_lib/invoices/store.js");
const ratesPath = resolve("../../../api/_lib/cost-rates.js");
const ledgerPath = resolve("../../../api/_lib/job-materials.js");
const handlerPath = resolve("../../../api/customer-invoices.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let mem: MemoryStore;
let entries: Array<Record<string, unknown>>;
let entriesFail: boolean;
let supplierCalls: number;

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
const cookieFor = (userId: string, role: string) => `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
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
type Payload = ReturnType<typeof JobInvoicingResponseSchema.parse>;
const payload = (r: Res): Payload => JobInvoicingResponseSchema.parse(r.body);
const err = (r: Res) => (r.body as { error?: string }).error;
function journal() {
  const out: Array<{ action: string; targetId: string; jobId?: string; summary: string; metadata?: Record<string, unknown> }> = [];
  for (const [k, v] of blob) if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  return out;
}

const post = (action: string, body: unknown, id?: string) => call({ method: "POST", query: id ? { action, id } : { action }, body });
const addItemised = (items: unknown[], over: Record<string, unknown> = {}, jobId = "shop") =>
  post("stage-add", { jobId, stage: { kind: "itemised", title: "Shop front rewire", items, ...over } });
const charge = (over: Record<string, unknown> = {}) => ({ type: "line", description: "Call-out fee", quantityMilli: 1000, unit: "ea", unitCents: 9500, ...over });
const hours = (u: string, d: string, m: number) => ({ t: "h", u, d, m });
type Line = { source: string; costCents: number | null; refs: unknown[] };
const billableFor = async (jobId = "shop", invoiceId?: string) =>
  BillableResponseSchema.parse((await call({ query: { action: "billable", jobId, ...(invoiceId ? { invoiceId } : {}) } })).body);

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_CUSTOMER_INVOICES = "true";
  process.env.FLAG_INVOICE_CAPTURE = "true";
  process.env.FLAG_JOB_MATERIALS_SPEND = "true";
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: [
      { id: "shop", name: "Corner Shop Rewire", code: "IV7001", status: "active", siteAddress: "4 High St" },
      { id: "tower", name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", status: "active", contractValue: 90000 },
      { id: "gone", name: "Deleted Job", status: "active", deleted: true },
    ] }],
    ["users.json", { users: [
      { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      { id: "u_lh", username: "lead", name: "Lead Hand", role: "leadingHand", assignedJobIds: ["shop"] },
      { id: "u_field", username: "sparky", name: "Sam Sparky", role: "electrician", assignedJobIds: ["shop"] },
      { id: "u_dylan", username: "dylan", name: "Dylan Sinclair", role: "electrician", assignedJobIds: ["shop"] },
    ] }],
    ["workforce/cost-rates.json", { rates: {
      u_field: [{ id: "r1", costRateCents: 4800, chargeOutRateCents: 9500, effectiveFrom: "2026-01-01" }],
      // Dylan: a cost rate, no charge-out rate
      u_dylan: [{ id: "r2", costRateCents: 5200, chargeOutRateCents: null, effectiveFrom: "2026-01-01" }],
    } }],
    ["jobs/shop/materials-ledger.json", { lines: [{ id: "ml_1", date: "2026-11-11", supplier: "Bunnings", description: "Saddles", amountCents: 3460, createdAt: "2026-11-11T00:00:00Z" }] }],
  ]);
  entries = [
    { userId: "u_field", userName: "Sam Sparky", date: "2026-11-10", status: "approved", allocations: [{ jobId: "shop", hours: 4.5 }] },
    { userId: "u_field", userName: "Sam Sparky", date: "2026-11-11", status: "approved", allocations: [{ jobId: "shop", hours: 7.6 }] },
    { userId: "u_dylan", userName: "Dylan Sinclair", date: "2026-11-11", status: "approved", allocations: [{ jobId: "shop", hours: 3 }] },
    { userId: "u_field", userName: "Sam Sparky", date: "2026-11-13", status: "submitted", allocations: [{ jobId: "shop", hours: 1.5 }] },
  ];
  entriesFail = false;
  supplierCalls = 0;
  mem = createMemoryStore();
  for (const p of [authPath, flagsPath, auditPath, ratesPath, ledgerPath, handlerPath]) delete requireFromHere.cache[p];
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
  mock(lookupsPath, {
    readiness: async () => ({ state: "disconnected", organisationName: null, externalTenantId: null }),
    assertReady: () => { throw new Error("no Xero call is expected here"); },
  });
  mock(entriesPath, {
    listTimeEntryBlobs: async () => [],
    fetchTimeEntries: async () => {
      if (entriesFail) throw new Error("blob store down");
      return clone(entries);
    },
  });
  mock(supplierPath, {
    jobMaterialsBreakdown: async (_sql: unknown, _t: string, jobId: string) => {
      supplierCalls += 1;
      if (jobId !== "shop") return { lines: [], invoices: [] };
      return {
        lines: [
          { id: "l1", invoiceId: "i1", description: "2.5mm TPS", quantity: 100, unit: "m", unitPriceCents: 185, signedCents: 18500 },
          { id: "l2", invoiceId: "i1", description: "Double GPO", quantity: 6, unit: "ea", unitPriceCents: 1240, signedCents: 7440 },
        ],
        invoices: [{ invoiceId: "i1", supplierName: "Rexel", supplierInvoiceNumber: "RX-1", invoiceDate: "2026-11-10", documentType: "invoice", amountCents: 25940 }],
      };
    },
  });
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.FLAG_CUSTOMER_INVOICES;
  delete process.env.FLAG_INVOICE_CAPTURE;
  delete process.env.FLAG_JOB_MATERIALS_SPEND;
});

describe("gating — every new route", () => {
  const V = "00000000-0000-4000-8000-000000000009";
  const probes: Array<Parameters<typeof call>[0]> = [
    { method: "POST", query: { action: "stage-add" }, body: { jobId: "shop", stage: { kind: "itemised", title: "x", items: [charge()] } } },
    { query: { action: "billable", jobId: "shop" } },
    { query: { action: "prefs" } },
    { method: "PUT", query: { action: "prefs" }, body: { materialsMarkupBp: 2500, labourRoundMinutes: 0, usualCharges: [], expectedVersion: null } },
    { method: "POST", query: { action: "variation-add" }, body: { jobId: "tower", variation: { title: "x" } } },
    { method: "POST", query: { action: "variation-decide", id: V }, body: { status: "declined", expectedVersion: 1 } },
    { method: "POST", query: { action: "variation-bill", id: V }, body: {} },
    { method: "PUT", query: { action: "payment-claim" }, body: { jobId: "tower", on: true, expectedVersion: null } },
  ];

  it("is invisible (404) while the flag is off", async () => {
    delete process.env.FLAG_CUSTOMER_INVOICES;
    for (const p of probes) expect((await call(p)).statusCode).toBe(404);
    expect(mem.rows).toEqual([]);
    expect(mem.variations).toEqual([]);
  });

  it("needs a session (401)", async () => {
    for (const p of probes) expect((await call({ ...p, anonymous: true })).statusCode).toBe(401);
  });

  it("is invisible to a leading hand and to a field worker — hours, costs and prices are office data", async () => {
    for (const who of [{ userId: "u_lh", role: "leadingHand" }, { userId: "u_field", role: "electrician" }]) {
      for (const p of probes) expect((await call({ ...p, ...who })).statusCode).toBe(404);
    }
    expect(mem.rows).toEqual([]);
    expect(supplierCalls).toBe(0);
  });
});

describe("an itemised invoice, typed by hand", () => {
  it("is stored with its lines, added up on the server", async () => {
    const r = await addItemised([
      { type: "note", description: "Rewired the shop front." },
      charge(),
      charge({ description: "Labour", quantityMilli: 2500, unit: "hr", unitCents: 9550 }),
      charge({ description: "Discount", unit: null, unitCents: -2000 }),
    ]);
    expect(r.statusCode).toBe(201);
    const s = payload(r).stages[0]!;
    expect(s).toMatchObject({ kind: "itemised", title: "Shop front rewire", state: "planned", basis: "amount", amountCents: 9500 + 23875 - 2000 });
    expect(s.computed).toMatchObject({ grossCents: 31375, netCents: 31375, reason: null });
    expect(s.items!.map((i) => (i.type === "line" ? i.amountCents : "note"))).toEqual(["note", 9500, 23875, -2000]);
    expect(new Set(s.items!.map((i) => i.id)).size).toBe(4); // each line got an id of its own
    expect(payload(r).totals).toMatchObject({ plannedCount: 1, plannedGrossCents: 31375 });
  });

  it("works on a job with no contract value, and counts toward the contract on one that has it", async () => {
    const small = payload(await addItemised([charge()]));
    expect(small.totals.stillToInvoiceCents).toBeNull();
    const big = payload(await addItemised([charge({ unitCents: 500000 })], {}, "tower"));
    expect(big.totals).toMatchObject({ plannedGrossCents: 500000, overContract: false });
  });

  it("journals that it was added — the heading and how many lines, never an amount", async () => {
    await addItemised([charge(), charge({ description: "Travel", unitCents: 12345 })]);
    const e = journal().find((x) => x.action === "customer_invoice.stage_added")!;
    expect(e.summary).toBe('Added itemised invoice "Shop front rewire" to Corner Shop Rewire');
    expect(e.metadata).toEqual({ kind: "itemised", lines: 2 });
    expect(JSON.stringify(e)).not.toMatch(/9500|12345|95\.00/);
  });

  it.each([
    ["no lines", [], ["stage.items"]],
    ["only wording", [{ type: "note", description: "Words" }], ["stage.items"]],
    ["lines that add up to nothing", [charge(), charge({ unitCents: -9500 })], ["stage.items"]],
    ["a zero quantity", [charge({ quantityMilli: 0 })], ["stage.items.0.quantityMilli"]],
    ["a fractional quantity of thousandths", [charge({ quantityMilli: 2.5 })], ["stage.items.0.quantityMilli"]],
    ["a price in fractions of a cent", [charge({ unitCents: 95.5 })], ["stage.items.0.unitCents"]],
    ["no description", [charge({ description: "   " })], ["stage.items.0.description"]],
    ["a field that isn't part of a line", [charge({ amountCents: 1 })], ["stage.items.0"]],
    ["a made-up kind of ref", [charge({ refs: [{ t: "zz", id: "x" }] })], ["stage.items.0"]],
  ])("refuses %s (400), naming the field", async (_name, items, fields) => {
    const r = await addItemised(items);
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatchObject({ error: "invalid_request" });
    for (const f of fields) expect((r.body as { fields: string[] }).fields.some((x) => x.startsWith(f))).toBe(true);
    expect(mem.rows).toEqual([]);
  });

  it("refuses more than 100 lines", async () => {
    const r = await addItemised(Array.from({ length: 101 }, () => charge()));
    expect(r.statusCode).toBe(400);
  });

  it("refuses a deleted or unknown job", async () => {
    expect((await addItemised([charge()], {}, "gone")).statusCode).toBe(404);
    expect((await addItemised([charge()], {}, "nope")).statusCode).toBe(404);
  });

  it("is edited by compare-and-swap, keeping its kind", async () => {
    const s = payload(await addItemised([charge()])).stages[0]!;
    const edit = (body: unknown) => post("stage-edit", body, s.id);
    const ok = await edit({ expectedVersion: s.version, stage: { kind: "itemised", title: "Now two lines", items: [charge(), charge({ description: "Travel", unitCents: 5000 })] } });
    expect(ok.statusCode).toBe(200);
    expect(payload(ok).stages[0]!).toMatchObject({ title: "Now two lines", amountCents: 14500, version: s.version + 1, kind: "itemised" });
    // a second save from the stale page loses
    const stale = await edit({ expectedVersion: s.version, stage: { kind: "itemised", title: "Stale", items: [charge()] } });
    expect([stale.statusCode, err(stale)]).toEqual([409, "stale_version"]);
    // it can't be turned into a stage, nor a stage into it
    const asStage = await edit({ expectedVersion: s.version + 1, stage: { title: "A stage", basis: "amount", amountCents: 100 } });
    expect([asStage.statusCode, err(asStage)]).toEqual([409, "kind_mismatch"]);
    const st = payload(await post("stage-add", { jobId: "shop", stage: { title: "Stage", basis: "amount", amountCents: 100 } })).stages.find((x) => x.kind === "stage")!;
    const asItemised = await post("stage-edit", { expectedVersion: st.version, stage: { kind: "itemised", title: "x", items: [charge()] } }, st.id);
    expect(err(asItemised)).toBe("kind_mismatch");
  });

  it("is frozen once it has been sent", async () => {
    const s = payload(await addItemised([charge()])).stages[0]!;
    Object.assign(mem.rows[0]!, { state: "sent", seq: 1, invoiceNumber: "IV7001-1", xeroInvoiceId: "x1", xeroStatus: "DRAFT", grossCents: 9500, netCents: 9500, retentionCents: 0 });
    const r = await post("stage-edit", { expectedVersion: s.version, stage: { kind: "itemised", title: "x", items: [charge()] } }, s.id);
    expect([r.statusCode, err(r)]).toEqual([409, "stage_not_editable"]);
  });
});

describe("what on the job can go on an invoice", () => {
  it("lists the job's approved hours and materials, with rates, for the office", async () => {
    const b = await billableFor();
    expect(b.labour.days.map((d) => [d.name, d.date, d.unbilledMilli, d.chargeOutRateCents, d.costRateCents])).toEqual([
      ["Sam Sparky", "2026-11-10", 4500, 9500, 4800],
      ["Dylan Sinclair", "2026-11-11", 3000, null, 5200],
      ["Sam Sparky", "2026-11-11", 7600, 9500, 4800],
    ]);
    expect(b.labour.pendingMilli).toBe(1500); // logged, not approved: can't be invoiced
    expect(b.supplier.lines.map((l) => [l.description, l.costCents])).toEqual([["2.5mm TPS", 18500], ["Double GPO", 7440]]);
    expect(b.ledger.lines.map((l) => [l.description, l.costCents])).toEqual([["Saddles", 3460]]);
    expect(b.summary).toEqual({ unbilledHoursMilli: 15100, unbilledMaterialCount: 3, unbilledMaterialCostCents: 29400, anyBilled: false });
    expect(b.prefs).toEqual({ materialsMarkupBp: null, labourRoundMinutes: 0, usualCharges: [], version: null });
  });

  it("leaves a materials source out, with no trace, while its feature is off", async () => {
    delete process.env.FLAG_INVOICE_CAPTURE;
    delete process.env.FLAG_JOB_MATERIALS_SPEND;
    const b = await billableFor();
    expect(b.supplier).toMatchObject({ available: false, reason: "off", lines: [] });
    expect(b.ledger).toMatchObject({ available: false, reason: "off", lines: [] });
    expect(supplierCalls).toBe(0);
    expect(b.labour.days).toHaveLength(3);
  });

  it("says the time sheets couldn't be read rather than 'no hours'", async () => {
    entriesFail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = await billableFor();
    spy.mockRestore();
    expect(b.labour).toMatchObject({ available: false, reason: "unreadable", days: [] });
    expect(b.supplier.available).toBe(true);
  });

  it("404s for a job that doesn't exist", async () => {
    expect((await call({ query: { action: "billable", jobId: "nope" } })).statusCode).toBe(404);
  });
});

describe("an invoice built from the job — and nothing billed twice", () => {
  const samDays = [hours("u_field", "2026-11-10", 4500), hours("u_field", "2026-11-11", 7600)];
  const labour = (refs: unknown[], over: Record<string, unknown> = {}) => charge({ description: "Labour: Sam Sparky", quantityMilli: 12100, unit: "hr", unitCents: 9500, refs, ...over });
  const gpo = (over: Record<string, unknown> = {}) => charge({ description: "Double GPO", quantityMilli: 6000, unit: "ea", unitCents: 1550, refs: [{ t: "sl", id: "l2" }], ...over });

  it("works the cost out on the server, whatever the browser says", async () => {
    const r = await addItemised([labour(samDays, { costCents: 1 }), gpo({ costCents: 99999999 })]);
    expect(r.statusCode).toBe(201);
    const s = payload(r).stages[0]!;
    const [l, m] = s.items as unknown as [Line, Line];
    expect([l.source, l.costCents]).toEqual(["labour", 58080]); // 12.1 h × $48.00
    expect([m.source, m.costCents]).toEqual(["material", 7440]); // the supplier's line total
    expect(l.refs).toEqual(samDays);
    expect(s.itemsSummary).toMatchObject({ totalCents: 114950 + 9300, costCents: 65520, costedSellCents: 124250, costKnown: true });
  });

  it("has no cost — and shows no margin — for a worker with no cost rate", async () => {
    blob.set("workforce/cost-rates.json", { rates: {} });
    const s = payload(await addItemised([labour(samDays)])).stages[0]!;
    expect((s.items![0]! as { costCents: number | null }).costCents).toBeNull();
    expect(s.itemsSummary!.costKnown).toBe(false);
  });

  it("marks what it billed, so the picker stops offering it", async () => {
    const s = payload(await addItemised([labour(samDays), gpo()])).stages[0]!;
    const b = await billableFor();
    expect(b.labour.days.filter((d) => d.userId === "u_field").map((d) => [d.unbilledMilli, d.onInvoice])).toEqual([[0, "Shop front rewire"], [0, "Shop front rewire"]]);
    expect(b.supplier.lines.map((l) => l.onInvoice)).toEqual([null, "Shop front rewire"]);
    expect(b.summary).toMatchObject({ unbilledHoursMilli: 3000, unbilledMaterialCount: 2, anyBilled: true });
    // …but the invoice being edited still sees its own lines as free
    const own = await billableFor("shop", s.id);
    expect(own.summary.unbilledHoursMilli).toBe(15100);
  });

  it("refuses the same hours, or the same supplier line, on a second invoice — saying which invoice has them", async () => {
    await addItemised([labour(samDays), gpo()]);
    const again = await addItemised([labour([samDays[0]!], { quantityMilli: 4500 })], { title: "Second" });
    expect([again.statusCode, again.body]).toEqual([409, { error: "already_billed", what: "hours", on: "Shop front rewire" }]);
    const mat = await addItemised([gpo()], { title: "Second" });
    expect([mat.statusCode, mat.body]).toEqual([409, { error: "already_billed", what: "materials", on: "Shop front rewire" }]);
    expect(mem.rows).toHaveLength(1);
  });

  it("refuses to bill something that isn't on this job", async () => {
    const r = await addItemised([charge({ refs: [{ t: "sl", id: "someone-elses-line" }] })]);
    expect([r.statusCode, r.body]).toEqual([409, { error: "ref_not_found", what: "materials" }]);
    const h = await addItemised([charge({ refs: [hours("u_field", "2026-10-01", 1000)] })]);
    expect(err(h)).toBe("ref_not_found");
    // hours logged but not approved are not there to be billed
    const pending = await addItemised([charge({ refs: [hours("u_field", "2026-11-13", 1500)] })]);
    expect(err(pending)).toBe("ref_not_found");
  });

  it("lets an invoice be saved again with what it already holds, and frees it when the invoice is removed", async () => {
    const s = payload(await addItemised([labour(samDays)])).stages[0]!;
    const edit = await post("stage-edit", { expectedVersion: s.version, stage: { kind: "itemised", title: "Repriced", items: [labour(samDays, { unitCents: 9900 })] } }, s.id);
    expect(edit.statusCode).toBe(200);
    const edited = payload(edit).stages[0]!;
    expect(edited.amountCents).toBe(119790);
    await post("stage-remove", { expectedVersion: edited.version }, s.id);
    expect((await billableFor()).summary).toMatchObject({ unbilledHoursMilli: 15100, anyBilled: false });
    expect((await addItemised([labour(samDays)])).statusCode).toBe(201);
  });

  it("frees what an invoice billed when Xero shows it deleted", async () => {
    await addItemised([labour(samDays)]);
    Object.assign(mem.rows[0]!, { state: "sent", seq: 1, invoiceNumber: "IV7001-1", xeroInvoiceId: "x1", xeroStatus: "DELETED", grossCents: 114950, netCents: 114950, retentionCents: 0 });
    expect((await billableFor()).summary.unbilledHoursMilli).toBe(15100);
    expect((await addItemised([labour(samDays)], { title: "Raised again by hand" })).statusCode).toBe(201);
  });

  it("shows hours that arrive AFTER an invoice as not yet on one", async () => {
    await addItemised([labour(samDays)]);
    entries.push({ userId: "u_field", userName: "Sam Sparky", date: "2026-11-14", status: "approved", allocations: [{ jobId: "shop", hours: 2 }] });
    // and a day already billed is corrected upward on the time sheet
    (entries[0]!.allocations as Array<{ hours: number }>)[0]!.hours = 5;
    const b = await billableFor();
    expect(b.labour.days.filter((d) => d.unbilledMilli > 0).map((d) => [d.date, d.userId, d.unbilledMilli])).toEqual([
      ["2026-11-10", "u_field", 500], ["2026-11-11", "u_dylan", 3000], ["2026-11-14", "u_field", 2000],
    ]);
  });

  it("only reads the time sheets and supplier invoices when a line needs them", async () => {
    await addItemised([charge()]);
    expect(supplierCalls).toBe(0);
    await addItemised([gpo()], { title: "With materials" });
    expect(supplierCalls).toBe(1);
  });
});

describe("the business's usual charges and markup", () => {
  const save = (body: Record<string, unknown>) => call({ method: "PUT", query: { action: "prefs" }, body });
  const good = { materialsMarkupBp: 2500, labourRoundMinutes: 15, usualCharges: [{ name: "Call-out fee", unit: "ea", unitCents: 9500, kind: "other" }, { name: "Tradesman", unit: "hr", unitCents: 11000, kind: "labour" }], expectedVersion: null };

  it("ship with nothing set — no default markup, no default rate", async () => {
    expect((await call({ query: { action: "prefs" } })).body).toEqual({ prefs: { materialsMarkupBp: null, labourRoundMinutes: 0, usualCharges: [], version: null } });
  });

  it("are saved once for every job, by compare-and-swap, and journalled without a figure", async () => {
    const r = await save(good);
    expect(r.statusCode).toBe(200);
    const prefs = (r.body as { prefs: { version: number; usualCharges: Array<{ id: string; name: string }> } }).prefs;
    expect(prefs).toMatchObject({ materialsMarkupBp: 2500, labourRoundMinutes: 15, version: 1 });
    expect(prefs.usualCharges.map((c) => c.name)).toEqual(["Call-out fee", "Tradesman"]);
    expect(prefs.usualCharges.every((c) => c.id)).toBe(true);
    expect((await billableFor("tower")).prefs.materialsMarkupBp).toBe(2500);
    expect([(await save(good)).statusCode, (await save({ ...good, expectedVersion: 1, materialsMarkupBp: null })).statusCode]).toEqual([409, 200]);
    const e = journal().filter((x) => x.action === "customer_invoice.prefs_updated");
    expect(e).toHaveLength(2);
    expect(JSON.stringify(e)).not.toMatch(/9500|11000|2500/);
  });

  it.each([
    ["a markup over 1,000%", { materialsMarkupBp: 100001 }],
    ["a negative markup", { materialsMarkupBp: -1 }],
    ["rounding to a step that isn't offered", { labourRoundMinutes: 10 }],
    ["a usual charge with no price", { usualCharges: [{ name: "Free", unitCents: 0, kind: "other" }] }],
    ["a usual charge with no name", { usualCharges: [{ name: " ", unitCents: 100, kind: "other" }] }],
    ["an unknown field", { defaultRate: 100 }],
  ])("refuses %s", async (_name, over) => {
    expect((await save({ ...good, ...over })).statusCode).toBe(400);
  });
});

describe("variations", () => {
  const add = (variation: Record<string, unknown>, jobId = "tower") => post("variation-add", { jobId, variation });
  const decide = (v: { id: string; version: number }, body: Record<string, unknown>) => post("variation-decide", { expectedVersion: v.version, ...body }, v.id);
  const approved = async (cents = 110000, quoted = 120000) => {
    const v = payload(await add({ title: "Four extra power points", requestedBy: "Site manager", requestedOn: "2026-11-18", quotedCents: quoted })).variations!.slice(-1)[0]!;
    return payload(await decide(v, { status: "approved", approvedCents: cents, approvalRef: "Email 20 Nov", decidedOn: "2026-11-20" })).variations!.find((x) => x.id === v.id)!;
  };

  it("are numbered per job and start as proposed, changing nothing about the contract", async () => {
    const a = payload(await add({ title: "Four extra power points", quotedCents: 120000 }));
    const b = payload(await add({ title: "Relocate the board" }));
    expect(b.variations!.map((v) => [v.number, v.status, v.quotedCents, v.billedOn])).toEqual([["V1", "proposed", 120000, null], ["V2", "proposed", null, null]]);
    expect(a.totals).toMatchObject({ revisedContractCents: 9000000, variationsApprovedCents: 0, variationsPendingCents: 120000 });
    expect(b.totals).toMatchObject({ variationsPendingCount: 2, variationsUnpricedCount: 1 });
    expect(payload(await add({ title: "On the small job" }, "shop")).variations!.map((v) => v.number)).toEqual(["V1"]);
  });

  it("an approved one adds what was APPROVED to the contract, and says how it was approved", async () => {
    const v = await approved(110000, 120000);
    expect(v).toMatchObject({ status: "approved", approvedCents: 110000, quotedCents: 120000, approvalRef: "Email 20 Nov", decidedOn: "2026-11-20", decidedBy: "Karen Boss" });
    const p = payload(await call({ query: { jobId: "tower" } }));
    expect(p.totals).toMatchObject({ contractCents: 9000000, revisedContractCents: 9110000, stillToInvoiceCents: 9110000, variationsApprovedCents: 110000 });
  });

  it("can't be approved without an amount, and a declined one adds nothing", async () => {
    const v = payload(await add({ title: "Extra", quotedCents: 5000 })).variations![0]!;
    expect((await decide(v, { status: "approved" })).statusCode).toBe(400);
    const d = payload(await decide(v, { status: "declined" }));
    expect(d.variations![0]!).toMatchObject({ status: "declined", approvedCents: null });
    expect(d.totals.revisedContractCents).toBe(9000000);
    // …and it can be put back to proposed
    const back = payload(await decide(d.variations![0]!, { status: "proposed" }));
    expect(back.variations![0]!).toMatchObject({ status: "proposed", decidedOn: null, approvalRef: null });
  });

  it("only an approved variation can be billed", async () => {
    const v = payload(await add({ title: "Extra", quotedCents: 5000 })).variations![0]!;
    const r = await post("variation-bill", {}, v.id);
    expect([r.statusCode, err(r)]).toEqual([409, "variation_not_approved"]);
    expect(mem.rows).toEqual([]);
  });

  it("goes on an invoice of its own, at the approved amount, and then counts as billed", async () => {
    const v = await approved();
    const r = await post("variation-bill", {}, v.id);
    expect(r.statusCode).toBe(201);
    const p = payload(r);
    expect(p.stages[0]!).toMatchObject({ kind: "itemised", title: "Variation V1 — Four extra power points", amountCents: 110000 });
    expect(p.stages[0]!.items![0]!).toMatchObject({ source: "variation", refs: [{ t: "v", id: v.id }], amountCents: 110000 });
    expect(p.variations![0]!.billedOn).toBe("Variation V1 — Four extra power points");
    expect(p.totals).toMatchObject({ revisedContractCents: 9110000, plannedGrossCents: 110000, overContract: false });
  });

  it("goes on a planned stage as an extra line, at the approved amount", async () => {
    const v = await approved();
    const stage = payload(await post("stage-add", { jobId: "tower", stage: { title: "Rough-in", basis: "percent", percentBp: 3000 } })).stages[0]!;
    const r = await post("variation-bill", { stageId: stage.id, expectedStageVersion: stage.version }, v.id);
    expect(r.statusCode).toBe(201);
    const s = payload(r).stages[0]!;
    expect(s.extraLines).toEqual([{ description: "Variation V1 — Four extra power points", amountCents: 110000, variationId: v.id }]);
    expect(s.computed.grossCents).toBe(2700000 + 110000);
    expect(payload(r).variations![0]!.billedOn).toBe("Rough-in");
    // a stale stage version is refused
    const v2 = await approved(45000, 45000);
    const stale = await post("variation-bill", { stageId: stage.id, expectedStageVersion: stage.version }, v2.id);
    expect([stale.statusCode, err(stale)]).toEqual([409, "stale_version"]);
  });

  it("is billed once: not a second time, and not at a different amount", async () => {
    const v = await approved();
    const own = payload(await post("variation-bill", {}, v.id)).stages[0]!;
    const twice = await post("variation-bill", {}, v.id);
    expect([twice.statusCode, twice.body]).toEqual([409, { error: "variation_billed", on: "Variation V1 — Four extra power points" }]);
    const repriced = await post("stage-edit", { expectedVersion: own.version, stage: { kind: "itemised", title: own.title, items: [charge({ description: "V1", unit: null, unitCents: 150000, refs: [{ t: "v", id: v.id }] })] } }, own.id);
    expect(err(repriced)).toBe("variation_amount");
    // typing a variation onto a stage's extra line goes through the same checks
    const typed = await post("stage-add", { jobId: "tower", stage: { title: "Another", basis: "amount", amountCents: 100, extraLines: [{ description: "V1 again", amountCents: 110000, variationId: v.id }] } });
    expect(err(typed)).toBe("already_billed");
  });

  it("a billed variation is settled: no edit, no change of mind, no removal", async () => {
    const v = await approved();
    await post("variation-bill", {}, v.id);
    const cur = payload(await call({ query: { jobId: "tower" } })).variations![0]!;
    for (const r of [
      await decide(cur, { status: "declined" }),
      await decide(cur, { status: "proposed" }),
      await post("variation-remove", { expectedVersion: cur.version }, cur.id),
    ]) {
      expect([r.statusCode, err(r)]).toEqual([409, "variation_billed"]);
    }
    expect(payload(await call({ query: { jobId: "tower" } })).variations![0]!.status).toBe("approved");
  });

  it("taking it off the invoice frees it again", async () => {
    const v = await approved();
    const own = payload(await post("variation-bill", {}, v.id)).stages[0]!;
    const p = payload(await post("stage-remove", { expectedVersion: own.version }, own.id));
    expect(p.variations![0]!.billedOn).toBeNull();
    expect((await decide(p.variations![0]!, { status: "declined" })).statusCode).toBe(200);
  });

  it("an approved quote can't be quietly edited; a proposed one can", async () => {
    const v = await approved();
    const r = await post("variation-edit", { expectedVersion: v.version, variation: { title: "Changed", quotedCents: 1 } }, v.id);
    expect([r.statusCode, err(r)]).toEqual([409, "variation_decided"]);
    const p = payload(await add({ title: "Proposed", quotedCents: 100 })).variations![1]!;
    const ok = payload(await post("variation-edit", { expectedVersion: p.version, variation: { title: "Proposed, repriced", quotedCents: 200, detail: "More cable" } }, p.id));
    expect(ok.variations![1]!).toMatchObject({ title: "Proposed, repriced", quotedCents: 200, detail: "More cable", version: p.version + 1 });
    const stale = await post("variation-edit", { expectedVersion: p.version, variation: { title: "Stale" } }, p.id);
    expect(err(stale)).toBe("stale_version");
  });

  it("a removed variation leaves the list but keeps its number", async () => {
    const a = payload(await add({ title: "One" })).variations![0]!;
    await add({ title: "Two" });
    const gone = payload(await post("variation-remove", { expectedVersion: a.version }, a.id));
    expect(gone.variations!.map((v) => v.number)).toEqual(["V2"]);
    expect(payload(await add({ title: "Three" })).variations!.map((v) => v.number)).toEqual(["V2", "V3"]);
    const again = await post("variation-remove", { expectedVersion: a.version + 1 }, a.id);
    expect([again.statusCode, err(again)]).toEqual([404, "variation_not_found"]);
  });

  it.each([
    ["no name", { title: "  " }],
    ["a negative price", { title: "x", quotedCents: -1 }],
    ["a date that isn't one", { title: "x", requestedOn: "last week" }],
    ["an unknown field", { title: "x", status: "approved" }],
  ])("refuses %s", async (_name, variation) => {
    expect((await add(variation)).statusCode).toBe(400);
    expect(mem.variations).toEqual([]);
  });

  it("journals each step with the variation's number and never an amount", async () => {
    const v = await approved(110000, 120000);
    await post("variation-bill", {}, v.id);
    const steps = journal().filter((e) => e.action.startsWith("customer_invoice.variation_"));
    expect(steps.map((e) => e.action)).toEqual(["customer_invoice.variation_added", "customer_invoice.variation_approved", "customer_invoice.variation_billed"]);
    expect(steps.every((e) => e.metadata?.number === "V1" && e.jobId === "tower")).toBe(true);
    expect(JSON.stringify(steps)).not.toMatch(/110000|120000|1,100|1,200/);
    for (const e of steps) expect(AUDIT_ACTIONS).toContain(e.action);
  });
});

describe("payment-claim wording", () => {
  const set = (on: boolean, expectedVersion: number | null, jobId = "tower") => call({ method: "PUT", query: { action: "payment-claim" }, body: { jobId, on, expectedVersion } });

  it("is off for every job until the office turns it on for that one", async () => {
    expect(payload(await call({ query: { jobId: "tower" } })).profile.paymentClaim).toBe(false);
    const on = payload(await set(true, null));
    expect(on.profile).toMatchObject({ paymentClaim: true, version: 1, retentionBp: 0 });
    expect(payload(await call({ query: { jobId: "shop" } })).profile.paymentClaim).toBe(false);
    expect(payload(await set(false, 1)).profile.paymentClaim).toBe(false);
  });

  it("doesn't disturb the job's retention or client link, and is journalled", async () => {
    await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 500, expectedVersion: null } });
    const on = payload(await set(true, 1));
    expect(on.profile).toMatchObject({ paymentClaim: true, retentionBp: 500, version: 2 });
    expect(journal().some((e) => e.summary === "Turned payment-claim wording on for Tower Fit-out")).toBe(true);
    expect([(await set(false, 1)).statusCode, (await set(true, 2, "nope")).statusCode, (await call({ method: "PUT", query: { action: "payment-claim" }, body: { jobId: "tower", on: "yes", expectedVersion: 2 } })).statusCode]).toEqual([409, 404, 400]);
  });
});
