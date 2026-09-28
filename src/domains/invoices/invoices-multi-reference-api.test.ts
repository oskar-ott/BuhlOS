import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Task E (2026-09-27): a supplier invoice that prints SEVERAL different IV job
 * references. BuhlOS cannot split one invoice across jobs, so such a document
 *   - is never confirmed by the ordinary click, even after a job is chosen;
 *   - is never booked automatically (the sweep shares the same blocker);
 *   - may be allocated WHOLE to one job only with an explicit "entire invoice"
 *     decision and a reason, both written to its history and the audit journal;
 *   - may be excluded only with a reason;
 *   - otherwise stays in review and touches no job's cost.
 * Real handler, signed sessions, in-memory Blob + PG store (same scaffolding
 * as invoices-api.test.ts).
 */
const requireFromHere = createRequire(import.meta.url);
const resolve = (p: string) => requireFromHere.resolve(p);
const blobPath = resolve("../../../api/_lib/blob.js");
const authPath = resolve("../../../api/_lib/auth.js");
const flagsPath = resolve("../../../api/_lib/feature-flags.js");
const auditPath = resolve("../../../api/_lib/audit-log.js");
const dbPath = resolve("../../../api/_lib/supabase-db.js");
const storePath = resolve("../../../api/_lib/invoices/store.js");
const pdfTextPath = resolve("../../../api/_lib/invoices/pdf-text.js");
const docStorePath = resolve("../../../api/_lib/invoices/document-store.js");
const pipelinePath = resolve("../../../api/_lib/invoices/pipeline.js");
const handlerPath = resolve("../../../api/invoices.js");

type Res = ReturnType<typeof createRes>;
type Detail = {
  invoice: Record<string, unknown> & { status: string; matchStatus: string; matchedJobId: string | null; reviewReasons: string[] };
  canConfirm: boolean;
  confirmBlockers: string[];
  multiReferences: string[];
  allocations: Array<{ jobId: string; status: string; amountCents: number }>;
  events: Array<{ event: string; detail: Record<string, unknown> }>;
};

let blob: Map<string, unknown>;
let store: MemoryStore;
let docs: Map<string, Buffer>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    ended: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; },
    end(payload?: unknown) { this.ended = payload ?? null; return this; },
  };
}
function cookieFor(userId: string, role: string) {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(opts: { method?: string; role?: string; userId?: string; query?: Record<string, string>; body?: unknown }): Promise<Res> {
  const res = createRes();
  await handler({
    method: opts.method || "GET",
    query: opts.query || {},
    body: opts.body,
    headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role || "admin") },
  }, res);
  return res;
}
function dataUrl(text: string) {
  return `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n" + text).toString("base64")}`;
}
async function uploadedId(text: string): Promise<string> {
  const r = await call({ method: "POST", query: { action: "upload" }, body: { filename: "inv.pdf", dataUrl: dataUrl(text) } });
  expect(r.statusCode).toBe(201);
  return (r.body as { invoice: { id: string } }).invoice.id;
}
async function detailOf(id: string): Promise<Detail> {
  const r = await call({ query: { id } });
  expect(r.statusCode).toBe(200);
  return r.body as Detail;
}
function journal() {
  const out: Array<{ action: string; metadata?: Record<string, unknown>; summary: string }> = [];
  for (const [k, v] of blob) if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  return out;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_INVOICE_CAPTURE = "true";
  delete process.env.INVOICE_AI_EXTRACTION;
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: F.JOBS }],
    ["users.json", { users: [{ id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] }] }],
  ]);
  store = createMemoryStore();
  docs = new Map();
  for (const p of [authPath, flagsPath, auditPath, pipelinePath, handlerPath]) delete requireFromHere.cache[p];
  const mock = (path: string, exports: unknown) => {
    requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
  };
  mock(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
    writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
    setNoCache: vi.fn(),
  });
  mock(dbPath, { getDb: () => ({}) });
  mock(storePath, store);
  mock(pdfTextPath, { extractPdfText: async (bytes: Buffer) => { const text = bytes.toString().replace(/^%PDF-1\.4\n/, ""); return { text, pageCount: 1, hasTextLayer: true }; } });
  mock(docStorePath, {
    storeInvoicePdf: async ({ invoiceId, filename, bytes }: { invoiceId: string; filename: string; bytes: Buffer }) => { const p = `invoices/buhl/${invoiceId}/${filename}`; docs.set(p, bytes); return { url: `blob://${p}`, pathname: p }; },
    fetchInvoicePdf: async (url: string) => { const b = docs.get(url.slice("blob://".length)); if (!b) throw Object.assign(new Error("missing"), { code: "document_unavailable" }); return b; },
    sha256Hex: (b: Buffer) => requireFromHere("node:crypto").createHash("sha256").update(b).digest("hex"),
  });
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});
afterEach(() => {
  delete process.env.FLAG_INVOICE_CAPTURE;
});

describe("a document printing several job references", () => {
  it("lands in review with both references exposed, and cannot be confirmed", async () => {
    const id = await uploadedId(F.INVOICE_MULTI_REFERENCE);
    const d = await detailOf(id);
    expect(d.invoice).toMatchObject({ status: "needs_review", matchStatus: "multi_reference", matchedJobId: null });
    expect(d.multiReferences).toEqual(["IV0041", "IV0042"]);
    expect(d.canConfirm).toBe(false);
    expect(d.confirmBlockers).toContain("multi_reference");
  });

  it("choosing a job does not make several references one: still in review, still blocked, references still shown", async () => {
    const id = await uploadedId(F.INVOICE_MULTI_REFERENCE);
    const r = await call({ method: "POST", query: { action: "select-job", id }, body: { jobId: "birdwood" } });
    expect(r.statusCode).toBe(200);
    const d = r.body as Detail;
    expect(d.invoice).toMatchObject({ matchedJobId: "birdwood", matchStatus: "manual", status: "needs_review" });
    expect(d.invoice.reviewReasons).toContain("multi_reference");
    expect(d.multiReferences).toEqual(["IV0041", "IV0042"]);
    expect(d.canConfirm).toBe(false);
    expect(d.confirmBlockers).toEqual(["multi_reference"]);
  });

  it("the ordinary confirm is refused (409) and books nothing", async () => {
    const id = await uploadedId(F.INVOICE_MULTI_REFERENCE);
    await call({ method: "POST", query: { action: "select-job", id }, body: { jobId: "birdwood" } });
    const r = await call({ method: "POST", query: { action: "confirm", id } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ error: "cannot_confirm", blockers: ["multi_reference"], references: ["IV0041", "IV0042"] });
    expect(store.allocations).toEqual([]);
    expect(journal().map((e) => e.action)).not.toContain("invoice.confirmed");
  });

  it("the whole-invoice decision needs a reason: 400 without one, still nothing booked", async () => {
    const id = await uploadedId(F.INVOICE_MULTI_REFERENCE);
    await call({ method: "POST", query: { action: "select-job", id }, body: { jobId: "birdwood" } });
    const r = await call({ method: "POST", query: { action: "confirm", id }, body: { wholeInvoice: true, reason: "  " } });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatchObject({ error: "reason_required", references: ["IV0041", "IV0042"] });
    expect(store.allocations).toEqual([]);
  });

  it("with the explicit decision and a reason the WHOLE invoice books on that one job — the references, job, actor and reason go on the record", async () => {
    const id = await uploadedId(F.INVOICE_MULTI_REFERENCE);
    await call({ method: "POST", query: { action: "select-job", id }, body: { jobId: "birdwood" } });
    const r = await call({ method: "POST", query: { action: "confirm", id }, body: { wholeInvoice: true, reason: "the second number is the customer's PO, not a job" } });
    expect(r.statusCode).toBe(200);
    const d = r.body as Detail;
    expect(d.invoice.status).toBe("confirmed");
    expect(store.allocations).toHaveLength(1);
    expect(store.allocations[0]).toMatchObject({ jobId: "birdwood", status: "active", amountCents: 10000 });
    const events = (store.events as Array<{ event: string; detail: Record<string, unknown>; actor: unknown }>).map((e) => e.event);
    const overrideIdx = events.indexOf("multi_reference_override");
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeLessThan(events.lastIndexOf("confirmed"));
    const override = (store.events as Array<{ event: string; detail: Record<string, unknown>; actor: unknown }>)[overrideIdx];
    expect(override?.detail).toMatchObject({ references: ["IV0041", "IV0042"], jobId: "birdwood", jobCode: "IV0041", reason: "the second number is the customer's PO, not a job" });
    expect(override?.actor).toBe("Karen Boss");
    const audit = journal();
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["invoice.multi_reference_override", "invoice.confirmed"]));
    const entry = audit.find((e) => e.action === "invoice.multi_reference_override");
    expect(entry?.metadata).toMatchObject({ references: ["IV0041", "IV0042"], jobId: "birdwood", reason: "the second number is the customer's PO, not a job" });
    expect(entry?.summary).toContain("IV0041, IV0042");
  });

  it("a whole-invoice decision cannot pass any OTHER blocker (no job → 400 no_job; the reason alone is not a key)", async () => {
    const id = await uploadedId(F.INVOICE_MULTI_REFERENCE);
    const r = await call({ method: "POST", query: { action: "confirm", id }, body: { wholeInvoice: true, reason: "sure" } });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatchObject({ error: "no_job" });
    expect(store.allocations).toEqual([]);
  });

  it("excluding needs a reason (400), and with one the document keeps its history and touches no cost", async () => {
    const id = await uploadedId(F.INVOICE_MULTI_REFERENCE);
    expect((await call({ method: "POST", query: { action: "exclude", id } })).statusCode).toBe(400);
    expect((await call({ method: "POST", query: { action: "exclude", id }, body: { reason: "" } })).body).toMatchObject({ error: "reason_required" });
    const r = await call({ method: "POST", query: { action: "exclude", id }, body: { reason: "belongs to two jobs — costed by hand" } });
    expect(r.statusCode).toBe(200);
    const d = r.body as Detail;
    expect(d.invoice).toMatchObject({ status: "excluded", excludedReason: "belongs to two jobs — costed by hand" });
    expect(store.allocations).toEqual([]);
    expect(d.events.map((e) => e.event)).toContain("excluded");
  });

  it("left alone it stays in review with no allocation and no verdict to book it", async () => {
    const id = await uploadedId(F.INVOICE_MULTI_REFERENCE);
    const d = await detailOf(id);
    expect(d.invoice.status).toBe("needs_review");
    expect(store.allocations).toEqual([]);
    expect(d.events.map((e) => e.event)).not.toContain("auto_confirm_scheduled");
    expect(d.events.map((e) => e.event)).not.toContain("auto_confirm_eligible");
  });

  it("a document with ONE reference is untouched by the rule: no blocker, no multiReferences", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    const d = await detailOf(id);
    expect(d.multiReferences).toEqual([]);
    expect(d.confirmBlockers).not.toContain("multi_reference");
  });
});
