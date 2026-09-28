import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Task I (2026-09-27): remembered filing (learned product categories) can be
 * LISTED and FORGOTTEN by the office, every removal is audited with a full
 * copy of the rule, and a re-file on a document whose supplier was never
 * read remembers NOTHING (it used to create an any-supplier rule from one
 * uncertain read). Only a person's re-file creates a rule — the pipeline and
 * the AI never write one. Real handler, signed sessions, in-memory store.
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
type Rule = { id: string; supplierKey: string; supplierName: string | null; descriptionKey: string; category: string; setBy: string | null; linesFiledNow: number };
type RuleList = { rules: Rule[]; total: number };
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
  await handler({ method: opts.method || "GET", query: opts.query || {}, body: opts.body, headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role || "admin") } }, res);
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
function journal() {
  const out: Array<{ action: string; targetType: string; targetId: string; summary: string; metadata?: Record<string, unknown> }> = [];
  for (const [k, v] of blob) if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  return out;
}
async function list(): Promise<RuleList> {
  const r = await call({ query: { action: "learned-categories" } });
  expect(r.statusCode).toBe(200);
  return r.body as RuleList;
}

const NO_SUPPLIER = `TAX INVOICE
Invoice No: X-1
Sub Total 100.00
GST 10.00
Total 110.00`;

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_INVOICE_CAPTURE = "true";
  delete process.env.INVOICE_AI_EXTRACTION;
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: F.JOBS }],
    ["users.json", { users: [{ id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] }, { id: "u_lh", username: "lead", name: "Lead Hand", role: "leadingHand", assignedJobIds: ["birdwood"] }] }],
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

/** Give an uploaded invoice one line item to re-file (the fixture text has no line table). */
async function withLine(id: string, description = "2.5mm TPS cable 100m", descriptionKey = "25mm tps cable 100m") {
  const replace = store.replaceInvoiceLines as (s: unknown, t: string, invoiceId: string, lines: Array<Record<string, unknown>>) => Promise<void>;
  await replace(null, "t", id, [{ lineNo: 1, description, descriptionKey, category: "other", categorySource: "rule", confidence: "low" }]);
}

describe("remembered filing — list and forget", () => {
  it("starts empty; a person's re-file creates one rule, listed with supplier, category, who and lines filed now", async () => {
    expect(await list()).toEqual({ rules: [], total: 0 });
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    await withLine(id);
    const r = await call({ method: "PUT", query: { action: "line", id }, body: { lineNo: 1, category: "cable" } });
    expect(r.statusCode).toBe(200);
    const l = await list();
    expect(l.total).toBe(1);
    expect(l.rules[0]).toMatchObject({ supplierName: "Sparky Supplies Pty Ltd", descriptionKey: "25mm tps cable 100m", category: "cable", setBy: "Karen Boss", linesFiledNow: 0 });
    expect(l.rules[0]?.supplierKey).not.toBe("");
  });

  it("forgetting a rule removes it, answers the refreshed list, and journals a full copy under its own target type", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    await withLine(id);
    await call({ method: "PUT", query: { action: "line", id }, body: { lineNo: 1, category: "cable" } });
    const before = await list();
    const ruleId = before.rules[0]!.id;
    const r = await call({ method: "POST", query: { action: "forget-category" }, body: { ruleId } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ rules: [], total: 0 });
    expect(store.learned).toEqual([]);
    const entry = journal().find((e) => e.action === "invoice.learned_category_removed");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ targetType: "supplier_line_category", targetId: ruleId, metadata: { descriptionKey: "25mm tps cable 100m", category: "cable", setBy: "Karen Boss" } });
    expect(entry?.summary).toContain("25mm tps cable 100m");
    expect((await call({ method: "POST", query: { action: "forget-category" }, body: { ruleId } })).statusCode).toBe(404);
    expect((await call({ method: "POST", query: { action: "forget-category" }, body: { ruleId: "not-a-uuid" } })).statusCode).toBe(400);
  });

  it("a re-file on a document whose supplier was never read remembers NOTHING (no any-supplier rule), and says so in its history", async () => {
    const id = await uploadedId(NO_SUPPLIER);
    // The reader guesses a supplier from any line it can; make the document truly nameless, as a scanned receipt can be.
    Object.assign(store.invoices.find((r) => r.id === id)!, { supplierKey: null, supplierName: null });
    await withLine(id);
    const r = await call({ method: "PUT", query: { action: "line", id }, body: { lineNo: 1, category: "cable" } });
    expect(r.statusCode).toBe(200);
    expect(store.learned).toEqual([]);
    expect(await list()).toEqual({ rules: [], total: 0 });
    const ev = (store.events as Array<{ invoiceId: string; event: string; detail: Record<string, unknown> }>).find((e) => e.invoiceId === id && e.event === "line_corrected");
    expect(ev?.detail).toMatchObject({ category: "cable", remembered: false, notRemembered: "no_supplier" });
  });

  it("the pipeline never writes a rule: reading a document leaves the rule store untouched", async () => {
    await uploadedId(F.TAX_INVOICE_IV0041);
    await uploadedId(F.INVOICE_NO_REFERENCE);
    expect(store.learned).toEqual([]);
  });

  it("below the admin tier both routes do not exist; with the flag off neither does", async () => {
    expect((await call({ query: { action: "learned-categories" }, role: "leadingHand", userId: "u_lh" })).statusCode).toBe(404);
    expect((await call({ method: "POST", query: { action: "forget-category" }, body: { ruleId: "11111111-1111-4111-8111-111111111111" }, role: "leadingHand", userId: "u_lh" })).statusCode).toBe(404);
    delete process.env.FLAG_INVOICE_CAPTURE;
    expect((await call({ query: { action: "learned-categories" } })).statusCode).toBe(404);
  });
});
