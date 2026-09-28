import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Task F (2026-09-27): GET /api/invoices?action=auto-booking-report — the
 * shadow comparison served read-only to the admin tier, built from the
 * invoices' own history through the in-memory store. Also proves the two
 * history changes the report relies on going forward: the verdict event now
 * snapshots job + figures, and a correction records old → new.
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
type Report = {
  days: number; autoBookingEnabled: boolean; sampleSize: number; unresolved: number; neverEvaluated: number;
  wouldHaveBooked: { count: number; agreed: number }; wouldHaveWaited: { count: number; falseNegatives: number; correct: number };
  gate: { pass: boolean; checks: Array<{ code: string; ok: boolean }> }; bySupplier: Array<{ supplierName: string | null; sample: number }>;
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
async function report(days = "90"): Promise<Report> {
  const r = await call({ query: { action: "auto-booking-report", days } });
  expect(r.statusCode).toBe(200);
  return r.body as Report;
}

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

describe("GET ?action=auto-booking-report", () => {
  it("is empty and honest when nothing was captured; the gate does not pass on nothing", async () => {
    const r = await report();
    expect(r).toMatchObject({ days: 90, autoBookingEnabled: false, sampleSize: 0, unresolved: 0 });
    expect(r.gate.pass).toBe(false);
  });

  it("a matched invoice gets a verdict with a snapshot; unconfirmed it is unresolved, confirmed as-is it becomes a resolved decision", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    const verdict = (store.events as Array<{ invoiceId: string; event: string; detail: Record<string, unknown> }>).find((e) => e.invoiceId === id && /^auto_confirm_/.test(e.event));
    expect(verdict).toBeDefined();
    expect(verdict?.detail).toMatchObject({ jobId: "birdwood", supplierKey: expect.any(String), amountCents: expect.any(Number) });
    let r = await report();
    expect(r.sampleSize).toBe(1);
    expect(r.unresolved).toBe(1);
    expect((await call({ method: "POST", query: { action: "confirm", id } })).statusCode).toBe(200);
    r = await report();
    expect(r.sampleSize).toBe(1);
    expect(r.unresolved).toBe(0);
    // Review-only defaults: an untrusted supplier is "would have waited"; a person booked it untouched → false negative.
    expect(r.wouldHaveWaited).toMatchObject({ count: 1, falseNegatives: 1 });
    expect(r.bySupplier[0]).toMatchObject({ sample: 1 });
  });

  it("a correction is recorded old → new, and the person's changed booking counts as 'waited correctly'", async () => {
    const id = await uploadedId(F.TAX_INVOICE_IV0041);
    const before = (store.invoices.find((r) => r.id === id) as { subtotalCents: number }).subtotalCents;
    const c = await call({ method: "PUT", query: { id }, body: { subtotalCents: before + 100, gstCents: Math.round((before + 100) / 10), totalCents: before + 100 + Math.round((before + 100) / 10) } });
    expect(c.statusCode).toBe(200);
    const corrected = (store.events as Array<{ invoiceId: string; event: string; detail: { changes?: Record<string, { from: unknown; to: unknown }> } }>).find((e) => e.invoiceId === id && e.event === "corrected");
    expect(corrected?.detail.changes?.subtotalCents).toEqual({ from: before, to: before + 100 });
    expect((await call({ method: "POST", query: { action: "confirm", id } })).statusCode).toBe(200);
    const r = await report();
    expect(r.wouldHaveWaited).toMatchObject({ count: 1, correct: 1, falseNegatives: 0 });
  });

  it("clamps the period and stays admin-tier only", async () => {
    expect((await report("2")).days).toBe(7);
    expect((await report("9999")).days).toBe(365);
    expect((await call({ query: { action: "auto-booking-report" }, role: "leadingHand", userId: "u_lh" })).statusCode).toBe(404);
  });
});
