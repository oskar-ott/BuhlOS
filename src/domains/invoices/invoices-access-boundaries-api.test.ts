import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Cross-tenant test pack (remediation Task G, 2026-09-27) — part 2: the
 * routes. Every way a person could reach a supplier document or its money
 * through api/invoices.js and api/job-materials.js, tried from every tier:
 *   - field, leading-hand and client roles never learn the invoice routes
 *     exist (404 — the flag targets the admin tier), on list, detail, the
 *     document proxy, lines, the job breakdown, uploads and every write;
 *   - a field role may only ever POST a receipt, and only to a job it can
 *     open; it cannot then read the invoice it created (its one read is the
 *     price-free job purchase list — invoices-job-purchases-api.test.ts);
 *   - guessing ids buys nothing: an unknown invoice id, document id or a
 *     document id from ANOTHER invoice is a 404 for an admin too;
 *   - archived / excluded documents keep the same rules;
 *   - the manual materials ledger stays admin-only whatever the body says.
 * Real handlers, signed sessions, in-memory Blob + PG store.
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
const ledgerLibPath = resolve("../../../api/_lib/job-materials.js");
const handlerPath = resolve("../../../api/invoices.js");
const ledgerHandlerPath = resolve("../../../api/job-materials.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let store: MemoryStore;
let docs: Map<string, Buffer>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let ledger: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

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
const USERS = {
  admin: { id: "u_admin", role: "admin" },
  lh: { id: "u_lh", role: "leadingHand" },
  field: { id: "u_field", role: "electrician" },
  client: { id: "u_client", role: "client" },
} as const;
type Who = keyof typeof USERS;
function cookieFor(who: Who) {
  return `buhl_session=${auth.signSession({ userId: USERS[who].id, role: USERS[who].role, exp: Date.now() + 60_000 })}`;
}
async function call(who: Who, opts: { method?: string; query?: Record<string, string>; body?: unknown } = {}, h = handler): Promise<Res> {
  const res = createRes();
  await h({ method: opts.method || "GET", query: opts.query || {}, body: opts.body, headers: { cookie: cookieFor(who) } }, res);
  return res;
}
function dataUrl(text: string) {
  return `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n" + text).toString("base64")}`;
}
async function adminUpload(text: string): Promise<{ id: string; documentId: string }> {
  const r = await call("admin", { method: "POST", query: { action: "upload" }, body: { filename: "inv.pdf", dataUrl: dataUrl(text) } });
  expect(r.statusCode).toBe(201);
  const inv = (r.body as { invoice: { id: string } }).invoice;
  const doc = (store.documents as Array<{ id: string; invoiceId: string }>).find((d) => d.invoiceId === inv.id);
  return { id: inv.id, documentId: doc?.id ?? "" };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_INVOICE_CAPTURE = "true";
  process.env.FLAG_JOB_MATERIALS_SPEND = "true";
  delete process.env.INVOICE_AI_EXTRACTION;
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: F.JOBS }],
    ["users.json", { users: [
      { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      { id: "u_lh", username: "lead", name: "Lead Hand", role: "leadingHand", assignedJobIds: ["birdwood"] },
      { id: "u_field", username: "sparky", name: "Sparky", role: "electrician", assignedJobIds: ["birdwood"] },
      { id: "u_client", username: "client", name: "The Client", role: "client", assignedJobIds: ["birdwood"] },
    ] }],
  ]);
  store = createMemoryStore();
  docs = new Map();
  for (const p of [authPath, flagsPath, auditPath, pipelinePath, ledgerLibPath, handlerPath, ledgerHandlerPath]) delete requireFromHere.cache[p];
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
  ledger = requireFromHere(ledgerHandlerPath);
});
afterEach(() => {
  delete process.env.FLAG_INVOICE_CAPTURE;
  delete process.env.FLAG_JOB_MATERIALS_SPEND;
});

describe("below the admin tier the invoice routes do not exist", () => {
  const probes = (id: string, documentId: string): Array<{ label: string; req: { method?: string; query?: Record<string, string>; body?: unknown } }> => [
    { label: "list", req: {} },
    { label: "setup", req: { query: { action: "setup" } } },
    { label: "detail", req: { query: { id } } },
    { label: "document proxy", req: { query: { action: "document", id, documentId } } },
    { label: "lines", req: { query: { action: "lines", id } } },
    { label: "job breakdown", req: { query: { action: "job-materials", jobId: "birdwood" } } },
    { label: "job summary", req: { query: { action: "job-summary", jobId: "birdwood" } } },
    { label: "upload", req: { method: "POST", query: { action: "upload" }, body: { filename: "x.pdf", dataUrl: dataUrl(F.TAX_INVOICE_IV0041) } } },
    { label: "confirm", req: { method: "POST", query: { action: "confirm", id }, body: {} } },
    { label: "exclude", req: { method: "POST", query: { action: "exclude", id }, body: { reason: "x" } } },
    { label: "select-job", req: { method: "POST", query: { action: "select-job", id }, body: { jobId: "birdwood" } } },
    { label: "correct", req: { method: "PUT", query: { id }, body: { supplierName: "x" } } },
  ];

  for (const who of ["field", "lh", "client"] as Who[]) {
    it(`${who}: every list, read, document and write route is a 404, and the store is untouched`, async () => {
      const { id, documentId } = await adminUpload(F.TAX_INVOICE_IV0041);
      const before = JSON.stringify([store.invoices, store.allocations, store.events]);
      for (const p of probes(id, documentId)) {
        const r = await call(who, p.req);
        expect(r.statusCode, `${who} → ${p.label}`).toBe(404);
        expect(r.ended, `${who} → ${p.label} leaked bytes`).toBeNull();
      }
      expect(JSON.stringify([store.invoices, store.allocations, store.events])).toBe(before);
    });
  }

  it("a client role cannot even send a receipt (field-only write), and a field worker cannot read back what they sent", async () => {
    const photo = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString("base64")}`;
    const asClient = await call("client", { method: "POST", query: { action: "receipt" }, body: { jobId: "birdwood", filename: "r.jpg", dataUrl: photo } });
    expect([403, 404]).toContain(asClient.statusCode);
    const asField = await call("field", { method: "POST", query: { action: "receipt" }, body: { jobId: "birdwood", filename: "r.jpg", dataUrl: photo } });
    // The receipt path is the ONE field write; whatever it answers (201, or a
    // 4xx for the tiny fake photo), no field read follows from it.
    expect(asField.statusCode).not.toBe(500);
    const created = store.invoices.find((r) => r.createdBy === "u_field" || r.createdByLegacyId === "u_field");
    if (created) {
      expect((await call("field", { query: { id: String(created.id) } })).statusCode).toBe(404);
      expect((await call("field", { query: { action: "document", id: String(created.id) } })).statusCode).toBe(404);
    }
  });
});

describe("guessing ids buys nothing, even for an admin", () => {
  it("unknown invoice id → 404 on detail, document, lines and every write", async () => {
    const ghost = "99999999-9999-4999-8999-999999999999";
    expect((await call("admin", { query: { id: ghost } })).statusCode).toBe(404);
    expect((await call("admin", { query: { action: "document", id: ghost } })).statusCode).toBe(404);
    for (const action of ["confirm", "exclude", "select-job", "archive", "restore", "hold", "retry"]) {
      const r = await call("admin", { method: "POST", query: { action, id: ghost }, body: { reason: "x", jobId: "birdwood" } });
      expect(r.statusCode, action).toBe(404);
    }
  });

  it("a document id from ANOTHER invoice, or a made-up one, is not served under this invoice", async () => {
    const a = await adminUpload(F.TAX_INVOICE_IV0041);
    const b = await adminUpload(F.INVOICE_NO_REFERENCE);
    expect(a.documentId).not.toBe("");
    const own = await call("admin", { query: { action: "document", id: a.id, documentId: a.documentId } });
    expect(own.statusCode).toBe(200);
    const crossed = await call("admin", { query: { action: "document", id: a.id, documentId: b.documentId } });
    expect(crossed.statusCode).toBe(404);
    expect(crossed.ended).toBeNull();
    const madeUp = await call("admin", { query: { action: "document", id: a.id, documentId: "99999999-9999-4999-8999-999999999999" } });
    expect(madeUp.statusCode).toBe(404);
  });

  it("archived and excluded documents keep the same rules: admin reads, everyone else 404", async () => {
    const { id, documentId } = await adminUpload(F.TAX_INVOICE_IV0041);
    expect((await call("admin", { method: "POST", query: { action: "exclude", id }, body: { reason: "not ours" } })).statusCode).toBe(200);
    expect((await call("admin", { query: { action: "document", id, documentId } })).statusCode).toBe(200);
    for (const who of ["field", "lh", "client"] as Who[]) {
      expect((await call(who, { query: { id } })).statusCode, who).toBe(404);
      expect((await call(who, { query: { action: "document", id, documentId } })).statusCode, who).toBe(404);
    }
    expect((await call("admin", { method: "POST", query: { action: "archive", id }, body: {} })).statusCode).toBe(200);
    expect((await call("admin", { query: { action: "document", id, documentId } })).statusCode).toBe(200);
    expect((await call("field", { query: { action: "document", id, documentId } })).statusCode).toBe(404);
  });
});

describe("the manual materials ledger is admin-only whatever the body says", () => {
  it("field, leading hand and client get 404 on read and write; an override flag changes nothing", async () => {
    for (const who of ["field", "lh", "client"] as Who[]) {
      expect((await call(who, { query: { jobId: "birdwood" } }, ledger)).statusCode, `${who} GET`).toBe(404);
      const w = await call(who, { method: "POST", query: { jobId: "birdwood" }, body: { date: "2026-09-19", supplier: "L&H", amountCents: 100, override: { reason: "trust me" } } }, ledger);
      expect(w.statusCode, `${who} POST`).toBe(404);
    }
    expect(blob.has("jobs/birdwood/materials-ledger.json")).toBe(false);
  });
});
