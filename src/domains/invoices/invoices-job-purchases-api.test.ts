import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Recent purchases on a job (owner pull 2026-10-04: "view recent purchases
 * from wholesalers on the job easily and simply — only PMs and admins can view
 * the total cost"). GET /api/invoices?action=job-purchases through the real
 * handler, signed sessions, in-memory Blob + PG store:
 *   - the crew and leading hands see WHAT was bought — and not one price;
 *   - the office tier sees the amounts and the job total;
 *   - only confirmed purchases, newest first; a return reads as a return;
 *   - invisible (404) unless job_purchases AND invoice_capture are on;
 *   - a worker can only read a job they can open on site.
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
  process.env.FLAG_JOB_PURCHASES = "true";
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
  delete process.env.FLAG_JOB_PURCHASES;
});

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

type Purchases = {
  purchases: Array<{ id: string; date: string | null; supplier: string | null; supplierInvoiceNumber: string | null; kind: string; lines: Array<{ description: string; quantity: number | null; unit: string | null; measure: { amount: number | null; unit: string | null } }>; amountCents?: number }>;
  totalCount: number;
  awaitingCount: number;
  costVisible: boolean;
  totalCents?: number;
};
const purchases = (who: Who, jobId = "birdwood") => call(who, { query: { action: "job-purchases", jobId } });

/** Every key anywhere in the payload that could carry money. */
function moneyKeys(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => moneyKeys(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [
      ...(/cents|price|cost(?!Visible)|subtotal|gst|amountEx/i.test(k) ? [`${path}.${k}`] : []),
      ...moneyKeys(x, `${path}.${k}`),
    ]);
  }
  return [];
}

async function confirmedWholesaler() {
  const up = await adminUpload(WHOLESALER);
  expect((await call("admin", { method: "POST", query: { action: "confirm", id: up.id }, body: {} })).statusCode).toBe(200);
  return up.id;
}

describe("recent purchases on a job (job_purchases)", () => {
  it("crew and leading hands see what was bought — and not a single price", async () => {
    await confirmedWholesaler();
    for (const who of ["field", "lh"] as const) {
      const r = await purchases(who);
      expect(r.statusCode, who).toBe(200);
      const b = r.body as Purchases;
      expect(b.costVisible, who).toBe(false);
      expect(b.totalCount, who).toBe(1);
      expect(b.purchases[0], who).toMatchObject({ supplier: "Wholesale Wires Pty Ltd", supplierInvoiceNumber: "WW-9", kind: "invoice", date: "2026-09-10" });
      expect(b.purchases[0]!.lines.map((l) => [l.description, l.quantity, l.unit]), who).toEqual([
        ["CBL2.5T 2.5MM TWIN & EARTH TPS 100M ROLL", 3, "roll"],
        ["LED9W 9W LED DOWNLIGHT WARM WHITE", 12, "ea"],
        ["FRT FREIGHT", 1, "ea"],
      ]);
      expect(b.purchases[0]!.lines[0]!.measure, who).toEqual({ amount: 300, unit: "m" });
      // The contract: no money anywhere in the response, not even nested.
      expect(moneyKeys(b), who).toEqual([]);
      expect(JSON.stringify(b), who).not.toMatch(/415|268|8950|26850|41550|45705/);
      expect(r.headers["cache-control"], who).toBe("private, no-store");
    }
  });

  it("the office tier sees each purchase's amount and the job total (ex GST)", async () => {
    await confirmedWholesaler();
    for (const role of ["admin"] as const) {
      const b = (await purchases(role)).body as Purchases;
      expect(b.costVisible).toBe(true);
      expect(b.totalCents).toBe(41550);
      expect(b.purchases[0]!.amountCents).toBe(41550);
    }
  });

  it("only confirmed purchases count; what's still with the office is a count, newest first, a return reads as a return", async () => {
    // matched but not confirmed yet → not a purchase, but counted as waiting
    await adminUpload(WHOLESALER);
    let b = (await purchases("field")).body as Purchases;
    expect(b).toMatchObject({ purchases: [], totalCount: 0, awaitingCount: 1 });
    const id = store.invoices[0]!.id as string;
    await call("admin", { method: "POST", query: { action: "confirm", id }, body: {} });
    const cn = await adminUpload(F.CREDIT_NOTE_IV0041);
    await call("admin", { method: "POST", query: { action: "confirm", id: cn.id }, body: {} });
    b = (await purchases("admin")).body as Purchases;
    expect(b.totalCount).toBe(2);
    expect(b.awaitingCount).toBe(0);
    const kinds = b.purchases.map((p) => p.kind).sort();
    expect(kinds).toEqual(["invoice", "return"]);
    expect(b.purchases.find((p) => p.kind === "return")!.amountCents).toBe(-12000);
    expect(b.totalCents).toBe(41550 - 12000);
    const dates = b.purchases.map((p) => p.date ?? "");
    expect([...dates].sort().reverse()).toEqual(dates); // newest first
  });

  it("a reversed (excluded) purchase leaves the list with its cost", async () => {
    const id = await confirmedWholesaler();
    await call("admin", { method: "POST", query: { action: "exclude", id }, body: { reason: "wrong job" } });
    expect((await purchases("field")).body).toMatchObject({ purchases: [], totalCount: 0 });
  });

  it("is invisible unless job_purchases AND invoice_capture are on", async () => {
    delete process.env.FLAG_JOB_PURCHASES;
    expect((await purchases("field")).statusCode).toBe(404);
    expect((await purchases("admin")).statusCode).toBe(404);
    process.env.FLAG_JOB_PURCHASES = "true";
    delete process.env.FLAG_INVOICE_CAPTURE;
    expect((await purchases("field")).statusCode).toBe(404);
    expect((await purchases("admin")).statusCode).toBe(404);
  });

  it("a client account never reads it; a worker only reads a job they can open; unknown jobs look the same", async () => {
    expect((await purchases("client")).statusCode).toBe(403);
    // archived / deleted / unknown → the same 404 for the crew
    for (const jobId of ["old-job", "deleted", "nope"]) {
      expect((await purchases("field", jobId)).statusCode, jobId).toBe(404);
    }
    expect((await call("field", { query: { action: "job-purchases" } })).statusCode).toBe(400);
    // the office reads any live job, archived included
    expect((await purchases("admin", "old-job")).statusCode).toBe(200);
  });

  it("does not open any other invoice route to the crew", async () => {
    const id = await confirmedWholesaler();
    expect((await call("field", { query: { id } })).statusCode).toBe(404);
    expect((await call("field", { query: { action: "job-materials", jobId: "birdwood" } })).statusCode).toBe(404);
    expect((await call("field", { query: { action: "document", id } })).statusCode).toBe(404);
  });
});
