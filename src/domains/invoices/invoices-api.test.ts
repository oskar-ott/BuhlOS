import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * api/invoices.js — the real handler with signed sessions, the flag via env,
 * an in-memory Blob (jobs.json + audit journal), the in-memory PG store, a
 * text-extractor that reads the fixture text straight out of the "PDF" bytes,
 * and an in-memory document store. Covers gating, upload → match, the
 * double-counting guarantees, credit notes, corrections, exclusion reversal,
 * reassignment and secure document access.
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

async function call(opts: { method?: string; role?: string; userId?: string; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> }): Promise<Res> {
  const res = createRes();
  await handler({
    method: opts.method || "GET",
    query: opts.query || {},
    body: opts.body,
    headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role || "admin"), ...(opts.headers || {}) },
  }, res);
  return res;
}

function pdfOf(text: string) {
  return Buffer.from("%PDF-1.4\n" + text);
}
function dataUrl(text: string) {
  return `data:application/pdf;base64,${pdfOf(text).toString("base64")}`;
}
async function upload(text: string, filename = "inv.pdf") {
  return call({ method: "POST", query: { action: "upload" }, body: { filename, dataUrl: dataUrl(text) } });
}
function journal() {
  const out: Array<{ action: string; targetType: string; metadata?: Record<string, unknown> }> = [];
  for (const [k, v] of blob) if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  return out;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_INVOICE_CAPTURE = "true";
  delete process.env.INVOICE_AI_EXTRACTION;
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: F.JOBS }],
    ["users.json", { users: [
      { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      { id: "u_lh", username: "lead", name: "Lead Hand", role: "leadingHand", assignedJobIds: ["birdwood"] },
      { id: "u_field", username: "sparky", name: "Sparky", role: "electrician", assignedJobIds: ["birdwood"] },
    ] }],
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
  mock(pdfTextPath, { extractPdfText: async (bytes: Buffer) => { const text = bytes.toString().replace(/^%PDF-1\.4\n/, ""); return { text, pageCount: 1, hasTextLayer: text !== "SCANNED" }; } });
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

describe("api/invoices — gating", () => {
  it("is invisible (404) while the flag is off, on every route including the document proxy", async () => {
    delete process.env.FLAG_INVOICE_CAPTURE;
    const probes: Array<Parameters<typeof call>[0]> = [{}, { query: { action: "setup" } }, { query: { action: "document", id: "x" } }, { method: "POST", query: { action: "upload" } }];
    for (const p of probes) {
      const r = await call({ ...p });
      expect(r.statusCode, JSON.stringify(p)).toBe(404);
    }
    expect(store.invoices).toEqual([]);
  });
  it("is admin-tier only: below the tier the flag targeting makes it a 404 (invisible), no session gets 401", async () => {
    // invoice_capture targets the admin tier, so a leading hand / field worker
    // never even learns the feature exists; the isAdminRole 403 is defence in
    // depth behind that.
    expect((await call({ role: "leadingHand", userId: "u_lh" })).statusCode).toBe(404);
    expect((await call({ role: "electrician", userId: "u_field" })).statusCode).toBe(404);
    expect((await call({ method: "POST", role: "electrician", userId: "u_field", query: { action: "upload" }, body: { dataUrl: dataUrl("x") } })).statusCode).toBe(404);
    expect(store.invoices).toEqual([]);
    const res = createRes();
    await handler({ method: "GET", query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(401);
  });
  it("admits the whole admin tier (boss/office), not just the literal admin role", async () => {
    expect((await call({ role: "office" })).statusCode).toBe(200);
    expect((await call({ role: "boss" })).statusCode).toBe(200);
  });
  it("the cron sweep needs CRON_SECRET in production and no-ops while the flag is off", async () => {
    delete process.env.FLAG_INVOICE_CAPTURE;
    process.env.CRON_SECRET = "cs";
    const res = createRes();
    await handler({ method: "GET", query: { action: "sweep" }, headers: { authorization: "Bearer cs" } }, res);
    expect(res.body).toEqual({ skipped: "flag_off" });
    const denied = createRes();
    await handler({ method: "GET", query: { action: "sweep" }, headers: {} }, denied);
    expect(denied.statusCode).toBe(401);
    delete process.env.CRON_SECRET;
  });
});

describe("api/invoices — upload → extraction → exact match", () => {
  it("captures a PDF, keeps the original, reads it and proposes an exact match without costing anything", async () => {
    const r = await upload(F.TAX_INVOICE_IV0041, "../evil/SS-88123.pdf");
    expect(r.statusCode).toBe(201);
    const d = r.body as { invoice: Record<string, unknown>; documents: Array<Record<string, unknown>>; job: Record<string, unknown>; canConfirm: boolean; allocations: unknown[] };
    expect(d.invoice).toMatchObject({ status: "matched", matchStatus: "exact", matchedJobId: "birdwood", ivReference: "IV0041", supplierInvoiceNumber: "SS-88123", subtotalCents: 108000, gstCents: 10800, totalCents: 118800, source: "upload" });
    expect(d.job).toMatchObject({ id: "birdwood", code: "IV0041" });
    expect(d.documents[0]).toMatchObject({ filename: "SS-88123.pdf", byteSize: pdfOf(F.TAX_INVOICE_IV0041).length });
    expect(d.documents[0]).not.toHaveProperty("blobUrl");
    expect(d.canConfirm).toBe(true);
    expect(d.allocations).toEqual([]);
    expect(docs.size).toBe(1);
    expect(journal().map((e) => e.action)).toEqual(["invoice.uploaded"]);
  });
  it("rejects a fake PDF (extension only), an empty upload and an oversized file", async () => {
    expect((await call({ method: "POST", query: { action: "upload" }, body: { filename: "x.pdf", dataUrl: `data:application/pdf;base64,${Buffer.from("MZ exe").toString("base64")}` } })).body).toEqual({ error: "not_a_pdf_or_image" });
    expect((await call({ method: "POST", query: { action: "upload" }, body: {} })).body).toEqual({ error: "file_required" });
    const huge = `data:application/pdf;base64,${Buffer.alloc(3 * 1024 * 1024 + 10).toString("base64")}`;
    const r = await call({ method: "POST", query: { action: "upload" }, body: { filename: "x.pdf", dataUrl: huge } });
    expect(r.statusCode).toBe(413);
    expect(store.invoices).toEqual([]);
  });
  it("the same invoice uploaded twice is a duplicate the second time", async () => {
    await upload(F.TAX_INVOICE_IV0041);
    const r = await upload(F.TAX_INVOICE_IV0041);
    const d = r.body as { invoice: Record<string, unknown>; duplicateOf: Record<string, unknown> };
    expect(d.invoice).toMatchObject({ status: "duplicate", duplicateReason: "checksum" });
    expect(d.duplicateOf).toMatchObject({ supplierInvoiceNumber: "SS-88123" });
    expect((await call({ method: "POST", query: { action: "confirm", id: d.invoice.id as string } })).statusCode).toBe(409);
  });
  it("lists with counts, filters and pagination; job summary reflects only confirmed allocations", async () => {
    await upload(F.TAX_INVOICE_IV0041);
    await upload(F.INVOICE_UNKNOWN_IV);
    await upload(F.STATEMENT);
    const list = (await call({ query: { limit: "2" } })).body as { invoices: unknown[]; total: number; counts: Record<string, number> };
    expect(list.total).toBe(3);
    expect(list.invoices).toHaveLength(2);
    expect(list.counts).toEqual({ matched: 1, needs_review: 2 });
    const review = (await call({ query: { status: "needs_review" } })).body as { invoices: Array<{ documentType: string }> };
    expect(review.invoices.map((i) => i.documentType).sort()).toEqual(["statement", "tax_invoice"]);
    const byJob = (await call({ query: { jobId: "birdwood" } })).body as { invoices: unknown[] };
    expect(byJob.invoices).toHaveLength(1);
    // the statement lists SS-88123 too, so search on the unknown-IV invoice's number
    const q = (await call({ query: { q: "ww-6" } })).body as { invoices: unknown[] };
    expect(q.invoices).toHaveLength(1);
    const summary = (await call({ query: { action: "job-summary", jobId: "birdwood" } })).body as Record<string, unknown>;
    expect(summary).toMatchObject({ confirmedCents: 0, confirmedCount: 0, awaitingCount: 1 });
  });
});

describe("api/invoices — confirmation is transactional, idempotent and the only path into job cost", () => {
  async function uploadedId(text: string) {
    return ((await upload(text)).body as { invoice: { id: string } }).invoice.id;
  }
  it("confirms once; a second click returns the same allocation and never counts twice", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    const first = await call({ method: "POST", query: { action: "confirm", id } });
    expect(first.statusCode).toBe(200);
    const d1 = first.body as { invoice: Record<string, unknown>; allocations: Array<Record<string, unknown>>; alreadyConfirmed: boolean };
    expect(d1.invoice).toMatchObject({ status: "confirmed", confirmedBy: "Karen Boss" });
    expect(d1.allocations).toEqual([expect.objectContaining({ jobId: "birdwood", amountCents: 108000, gstCents: 10800, totalCents: 118800, status: "active" })]);
    expect(d1.alreadyConfirmed).toBe(false);
    const second = await call({ method: "POST", query: { action: "confirm", id } });
    expect(second.statusCode).toBe(200);
    expect((second.body as { alreadyConfirmed: boolean }).alreadyConfirmed).toBe(true);
    expect(store.allocations).toHaveLength(1);
    const summary = (await call({ query: { action: "job-summary", jobId: "birdwood" } })).body as Record<string, unknown>;
    expect(summary).toMatchObject({ confirmedCents: 108000, confirmedCount: 1, awaitingCount: 0 });
    expect(journal().filter((e) => e.action === "invoice.confirmed")).toHaveLength(1);
    expect(journal().find((e) => e.action === "invoice.confirmed")!.metadata).not.toHaveProperty("amountCents");
  });
  it("refuses a client-supplied job that differs from the server match", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    const r = await call({ method: "POST", query: { action: "confirm", id }, body: { jobId: "kent-st" } });
    expect(r.statusCode).toBe(409);
    expect((r.body as { error: string }).error).toBe("job_mismatch");
    expect(store.allocations).toEqual([]);
  });
  it("a credit note is pending until confirmed, then contributes a NEGATIVE allocation", async () => {
    const invId = await uploadedId(F.TAX_INVOICE_IV0041);
    await call({ method: "POST", query: { action: "confirm", id: invId } });
    const cnId = await uploadedId(F.CREDIT_NOTE_IV0041);
    expect(store.invoices[1]).toMatchObject({ status: "matched", documentType: "credit_note", matchedJobId: "birdwood" });
    let summary = (await call({ query: { action: "job-summary", jobId: "birdwood" } })).body as Record<string, unknown>;
    expect(summary).toMatchObject({ confirmedCents: 108000, awaitingCount: 1 });
    const r = await call({ method: "POST", query: { action: "confirm", id: cnId } });
    expect((r.body as { allocations: Array<{ amountCents: number }> }).allocations[0]!.amountCents).toBe(-12000);
    summary = (await call({ query: { action: "job-summary", jobId: "birdwood" } })).body as Record<string, unknown>;
    expect(summary).toMatchObject({ confirmedCents: 96000, confirmedCount: 2, awaitingCount: 0 });
  });
  it("statements and quotes can never be confirmed; excluding them costs nothing", async () => {
    const stId = await uploadedId(F.STATEMENT);
    const r = await call({ method: "POST", query: { action: "confirm", id: stId } });
    expect(r.statusCode).toBe(409);
    expect((r.body as { blockers: string[] }).blockers).toContain("not_allocatable");
    const ex = await call({ method: "POST", query: { action: "exclude", id: stId }, body: { reason: "statement" } });
    expect((ex.body as { invoice: { status: string } }).invoice.status).toBe("excluded");
    expect(store.allocations).toEqual([]);
  });
  it("a missing subtotal or inconsistent totals block confirmation until corrected", async () => {
    const id = await uploadedId(F.INVOICE_GST_INCONSISTENT);
    expect((await call({ method: "POST", query: { action: "confirm", id } })).statusCode).toBe(409);
    const fixed = await call({ method: "PUT", query: { id }, body: { totalCents: 11000 } });
    expect((fixed.body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ totalsConsistent: true, status: "matched" });
    expect((await call({ method: "POST", query: { action: "confirm", id } })).statusCode).toBe(200);
    const id2 = await uploadedId(F.INVOICE_MISSING_SUBTOTAL);
    expect((await call({ method: "POST", query: { action: "confirm", id: id2 } })).statusCode).toBe(409);
    const entered = await call({ method: "PUT", query: { id: id2 }, body: { subtotalCents: 10000, gstCents: 1000 } });
    expect((entered.body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ subtotalCents: 10000, totalCents: 11000, totalsConsistent: true, status: "matched" });
    expect((await call({ method: "POST", query: { action: "confirm", id: id2 } })).statusCode).toBe(200);
    expect(store.allocations.map((a) => a.amountCents)).toEqual([10000, 10000]);
  });
  it("corrections never accept an IV code as the supplier invoice number, nor a malformed IV reference, nor float cents", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    expect((await call({ method: "PUT", query: { id }, body: { supplierInvoiceNumber: "IV0041" } })).statusCode).toBe(400);
    expect((await call({ method: "PUT", query: { id }, body: { ivReference: "IV41" } })).statusCode).toBe(400);
    expect((await call({ method: "PUT", query: { id }, body: { subtotalCents: 10.5 } })).statusCode).toBe(400);
    expect((await call({ method: "PUT", query: { id }, body: { documentType: "receipt" } })).statusCode).toBe(400);
  });
  it("correcting the IV reference re-runs the exact match; an unknown IV code goes back to review", async () => {
    const id = await uploadedId(F.INVOICE_UNKNOWN_IV);
    const r = await call({ method: "PUT", query: { id }, body: { ivReference: "iv 0042" } });
    expect((r.body as { invoice: Record<string, unknown>; job: Record<string, unknown> }).invoice).toMatchObject({ ivReference: "IV0042", matchStatus: "exact", matchedJobId: "kent-st", status: "matched" });
    const back = await call({ method: "PUT", query: { id }, body: { ivReference: "IV0777" } });
    expect((back.body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ matchStatus: "not_found", matchedJobId: null, status: "needs_review" });
  });
  it("selecting a job by hand works, deleted jobs are refused, and manual choice is recorded", async () => {
    const id = await uploadedId(F.INVOICE_NO_REFERENCE);
    expect((await call({ method: "POST", query: { action: "select-job", id }, body: { jobId: "deleted" } })).statusCode).toBe(404);
    const r = await call({ method: "POST", query: { action: "select-job", id }, body: { jobId: "birdwood" } });
    expect((r.body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ matchedJobId: "birdwood", matchStatus: "manual", status: "matched" });
    expect((await call({ method: "POST", query: { action: "confirm", id } })).statusCode).toBe(200);
    expect(journal().map((e) => e.action)).toContain("invoice.job_selected");
  });
  it("excluding a confirmed invoice reverses its allocation and keeps the history", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    await call({ method: "POST", query: { action: "confirm", id } });
    const r = await call({ method: "POST", query: { action: "exclude", id }, body: { reason: "not ours" } });
    const d = r.body as { invoice: Record<string, unknown>; allocations: Array<Record<string, unknown>> };
    expect(d.invoice.status).toBe("excluded");
    expect(d.allocations).toEqual([expect.objectContaining({ status: "reversed", reversalReason: "excluded", reversedBy: "Karen Boss" })]);
    const summary = (await call({ query: { action: "job-summary", jobId: "birdwood" } })).body as Record<string, unknown>;
    expect(summary).toMatchObject({ confirmedCents: 0, confirmedCount: 0 });
    // restore puts it back to review with no allocation — it must be confirmed again
    const restored = await call({ method: "POST", query: { action: "restore", id } });
    expect((restored.body as { invoice: { status: string } }).invoice.status).toBe("needs_review");
    expect((await call({ method: "POST", query: { action: "confirm", id } })).statusCode).toBe(200);
    expect(store.allocations.filter((a) => a.status === "active")).toHaveLength(1);
  });
  it("archiving a confirmed invoice reverses the cost; archiving keeps the document", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    await call({ method: "POST", query: { action: "confirm", id } });
    const r = await call({ method: "POST", query: { action: "archive", id } });
    expect((r.body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ status: "archived" });
    expect(store.allocations[0]!.status).toBe("reversed");
    expect(store.documents).toHaveLength(1);
    expect((await call({ query: { action: "document", id } })).statusCode).toBe(200);
  });
  it("reassigning moves the cost between jobs atomically with the previous allocation kept", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    await call({ method: "POST", query: { action: "confirm", id } });
    const r = await call({ method: "POST", query: { action: "reassign", id }, body: { jobId: "kent-st" } });
    expect((r.body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ status: "confirmed", matchedJobId: "kent-st", matchStatus: "manual" });
    expect(store.allocations.map((a) => [a.jobId, a.status])).toEqual([["birdwood", "reversed"], ["kent-st", "active"]]);
    const a = (await call({ query: { action: "job-summary", jobId: "birdwood" } })).body as Record<string, unknown>;
    const b = (await call({ query: { action: "job-summary", jobId: "kent-st" } })).body as Record<string, unknown>;
    expect(a.confirmedCents).toBe(0);
    expect(b.confirmedCents).toBe(108000);
    expect((await call({ method: "POST", query: { action: "reassign", id }, body: { jobId: "kent-st" } })).statusCode).toBe(200);
    expect(store.allocations).toHaveLength(2);
  });
  it("marking a duplicate by hand and retrying a document are journalled", async () => {
    const id = await uploadedId(F.INVOICE_NO_REFERENCE);
    const dup = await call({ method: "POST", query: { action: "mark-duplicate", id } });
    expect((dup.body as { invoice: { status: string } }).invoice.status).toBe("duplicate");
    await call({ method: "POST", query: { action: "restore", id } });
    const retried = await call({ method: "POST", query: { action: "retry", id } });
    expect((retried.body as { invoice: { status: string; attemptCount: number } }).invoice).toMatchObject({ status: "needs_review", attemptCount: 1 });
    expect(journal().map((e) => e.action)).toEqual(expect.arrayContaining(["invoice.marked_duplicate", "invoice.restored", "invoice.retried"]));
  });
  it("unknown ids and unknown actions fail with stable codes", async () => {
    expect((await call({ query: { id: "00000000-0000-4000-8000-ffffffffffff" } })).statusCode).toBe(404);
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    expect((await call({ method: "POST", query: { action: "explode", id } })).body).toEqual({ error: "unknown action" });
    expect((await call({ method: "DELETE", query: { id } })).statusCode).toBe(405);
  });
});

describe("api/invoices — secure document access", () => {
  it("streams the original PDF to an admin with no-store caching and never exposes the blob URL", async () => {
    const id = ((await upload(F.TAX_INVOICE_IV0041)).body as { invoice: { id: string } }).invoice.id;
    const r = await call({ query: { action: "document", id } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["content-disposition"]).toContain("inv.pdf");
    expect(Buffer.isBuffer(r.ended)).toBe(true);
    expect(JSON.stringify((await call({ query: { id } })).body)).not.toContain("blob://");
  });
  it("refuses the document to non-admin sessions and while the flag is off", async () => {
    const id = ((await upload(F.TAX_INVOICE_IV0041)).body as { invoice: { id: string } }).invoice.id;
    expect((await call({ role: "leadingHand", userId: "u_lh", query: { action: "document", id } })).statusCode).toBe(404);
    delete process.env.FLAG_INVOICE_CAPTURE;
    expect((await call({ query: { action: "document", id } })).statusCode).toBe(404);
  });
});

describe("api/invoices — photos, attach-to-record, Did-you-mean, batch sizes", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
  it("uploads a photo: captured as an image document, served with its own content type, review for manual entry", async () => {
    const r = await call({ method: "POST", query: { action: "upload" }, body: { filename: "IMG_1.pdf", dataUrl: `data:image/png;base64,${PNG.toString("base64")}` } });
    expect(r.statusCode).toBe(201);
    const body = r.body as { invoice: { id: string; status: string; reviewReasons: string[] }; documents: Array<{ kind: string; filename: string; contentType: string }> };
    expect(body.invoice).toMatchObject({ status: "needs_review", reviewReasons: ["image_only"] });
    expect(body.documents[0]).toMatchObject({ kind: "image", filename: "IMG_1.png", contentType: "image/png" });
    const doc = await call({ query: { action: "document", id: body.invoice.id } });
    expect(doc.headers["content-type"]).toBe("image/png");
    expect(doc.headers["content-disposition"]).toContain("IMG_1.png");
  });
  it("refuses a file that is neither a PDF nor a photo", async () => {
    const r = await call({ method: "POST", query: { action: "upload" }, body: { filename: "x.pdf", dataUrl: `data:application/pdf;base64,${Buffer.from("GIF89a nope").toString("base64")}` } });
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: "not_a_pdf_or_image" });
    expect(store.invoices).toEqual([]);
  });
  it("attach: a link-only email record gets its PDF, is read and matched at once; a second attach is refused", async () => {
    const row = await (store.createInvoice as (...a: unknown[]) => Promise<{ id: string }>)(null, "t", { source: "email", sourceEmailId: "e9", status: "needs_review", reviewReasons: ["no_attachment"], sourceLinks: ["https://portal.example/inv/1"] });
    const r = await call({ method: "POST", query: { action: "attach", id: row.id }, body: { filename: "inv.pdf", dataUrl: dataUrl(F.TAX_INVOICE_IV0041) } });
    expect(r.statusCode).toBe(200);
    const body = r.body as { invoice: { status: string; matchedJobId: string; reviewReasons: string[] }; documents: unknown[]; canConfirm: boolean };
    expect(body.invoice).toMatchObject({ status: "matched", matchedJobId: "birdwood", reviewReasons: [] });
    expect(body.documents).toHaveLength(1);
    expect(body.canConfirm).toBe(true);
    expect(store.events.filter((e) => e.invoiceId === row.id).map((e) => e.event)).toContain("attached");
    expect(journal().some((j) => j.action === "invoice.uploaded" && j.metadata?.attached === true)).toBe(true);
    const again = await call({ method: "POST", query: { action: "attach", id: row.id }, body: { filename: "inv.pdf", dataUrl: dataUrl(F.TAX_INVOICE_IV0041) } });
    expect(again.statusCode).toBe(409);
    expect(again.body).toEqual({ error: "already_has_document" });
  });
  it("attach is refused on a confirmed record", async () => {
    const id = ((await upload(F.TAX_INVOICE_IV0041)).body as { invoice: { id: string } }).invoice.id;
    await call({ method: "POST", query: { action: "confirm", id }, body: {} });
    const r = await call({ method: "POST", query: { action: "attach", id }, body: { filename: "inv.pdf", dataUrl: dataUrl(F.TAX_INVOICE_IV0041) } });
    expect(r.statusCode).toBe(409);
  });
  it("the detail offers near-miss jobs for an unknown IV number; choosing one is the ordinary select-job path", async () => {
    blob.set("jobs.json", { jobs: [...F.JOBS, { id: "j0099", name: "Ninety-nine", code: "IV0099", status: "active" }] });
    const id = ((await upload(F.INVOICE_UNKNOWN_IV)).body as { invoice: { id: string } }).invoice.id;
    const detail = (await call({ query: { id } })).body as { suggestions: Array<{ id: string; code: string }> };
    expect(detail.suggestions).toEqual([{ id: "j0099", name: "Ninety-nine", code: "IV0099", status: "active" }]);
    const chosen = await call({ method: "POST", query: { action: "select-job", id }, body: { jobId: "j0099" } });
    expect((chosen.body as { invoice: { matchedJobId: string; matchStatus: string; ivReference: string } }).invoice).toMatchObject({ matchedJobId: "j0099", matchStatus: "manual", ivReference: "IV0999" });
  });
  it("a docket upload lands set aside with a human-readable reason, and restore brings it back to review", async () => {
    const r = await upload("Sparky Supplies Pty Ltd\nDELIVERY DOCKET\nDocket No: DD-1\nJob Number: IV 0041\nQty 10 cable");
    const body = r.body as { invoice: { id: string; status: string; excludedReason: string } };
    expect(body.invoice).toMatchObject({ status: "excluded", excludedReason: "not_an_invoice:delivery_docket" });
    const restored = await call({ method: "POST", query: { action: "restore", id: body.invoice.id }, body: {} });
    expect((restored.body as { invoice: { status: string } }).invoice.status).toBe("needs_review");
  });
});

describe("api/invoices — line items, re-filing, and the job materials breakdown (2026-09-24)", () => {
  const WHOLESALER = [
    "Wholesale Wires Pty Ltd", "TAX INVOICE", "Invoice No: WW-9", "Invoice Date: 10/09/2026", "Job Number: IV0041",
    "Code      Description                          Qty    Unit     Price     Total",
    "CBL2.5T   2.5MM TWIN & EARTH TPS 100M ROLL     3      roll     89.50     268.50",
    "LED9W     9W LED DOWNLIGHT WARM WHITE          12     ea       11.00     132.00",
    "FRT       FREIGHT                              1      ea       15.00     15.00",
    "Sub Total                                                              415.50",
    "GST 10%                                                                41.55",
    "TOTAL INC GST                                                         457.05",
  ].join("\n");
  type Detail = { invoice: { id: string; status: string; linesConsistent: boolean | null }; lines: Array<{ lineNo: number; category: string; categorySource: string; description: string }> };
  type Breakdown = { confirmedCents: number; invoiceCount: number; linesCents: number; byCategory: Array<{ category: string; label: string; cents: number; lineCount: number }>; bySupplier: Array<{ supplierName: string; cents: number }>; lines: Array<{ category: string; signedCents: number }>; invoicesWithoutLines: unknown[] };

  it("the detail carries the filed lines; a re-filed line is remembered and an invalid category refused", async () => {
    const d = (await upload(WHOLESALER)).body as Detail;
    expect(d.invoice.linesConsistent).toBe(true);
    expect(d.lines.map((l) => [l.lineNo, l.category])).toEqual([[1, "cable"], [2, "lighting"], [3, "freight"]]);
    const r = await call({ method: "PUT", query: { action: "line", id: d.invoice.id }, body: { lineNo: 3, category: "consumables" } });
    expect(r.statusCode).toBe(200);
    expect((r.body as Detail).lines[2]).toMatchObject({ category: "consumables", categorySource: "manual" });
    expect(store.learned).toEqual([expect.objectContaining({ supplierKey: "wholesale wires", descriptionKey: "frt freight", category: "consumables" })]);
    expect(store.events.filter((e) => e.event === "line_corrected")).toHaveLength(1);
    expect(journal().some((j) => j.action === "invoice.corrected" && j.metadata?.lineNo === 3)).toBe(true);
    expect((await call({ method: "PUT", query: { action: "line", id: d.invoice.id }, body: { lineNo: 3, category: "stuff" } })).statusCode).toBe(400);
    expect((await call({ method: "PUT", query: { action: "line", id: d.invoice.id }, body: { lineNo: 9, category: "cable" } })).statusCode).toBe(404);
    // the next invoice from the same supplier files FREIGHT the remembered way
    const again = (await upload(WHOLESALER.replace("WW-9", "WW-10"))).body as Detail;
    expect(again.lines[2]).toMatchObject({ category: "consumables", categorySource: "learned" });
  });
  it("the job breakdown sums confirmed lines by category, counts a credit note negative, and lists unitemised invoices", async () => {
    const d = (await upload(WHOLESALER)).body as Detail;
    expect((await call({ query: { action: "job-materials", jobId: "birdwood" } })).body).toMatchObject({ confirmedCents: 0, invoiceCount: 0, byCategory: [] }); // nothing until confirmed
    await call({ method: "POST", query: { action: "confirm", id: d.invoice.id }, body: {} });
    // the credit-note fixture prints no priced lines → confirmed, counted negative, listed as unitemised
    const cn = (await upload(F.CREDIT_NOTE_IV0041)).body as Detail;
    expect(cn.lines).toEqual([]);
    await call({ method: "POST", query: { action: "confirm", id: cn.invoice.id }, body: {} });
    const b = (await call({ query: { action: "job-materials", jobId: "birdwood" } })).body as Breakdown;
    expect(b).toMatchObject({ invoiceCount: 2, confirmedCents: 41550 - 12000, linesCents: 41550 });
    expect(b.byCategory.map((c) => [c.category, c.label, c.cents, c.lineCount])).toEqual([["cable", "Cable", 26850, 1], ["lighting", "Lighting", 13200, 1], ["freight", "Freight & delivery", 1500, 1]]);
    expect(b.bySupplier).toEqual([{ supplierName: "Wholesale Wires Pty Ltd", cents: 41550 }]);
    expect(b.invoicesWithoutLines).toEqual([expect.objectContaining({ invoiceId: cn.invoice.id, amountCents: -12000 })]);
  });
  it("refuses to re-file lines on an archived invoice", async () => {
    const d = (await upload(WHOLESALER)).body as Detail;
    await call({ method: "POST", query: { action: "archive", id: d.invoice.id }, body: {} });
    expect((await call({ method: "PUT", query: { action: "line", id: d.invoice.id }, body: { lineNo: 1, category: "other" } })).statusCode).toBe(409);
  });
});
