import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore, type StoreFn } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Receipts from the field (owner pull 2026-09-25): a worker photographs a card
 * receipt, picks the job, the photo is read (vision), and it lands in the
 * office inbox like any invoice — the worker's job choice stands, GST-inclusive
 * lines become ex GST, unreadable photos go to a person with the job kept, and
 * a receipt books itself only when the owner allows it and nobody needs
 * paying back.
 */
const requireFromHere = createRequire(import.meta.url);
const rc = requireFromHere("../../../api/_lib/invoices/receipt.js");
const vx = requireFromHere("../../../api/_lib/invoices/vision-extract.js");
const { processInvoice } = requireFromHere("../../../api/_lib/invoices/pipeline.js");
const { evaluateAutoConfirm } = requireFromHere("../../../api/_lib/invoices/auto-confirm.js");

const BUNNINGS = {
  legible: true, documentType: "receipt", storeName: "Bunnings Warehouse", abn: "63 008 672 179", receiptNumber: "4471-0023", date: "2026-09-24",
  subtotalExGstCents: null, gstCents: 768, totalCents: 8450, pricesIncludeGst: true, ivReference: null, deliveryAddress: null,
  lines: [
    { description: "Clipsal double GPO", quantity: 2, unit: "ea", unitPriceCents: 1450, lineTotalCents: 2900, category: "accessories" },
    { description: "2.5mm TPS 20m", quantity: 1, unit: "ea", unitPriceCents: 5550, lineTotalCents: 5550, category: "cable" },
  ],
};

describe("vision-extract.clean", () => {
  it("keeps only schema-shaped values: bad dates, unknown categories and blank lines are dropped, never guessed", () => {
    const out = vx.clean({ ...BUNNINGS, date: "24/09/2026", lines: [...BUNNINGS.lines, { description: "", category: "cable" }, { description: "Mystery", category: "stuff", quantity: "2" }] });
    expect(out.date).toBeNull();
    expect(out.lines).toHaveLength(3);
    expect(out.lines[2]).toMatchObject({ description: "Mystery", category: "other", quantity: null });
    expect(vx.clean(null)).toBeNull();
    // found by the first live read: a printed "26 008 672 179" must fit the 11-digit ABN column
    expect(vx.clean({ ...BUNNINGS, abn: "26 008 672 179" }).abn).toBe("26008672179");
    expect(vx.clean({ ...BUNNINGS, abn: "ABN to follow" }).abn).toBeNull();
    expect(vx.VISION_MODEL).toBe("claude-opus-5");
  });
});

describe("photo → pipeline shape", () => {
  it("a retail receipt: ex GST is total − GST (derived, from two printed figures), receipt → tax invoice, no IV", () => {
    const e = rc.extractedFromVision(vx.clean(BUNNINGS));
    expect(e).toMatchObject({ documentType: "tax_invoice", supplierName: "Bunnings Warehouse", supplierInvoiceNumber: "4471-0023", invoiceDate: "2026-09-24", subtotalCents: 7682, gstCents: 768, totalCents: 8450, totalsConsistent: true });
    expect(e.fields.subtotalCents.provenance).toBe("derived");
    expect(e.fields.totalCents.provenance).toBe("ocr");
    expect(e.ivSelection.outcome).toBe("none");
  });
  it("GST-inclusive line prices are scaled to ex GST and add up to the ex-GST figure exactly", () => {
    const v = vx.clean(BUNNINGS);
    const l = rc.linesFromVision(v, rc.extractedFromVision(v));
    expect(l.lines.map((x: { lineTotalCents: number }) => x.lineTotalCents)).toEqual([2636, 5046]);
    expect(l).toMatchObject({ totalCents: 7682, consistent: true });
  });
  it("lines that don't add up to the printed total are kept as printed and flagged", () => {
    const v = vx.clean({ ...BUNNINGS, lines: [BUNNINGS.lines[0]] });
    const l = rc.linesFromVision(v, rc.extractedFromVision(v));
    expect(l.lines[0].lineTotalCents).toBe(2900);
    expect(l.consistent).toBe(false);
  });
  it("an IV number written on the receipt is read but marked as from the photo (never 'labelled')", () => {
    const e = rc.extractedFromVision(vx.clean({ ...BUNNINGS, ivReference: "iv 3232" }));
    expect(e.ivSelection).toMatchObject({ outcome: "selected", normalised: "IV3232", source: "ocr" });
  });
});

describe("pipeline — a photographed receipt with the worker's job", () => {
  let store: MemoryStore;
  const T = "tenant";
  const JOBS = [...F.JOBS, { id: "sansara", name: "Sansara Gym Double Bay", siteAddress: "2 Bay St Double Bay", status: "active" }];
  async function seedReceipt(over: Record<string, unknown> = {}) {
    const inv = await (store.createInvoice as StoreFn)(null, T, {
      source: "receipt", createdBy: { id: "u_sparky", name: "Sam Sparky" }, matchedJobId: "birdwood", matchStatus: "manual",
      matchReason: { source: "worker", chosenBy: "Sam Sparky", matchCount: 1 }, ...over,
    }) as { id: string };
    await (store.addDocument as StoreFn)(null, T, { invoiceId: inv.id, source: "upload", kind: "image", filename: "r.jpg", contentType: "image/jpeg", byteSize: 10, sha256: "7".repeat(64), blobPathname: "p", blobUrl: "blob://photo" });
    await (store.claimOne as StoreFn)(null, T, inv.id);
    return inv.id;
  }
  const deps = (over: Record<string, unknown> = {}) => ({
    store, fetchPdf: async () => Buffer.from([0xff, 0xd8, 0xff]), extractText: async () => { throw new Error("photos are not text-extracted"); },
    readJobs: async () => JOBS, aiExtract: null, visionExtract: async () => vx.clean(BUNNINGS), ...over,
  });
  beforeEach(() => { store = createMemoryStore(); });

  it("is read, keeps the worker's job (not re-placed by evidence), lands matched with ex-GST lines filed", async () => {
    const id = await seedReceipt();
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "receipt", deps: deps() });
    expect(r).toEqual({ ok: true, status: "matched" });
    const row = store.invoices[0]!;
    expect(row).toMatchObject({ source: "receipt", status: "matched", matchStatus: "manual", matchedJobId: "birdwood", extractionMethod: "ocr", subtotalCents: 7682, totalCents: 8450, reviewReasons: [], linesConsistent: true });
    expect((row.matchReason as { source: string }).source).toBe("worker");
    expect(store.lines.map((l) => [l.description, l.lineTotalCents, l.category, l.categorySource])).toEqual([
      ["Clipsal double GPO", 2636, "accessories", "ai"],
      ["2.5mm TPS 20m", 5046, "cable", "ai"],
    ]);
    expect(store.allocations).toEqual([]); // nothing books without a person / the knob
  });
  it("an unreadable photo goes to a person — the job the worker chose is kept", async () => {
    const id = await seedReceipt();
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "receipt", deps: deps({ visionExtract: async () => ({ ...vx.clean(BUNNINGS), legible: false }) }) });
    expect(store.invoices[0]).toMatchObject({ status: "needs_review", reviewReasons: ["image_only"], matchedJobId: "birdwood", matchStatus: "manual" });
  });
  it("without the reader (feature off / no key) the photo goes to a person, job kept", async () => {
    const id = await seedReceipt();
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "receipt", deps: deps({ visionExtract: null }) });
    expect(store.invoices[0]).toMatchObject({ status: "needs_review", reviewReasons: ["image_only"], matchedJobId: "birdwood" });
  });
  it("a reader outage is a retryable attempt failure, never a lost receipt", async () => {
    const id = await seedReceipt();
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "receipt", deps: deps({ visionExtract: async () => { throw Object.assign(new Error("529"), { code: "provider_error" }); } }) });
    expect(r).toMatchObject({ ok: false, status: "received" });
    expect(store.invoices[0]).toMatchObject({ status: "received", matchedJobId: "birdwood" });
  });
});

describe("auto-booking a receipt", () => {
  const inv = (over: Record<string, unknown> = {}) => ({
    source: "receipt", documentType: "tax_invoice", matchStatus: "manual", matchedJobId: "birdwood", supplierKey: "bunnings warehouse", supplierName: "Bunnings Warehouse",
    supplierInvoiceNumber: "4471-0023", invoiceDate: "2026-09-24", subtotalCents: 7682, gstCents: 768, totalCents: 8450, totalsConsistent: true,
    reviewedAt: null, heldAt: null, duplicateOfId: null, paidPersonally: false,
    fields: { subtotalCents: { value: 7682, provenance: "derived" }, gstCents: { value: 768, provenance: "ocr" }, totalCents: { value: 8450, provenance: "ocr" } },
    matchReason: { source: "worker", matchCount: 1 }, ...over,
  });
  const ctx = (over: Record<string, unknown> = {}) => ({ capCents: 500_000, lookbackDays: 90, supplierHumanConfirmed: true, supplierAlwaysReview: false, supplierConfirmedOnJob: false, jobStatus: "active", now: new Date("2026-09-25T00:00:00Z"), ...over });
  const failed = (v: { checks: Array<{ code: string; ok: boolean }> }) => v.checks.filter((c) => !c.ok).map((c) => c.code);
  it("knob off → waits for a person; knob on → eligible (derived ex GST from printed total + GST counts as printed)", () => {
    expect(failed(evaluateAutoConfirm(inv(), ctx()))).toEqual(["labelled_iv", "exact_match"]);
    expect(evaluateAutoConfirm(inv(), ctx({ allowReceipts: true })).eligible).toBe(true);
  });
  it("paid with the worker's own money → always a person; a store the office never confirmed → a person", () => {
    expect(failed(evaluateAutoConfirm(inv({ paidPersonally: true }), ctx({ allowReceipts: true })))).toEqual(["not_paid_personally"]);
    expect(failed(evaluateAutoConfirm(inv(), ctx({ allowReceipts: true, supplierHumanConfirmed: false })))).toEqual(["supplier_trusted"]);
  });
});

// ── the worker endpoint ─────────────────────────────────────────────────────
const resolve = (p: string) => requireFromHere.resolve(p);
const paths = {
  blob: resolve("../../../api/_lib/blob.js"), auth: resolve("../../../api/_lib/auth.js"), flags: resolve("../../../api/_lib/feature-flags.js"),
  audit: resolve("../../../api/_lib/audit-log.js"), db: resolve("../../../api/_lib/supabase-db.js"), store: resolve("../../../api/_lib/invoices/store.js"),
  pdf: resolve("../../../api/_lib/invoices/pdf-text.js"), docs: resolve("../../../api/_lib/invoices/document-store.js"), pipeline: resolve("../../../api/_lib/invoices/pipeline.js"),
  vision: resolve("../../../api/_lib/invoices/vision-extract.js"), settings: resolve("../../../api/_lib/feature-settings.js"), handler: resolve("../../../api/invoices.js"),
};
type Res = { statusCode: number; body: unknown; status(c: number): Res; json(b: unknown): Res; setHeader(): Res; end(): Res };
function createRes(): Res {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() { return this; }, end() { return this; } };
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]);

describe("POST /api/invoices?action=receipt — the worker's side", () => {
  let blob: Map<string, unknown>;
  let store: MemoryStore;
  let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
  let auth: { signSession: (p: Record<string, unknown>) => string };
  let visionCalls = 0;
  const send = async (role: string, body: Record<string, unknown>, userId = "u_sparky") => {
    const res = createRes();
    await handler({ method: "POST", query: { action: "receipt" }, body, headers: { cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}` } }, res);
    return res;
  };
  const body = (over: Record<string, unknown> = {}) => ({ jobId: "birdwood", filename: "IMG_1.HEIC", dataUrl: `data:image/jpeg;base64,${JPEG.toString("base64")}`, paidPersonally: false, ...over });
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret-long-enough";
    process.env.FLAG_INVOICE_CAPTURE = "true";
    process.env.FLAG_RECEIPT_CAPTURE = "true";
    blob = new Map<string, unknown>([
      ["jobs.json", { jobs: [...F.JOBS, { id: "draft-job", name: "Draft", status: "draft" }] }],
      ["users.json", { users: [
        { id: "u_sparky", username: "sam", name: "Sam Sparky", role: "electrician", assignedJobIds: [] },
        { id: "u_client", username: "cli", name: "Client", role: "client", assignedJobIds: ["birdwood"] },
        { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      ] }],
    ]);
    store = createMemoryStore();
    visionCalls = 0;
    for (const p of [paths.auth, paths.flags, paths.audit, paths.pipeline, paths.settings, paths.handler]) delete requireFromHere.cache[p];
    const mock = (p: string, exports: unknown) => { requireFromHere.cache[p] = { id: p, filename: p, loaded: true, exports } as NodeJS.Module; };
    mock(paths.blob, {
      readBlob: vi.fn(async (k: string, fb: unknown) => (blob.has(k) ? JSON.parse(JSON.stringify(blob.get(k))) : fb)),
      writeBlob: vi.fn(async (k: string, d: unknown) => { blob.set(k, JSON.parse(JSON.stringify(d))); }),
      setNoCache: vi.fn(),
    });
    mock(paths.db, { getDb: () => ({}) });
    mock(paths.store, store);
    mock(paths.pdf, { extractPdfText: async () => { throw new Error("not for photos"); } });
    const docs = new Map<string, Buffer>();
    mock(paths.docs, {
      storeInvoicePdf: async ({ invoiceId, filename, bytes }: { invoiceId: string; filename: string; bytes: Buffer }) => { const p = `invoices/buhl/${invoiceId}/${filename}`; docs.set(p, bytes); return { url: `blob://${p}`, pathname: p }; },
      fetchInvoicePdf: async (url: string) => docs.get(url.slice("blob://".length))!,
      sha256Hex: (b: Buffer) => requireFromHere("node:crypto").createHash("sha256").update(b).digest("hex"),
    });
    mock(paths.vision, { enabled: () => true, visionExtract: async () => { visionCalls++; return vx.clean(BUNNINGS); }, clean: vx.clean, VISION_MODEL: "claude-opus-5" });
    auth = requireFromHere(paths.auth);
    handler = requireFromHere(paths.handler);
  });
  afterEach(() => {
    delete process.env.FLAG_INVOICE_CAPTURE;
    delete process.env.FLAG_RECEIPT_CAPTURE;
  });

  it("an electrician logs a receipt: read at once, logged to the chosen job, told what was read — nothing booked", async () => {
    const r = await send("electrician", body());
    expect(r.statusCode).toBe(201);
    expect(r.body).toMatchObject({ status: "matched", read: true, duplicate: false, storeName: "Bunnings Warehouse", totalCents: 8450, receiptDate: "2026-09-24", lineCount: 2, job: { id: "birdwood", code: "IV0041" }, paidPersonally: false });
    expect(visionCalls).toBe(1);
    expect(store.invoices[0]).toMatchObject({ source: "receipt", createdBy: "Sam Sparky", matchedJobId: "birdwood", matchStatus: "manual" });
    expect(store.documents[0]).toMatchObject({ kind: "image", contentType: "image/jpeg", filename: "IMG_1.jpg" });
    expect(store.events.map((e) => e.event)).toContain("receipt_submitted");
    expect(store.allocations).toEqual([]);
  });
  it("paid with own money is recorded for the office", async () => {
    await send("electrician", body({ paidPersonally: true }));
    expect(store.invoices[0]).toMatchObject({ paidPersonally: true });
  });
  it("the same photo sent twice (a retry on bad signal) never counts twice", async () => {
    await send("electrician", body());
    const again = await send("electrician", body());
    expect(again.body).toMatchObject({ duplicate: true, status: "duplicate" });
  });
  it("refuses: feature off (either flag), a client, a draft or unknown job, a non-image", async () => {
    delete process.env.FLAG_RECEIPT_CAPTURE;
    expect((await send("electrician", body())).statusCode).toBe(404);
    process.env.FLAG_RECEIPT_CAPTURE = "true";
    delete process.env.FLAG_INVOICE_CAPTURE;
    expect((await send("electrician", body())).statusCode).toBe(404);
    process.env.FLAG_INVOICE_CAPTURE = "true";
    expect((await send("client", body(), "u_client")).statusCode).toBe(403);
    expect((await send("electrician", body({ jobId: "draft-job" }))).body).toEqual({ error: "job_not_available" });
    expect((await send("electrician", body({ jobId: "nope" }))).statusCode).toBe(400);
    expect((await send("electrician", body({ dataUrl: `data:image/jpeg;base64,${Buffer.from("GIF89a no").toString("base64")}` }))).body).toEqual({ error: "not_a_pdf_or_image" });
    expect(store.invoices).toEqual([]);
  });
  it("the office sees it in the inbox detail with the worker and the own-money flag", async () => {
    await send("electrician", body({ paidPersonally: true }));
    const res = createRes();
    await handler({ method: "GET", query: { id: store.invoices[0]!.id as string }, headers: { cookie: `buhl_session=${auth.signSession({ userId: "u_admin", role: "admin", exp: Date.now() + 60_000 })}` } }, res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ source: "receipt", createdBy: "Sam Sparky", paidPersonally: true, matchedJobId: "birdwood" });
    expect((res.body as { canConfirm: boolean }).canConfirm).toBe(true);
  });
});
