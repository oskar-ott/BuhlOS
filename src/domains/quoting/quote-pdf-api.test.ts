import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

import { projectQuoteToClientView as projectTs } from "./client-projection";
import { QUOTE_MARGIN_INTERNAL_ONLY_KEYS } from "./margin";
import type { Quote } from "./schema";

// Lean reset: quotes are dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_QUOTES = "1";
});
afterAll(() => {
  delete process.env.FLAG_QUOTES;
});

/**
 * Harness coverage for api/quote-pdf.js (#243) — branded client quote PDFs —
 * plus the CJS↔TS parity pins for api/_lib/quote-pdf.js.
 *
 * What this suite pins:
 *   - PARITY: the CJS projectQuoteToClientView mirror produces exactly the
 *     TS projection's output (src/domains/quoting/client-projection.ts), and
 *     the CJS totals mirror matches the golden fixture from totals.test.ts.
 *   - LEAK-PROOFING (the issue's mandatory requirement): internal-only keys
 *     never reach the projection, and the EXTRACTED TEXT of a generated PDF
 *     contains the sell-side numbers but none of the internal cost/margin
 *     values riding on the source document.
 *   - tier-aware auth (estimator passes, field roles 403, no session 401).
 *   - POST issues: %PDF bytes put() to a NEW path per generation, register
 *     entry appended AFTER the blob write, with issueNumber/issuedAt/
 *     issuedBy/quoteUpdatedAt/generatorVersion (issue ACs).
 *   - failure honesty: a failed put() or register write → 500 and NO register
 *     entry ("nothing was issued").
 *   - GET ?download=1 streams application/pdf marked "Preview — not yet
 *     issued" and files nothing.
 *   - long quotes paginate (multi-page document, totals still present).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const pdfLibModulePath = requireFromHere.resolve("../../../api/_lib/quote-pdf.js");
const handlerPath = requireFromHere.resolve("../../../api/quote-pdf.js");

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;
let putCalls: Array<{ path: string; buf: Buffer; opts: Record<string, unknown> }>;
/** When set, the NEXT put() throws once. */
let failNextPut: Error | null;
/** When set, the NEXT writeBlob to this key throws once. */
let failNextWrite: { key: string; error: Error } | null;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call({
  method,
  query = {},
  body = {},
  as = ["u_est", "estimator"],
}: {
  method: string;
  query?: Record<string, string>;
  body?: unknown;
  as?: [string, string] | null;
}) {
  const res = createRes();
  await handler(
    { method, body, query, headers: as ? { cookie: cookieFor(as[0], as[1]) } : {} },
    res
  );
  return res;
}

const SEED_ID = "qv2_seed";

/** Seed document with INTERNAL fields riding along (unitCost/category/preset
 *  stamps + passthrough'd margin analysis) — none of it may reach the PDF. */
function seedDoc() {
  return {
    id: SEED_ID,
    name: "Birdwood St rewire",
    clientName: "B. Hender",
    status: "draft",
    createdAt: "2026-06-12T00:00:00.000Z",
    createdBy: "estimator",
    updatedAt: "2026-06-12T01:00:00.000Z",
    sections: [
      {
        id: "qsec_a",
        title: "Switchboard",
        sortOrder: 0,
        lines: [
          {
            id: "qline_a",
            kind: "material",
            description: "DB upgrade",
            qty: 1,
            unit: "ea",
            rate: 1000,
            unitCost: 77.77,
            category: "SECRETCAT",
            ratePresetId: "qrp_x",
            ratePresetName: "SECRETPRESET",
            markupPct: 42,
            margin: { amount: 922.23, pct: 92 },
          },
        ],
      },
    ],
    totals: { subtotalExGst: 1000, gst: 100, totalIncGst: 1100, lineCount: 1 },
    __rev: 3,
  };
}

function registerOf(id: string): { documents: Array<Record<string, unknown>> } | undefined {
  return blob.get(`quotes-v2/${id}/documents.json`) as
    | { documents: Array<Record<string, unknown>> }
    | undefined;
}

/**
 * Pull the human text back out of a generated PDF: pdf-lib writes drawn text
 * as WinAnsi hex strings inside (possibly Flate-compressed) content streams.
 * We inflate every stream we can, then decode all hex + literal string tokens.
 */
function extractPdfText(buf: Buffer): string {
  const chunks: string[] = [buf.toString("latin1")];
  const raw = buf.toString("latin1");
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    const slice = buf.subarray(start, end);
    try {
      chunks.push(inflateSync(slice).toString("latin1"));
    } catch {
      /* not a flate stream — the raw chunk already covers it */
    }
  }
  let out = "";
  for (const chunk of chunks) {
    for (const hex of chunk.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const bytes = hex[1]!.replace(/\s+/g, "");
      if (bytes.length % 2 !== 0) continue;
      out += Buffer.from(bytes, "hex").toString("latin1");
    }
    for (const lit of chunk.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
      out += lit[1];
    }
    out += "\n";
  }
  return out;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.EMAIL_COMPANY_NAME;
  delete process.env.COMPANY_ABN;
  delete process.env.COMPANY_ADDRESS;
  delete process.env.COMPANY_PHONE;
  delete process.env.COMPANY_EMAIL;
  putCalls = [];
  failNextPut = null;
  failNextWrite = null;
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_est", username: "quinn", role: "estimator", assignedJobIds: [] },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "tradie", assignedJobIds: [] },
          { id: "u_lh", username: "lead", role: "leadinghand", assignedJobIds: [] },
        ],
      },
    ],
    [`quotes-v2/${SEED_ID}.json`, seedDoc()],
  ]);

  for (const modulePath of [blobPath, authPath, vercelBlobPath, pdfLibModulePath, handlerPath]) {
    delete requireFromHere.cache[modulePath];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        if (failNextWrite && failNextWrite.key === key) {
          const err = failNextWrite.error;
          failNextWrite = null;
          throw err;
        }
        blob.set(key, clone(data));
      }),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: {
      put: vi.fn(async (path: string, buf: Buffer, opts: Record<string, unknown>) => {
        if (failNextPut) {
          const err = failNextPut;
          failNextPut = null;
          throw err;
        }
        putCalls.push({ path, buf, opts });
        return { url: `https://blob.example/${path}` };
      }),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

// ── CJS ↔ TS parity (the mirror law) ─────────────────────────────────────

describe("api/_lib/quote-pdf.js — projection + totals mirrors", () => {
  it("projectQuoteToClientView matches the TS projection exactly (dirty fixture)", () => {
    const lib = requireFromHere(pdfLibModulePath);
    const doc = seedDoc();
    const { __rev, ...wire } = doc;
    const fromCjs = lib.projectQuoteToClientView(wire);
    const fromTs = projectTs(wire as unknown as Quote);
    expect(fromCjs).toEqual(fromTs);
  });

  it("SECURITY: no internal-only key appears anywhere in the CJS projection", () => {
    const lib = requireFromHere(pdfLibModulePath);
    const view = lib.projectQuoteToClientView(seedDoc());
    const keys = new Set<string>();
    (function walk(v: unknown) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          keys.add(k);
          walk(val);
        }
      }
    })(view);
    for (const k of [...QUOTE_MARGIN_INTERNAL_ONLY_KEYS, "unitCost", "category", "ratePresetId", "ratePresetName"]) {
      expect(keys.has(k), `internal key "${k}" leaked into the projection`).toBe(false);
    }
  });

  it("totals mirror matches the golden fixture from totals.test.ts", () => {
    const lib = requireFromHere(pdfLibModulePath);
    // DUPLICATED BY VALUE from totals.test.ts / quotes-v2-api.test.ts on
    // purpose — change them together.
    const sections = [
      { lines: [{ qty: 3, rate: 99.95 }, { qty: 0.5, rate: 150 }] },
      { lines: [{ qty: 10, rate: 0.333 }] },
    ];
    expect(lib.computeQuoteTotals(sections)).toEqual({
      subtotalExGst: 378.18,
      gst: 37.82,
      totalIncGst: 416.0,
      lineCount: 3,
    });
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────

describe("auth — tier-aware admin gate", () => {
  it("accepts an estimator (admin tier) on list, download and issue", async () => {
    expect((await call({ method: "GET", query: { id: SEED_ID } })).statusCode).toBe(200);
    expect(
      (await call({ method: "GET", query: { id: SEED_ID, download: "1" } })).statusCode
    ).toBe(200);
    expect((await call({ method: "POST", query: { id: SEED_ID } })).statusCode).toBe(201);
  });

  it("403s field and leading-hand roles", async () => {
    for (const as of [
      ["u_field", "tradie"],
      ["u_lh", "leadinghand"],
    ] as Array<[string, string]>) {
      expect((await call({ method: "GET", query: { id: SEED_ID }, as })).statusCode).toBe(403);
      expect((await call({ method: "POST", query: { id: SEED_ID }, as })).statusCode).toBe(403);
    }
  });

  it("401s without a session", async () => {
    expect((await call({ method: "GET", query: { id: SEED_ID }, as: null })).statusCode).toBe(401);
  });
});

// ── Validation / routing ─────────────────────────────────────────────────

describe("routing + validation", () => {
  it("400s a missing or path-shaped id", async () => {
    expect((await call({ method: "GET" })).statusCode).toBe(400);
    expect((await call({ method: "POST", query: { id: "../users" } })).statusCode).toBe(400);
  });

  it("404s an unknown quote on download and issue", async () => {
    expect(
      (await call({ method: "GET", query: { id: "qv2_nope", download: "1" } })).statusCode
    ).toBe(404);
    expect((await call({ method: "POST", query: { id: "qv2_nope" } })).statusCode).toBe(404);
  });

  it("405s other methods", async () => {
    expect((await call({ method: "PATCH", query: { id: SEED_ID } })).statusCode).toBe(405);
  });

  it("GET list on a quote with no issued PDFs returns an empty register", async () => {
    const res = await call({ method: "GET", query: { id: SEED_ID } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ documents: [] });
  });
});

// ── Issue (POST) ─────────────────────────────────────────────────────────

describe("POST — generate + file", () => {
  it("puts %PDF bytes to a new path and appends the register entry after it", async () => {
    const res = await call({ method: "POST", query: { id: SEED_ID } });
    expect(res.statusCode).toBe(201);

    expect(putCalls).toHaveLength(1);
    const { path, buf, opts } = putCalls[0]!;
    expect(path).toMatch(new RegExp(`^quotes-v2/${SEED_ID}/documents/qdoc_[a-z0-9]+\\.pdf$`));
    expect(opts.contentType).toBe("application/pdf");
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const doc = (res.body as { document: Record<string, unknown> }).document;
    expect(doc).toMatchObject({
      quoteId: SEED_ID,
      documentType: "Issued quote",
      mimeType: "application/pdf",
      issueNumber: 1,
      issuedBy: "quinn",
      quoteUpdatedAt: "2026-06-12T01:00:00.000Z",
      quoteName: "Birdwood St rewire",
      totalIncGst: 1100,
      generatorVersion: "quote-pdf/1",
      blobPath: path,
      url: `https://blob.example/${path}`,
      sizeBytes: buf.length,
    });
    expect(typeof doc.issuedAt).toBe("string");

    const register = registerOf(SEED_ID);
    expect(register?.documents).toHaveLength(1);
    expect(register?.documents[0]).toEqual(doc);
  });

  it("renders the client document: sell numbers + branding IN, internals OUT", async () => {
    const res = await call({ method: "POST", query: { id: SEED_ID } });
    expect(res.statusCode).toBe(201);
    const text = extractPdfText(putCalls[0]!.buf);

    // Sell-side content the client must see (totals.ts numbers, letterhead,
    // meta) — the ü in the default company name is the WinAnsi encoding pin.
    for (const expected of [
      "bühl electrical",
      "QUOTE",
      "Birdwood St rewire",
      "Prepared for: B. Hender",
      SEED_ID,
      "Switchboard",
      "DB upgrade",
      "$1,000.00",
      "$1,100.00",
      "GST",
      "30 days",
      "Issued",
      "Issue 1",
      "Page 1 of 1",
    ]) {
      expect(text, `expected "${expected}" in the PDF text`).toContain(expected);
    }

    // Internal values riding on the source document must NOT be in the bytes.
    for (const forbidden of ["77.77", "SECRETCAT", "SECRETPRESET", "markup", "margin", "cost"]) {
      expect(text.toLowerCase(), `internal "${forbidden}" leaked into the PDF`).not.toContain(
        forbidden.toLowerCase()
      );
    }
  });

  it("re-issuing creates a NEW artifact and leaves the first entry untouched", async () => {
    const first = await call({ method: "POST", query: { id: SEED_ID } });
    const firstDoc = clone((first.body as { document: Record<string, unknown> }).document);

    const second = await call({ method: "POST", query: { id: SEED_ID } });
    expect(second.statusCode).toBe(201);
    const secondDoc = (second.body as { document: Record<string, unknown> }).document;

    expect(secondDoc.issueNumber).toBe(2);
    expect(secondDoc.id).not.toBe(firstDoc.id);
    expect(secondDoc.blobPath).not.toBe(firstDoc.blobPath);
    expect(putCalls.map((c) => c.path)).toHaveLength(2);

    const register = registerOf(SEED_ID);
    expect(register?.documents).toHaveLength(2);
    expect(register?.documents[0]).toEqual(firstDoc); // never mutated

    // list returns newest first
    const list = await call({ method: "GET", query: { id: SEED_ID } });
    const rows = (list.body as { documents: Array<{ issueNumber: number }> }).documents;
    expect(rows.map((r) => r.issueNumber)).toEqual([2, 1]);
  });

  it("failed blob put → 500 and NO register entry (nothing was issued)", async () => {
    failNextPut = new Error("blob unavailable");
    const res = await call({ method: "POST", query: { id: SEED_ID } });
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toContain("nothing was issued");
    expect(registerOf(SEED_ID)).toBeUndefined();
  });

  it("failed register write → 500 and NO register entry", async () => {
    failNextWrite = {
      key: `quotes-v2/${SEED_ID}/documents.json`,
      error: new Error("register write failed"),
    };
    const res = await call({ method: "POST", query: { id: SEED_ID } });
    expect(res.statusCode).toBe(500);
    expect(registerOf(SEED_ID)).toBeUndefined();
  });
});

// ── Preview download (GET ?download=1) ───────────────────────────────────

describe("GET ?download=1 — fresh render, not filed", () => {
  it("streams application/pdf marked as a preview and writes nothing", async () => {
    const res = await call({ method: "GET", query: { id: SEED_ID, download: "1" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/pdf");
    expect(res.headers["Content-Disposition"]).toContain(".pdf");

    const buf = res.body as Buffer;
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = extractPdfText(buf);
    expect(text).toContain("Preview");
    expect(text).toContain("not yet issued");

    expect(putCalls).toHaveLength(0);
    expect(registerOf(SEED_ID)).toBeUndefined();
  });
});

// ── Pagination (long content) ────────────────────────────────────────────

describe("long quotes paginate sanely", () => {
  it("many sections/lines → a multi-page document whose totals survive", async () => {
    const long = seedDoc() as Record<string, unknown>;
    long.sections = Array.from({ length: 4 }, (_, s) => ({
      id: `qsec_${s}`,
      title: `Level ${s + 1} — general power and lighting circuits`,
      sortOrder: s,
      lines: Array.from({ length: 30 }, (_, i) => ({
        id: `ql_${s}_${i}`,
        kind: "material",
        description:
          `Line ${i + 1}: supply and install double GPO on a dedicated circuit ` +
          `including cabling, terminations and testing to AS/NZS 3000 requirements`,
        qty: 2,
        unit: "ea",
        rate: 100,
      })),
    }));
    blob.set(`quotes-v2/${SEED_ID}.json`, long);

    const res = await call({ method: "POST", query: { id: SEED_ID } });
    expect(res.statusCode).toBe(201);

    const buf = putCalls[0]!.buf;
    const parsed = await PDFDocument.load(new Uint8Array(buf));
    expect(parsed.getPageCount()).toBeGreaterThan(1);

    // 4 × 30 × $200 = $24,000 ex GST → $26,400 inc GST — the totals block
    // survived pagination (no clipped totals, issue AC).
    const text = extractPdfText(buf);
    expect(text).toContain("$24,000.00");
    expect(text).toContain("$26,400.00");
    expect(text).toContain(`Page ${parsed.getPageCount()} of ${parsed.getPageCount()}`);
  });
});
