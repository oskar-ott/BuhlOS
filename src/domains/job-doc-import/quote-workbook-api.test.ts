import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the #365 quote-side workbook import on the REAL
 * api/job-doc-import.js handler (createRequire harness — the
 * job-doc-import-api.test.ts pattern): attach-to-quote (new + existing quote,
 * re-upload supersede), the review actions (confirm-classification,
 * resolve-finding, complete-review), the GET record read, the auth/flag gates,
 * and the create-job job↔quote link (job.fromQuoteId ↔ quote.linkedJobId).
 *
 * The workbook is the COMMITTED 100-Arthur fixture, so the attach path is
 * exercised against the real failure modes (findings, alternates, PC sums).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const quotesV2Path = requireFromHere.resolve("../../../api/quotes-v2.js");
const handlerPath = requireFromHere.resolve("../../../api/job-doc-import.js");

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FIXTURE = readFileSync(join(__dirname, "fixtures", "100-arthur-boq.xlsx"));
const FIXTURE_DATA_URL = `data:${XLSX_MIME};base64,${FIXTURE.toString("base64")}`;

let store: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {
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

async function call(opts: {
  method: string;
  role?: string;
  userId?: string;
  body?: unknown;
  query?: Record<string, string>;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_boss", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}

function attachBody(extra: Record<string, unknown> = {}) {
  return { fileName: "100-arthur.xlsx", mimeType: XLSX_MIME, dataUrl: FIXTURE_DATA_URL, ...extra };
}

interface QuoteDoc {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  linkedJobId?: string;
  sections: Array<{ id: string; title: string; lines: Array<{ id: string; qty: number; rate: number; description: string }> }>;
  totals: { subtotalExGst: number; lineCount: number };
}

interface ImportRecord {
  quoteId: string;
  current: {
    importId: string;
    fileName: string | null;
    parse: {
      counts: { lines: number; findings: number };
      findings: Array<{ id: string; kind: string }>;
      lines: Array<{ id: string; description: string; classification: string }>;
    };
  };
  confirmations: Array<{ lineId: string; classification: string; by: string }>;
  resolutions: Array<{ findingId: string; action: string }>;
  review: { status: string; openFindingsAtCompletion?: number; unconfirmedAtCompletion?: number };
  superseded: Array<{ importId: string; fileName: string | null; lineCount: number }>;
  status: { openFindings: number; unconfirmedClassifications: number };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_JOB_DOC_IMPORT = "1";
  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: [] },
        ],
      },
    ],
    ["jobs.json", { jobs: [] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[ffPath];
  delete requireFromHere.cache[quotesV2Path];
  delete requireFromHere.cache[handlerPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        store.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.FLAG_JOB_DOC_IMPORT;
});

async function attachToNewQuote(name = "100 Arthur St") {
  const res = await call({
    method: "POST",
    query: { action: "attach-to-quote" },
    body: attachBody({ quoteName: name }),
  });
  expect(res.statusCode).toBe(200);
  return res.body as {
    quoteId: string;
    quoteName: string;
    importId: string;
    counts: { lines: number; findings: number; unconfirmedClassifications: number; materialisedLines: number };
    supersededCount: number;
  };
}

describe("attach-to-quote — import against a quote", () => {
  it("creates a draft quote, stores the import record and materialises BASE lines only", async () => {
    const body = await attachToNewQuote();
    expect(body.quoteName).toBe("100 Arthur St");
    expect(body.counts.lines).toBe(9);
    expect(body.counts.findings).toBeGreaterThanOrEqual(6);
    // Every classification default starts unconfirmed — no fake clean state.
    expect(body.counts.unconfirmedClassifications).toBe(9);

    // The quote document exists, with ONLY the base lines materialised into
    // import-owned sections (alternate/PC/by-others never in the base total).
    const doc = store.get(`quotes-v2/${body.quoteId}.json`) as QuoteDoc;
    expect(doc.status).toBe("draft");
    expect(doc.sections.every((s) => s.id.startsWith("qsec_wb_"))).toBe(true);
    const materialised = doc.sections.flatMap((s) => s.lines);
    expect(materialised).toHaveLength(6);
    expect(materialised.some((l) => /PL3 pendants/.test(l.description))).toBe(false);
    // Quote lines are qty × rate (the CHECKABLE arithmetic): the ZIP row
    // computes 2 × 450 = 900, not the workbook's flagged 1,400 — the $500
    // discrepancy stays visible as the open qty_rate_mismatch finding.
    expect(doc.totals.subtotalExGst).toBe(35900);

    // Registry row upserted for the office money list.
    const registry = store.get("quotes-v2.json") as { quotes: Array<{ id: string }> };
    expect(registry.quotes.some((q) => q.id === body.quoteId)).toBe(true);

    // The import record keeps full provenance.
    const record = store.get(`quotes-v2/${body.quoteId}/workbook-import.json`) as ImportRecord;
    expect(record.current.fileName).toBe("100-arthur.xlsx");
    expect(record.review.status).toBe("pending");
    expect(record.superseded).toEqual([]);
  });

  it("attaches to an EXISTING quote and preserves builder-authored sections", async () => {
    const now = new Date().toISOString();
    store.set("quotes-v2/qv2_x.json", {
      id: "qv2_x",
      name: "Existing quote",
      clientName: null,
      status: "draft",
      createdAt: now,
      createdBy: "boss",
      updatedAt: now,
      sections: [
        {
          id: "qsec_hand",
          title: "Hand-built",
          sortOrder: 0,
          lines: [{ id: "qline_1", kind: "other", description: "Manual line", qty: 1, unit: "ea", rate: 100 }],
        },
      ],
      totals: { subtotalExGst: 100, gst: 10, totalIncGst: 110, lineCount: 1 },
    });
    const res = await call({
      method: "POST",
      query: { action: "attach-to-quote" },
      body: attachBody({ quoteId: "qv2_x" }),
    });
    expect(res.statusCode).toBe(200);
    const doc = store.get("quotes-v2/qv2_x.json") as QuoteDoc;
    expect(doc.sections.some((s) => s.id === "qsec_hand")).toBe(true);
    expect(doc.sections.some((s) => s.id.startsWith("qsec_wb_"))).toBe(true);
    expect(doc.totals.subtotalExGst).toBe(36000); // 100 manual + 35,900 base (qty×rate)
  });

  it("re-upload SUPERSEDES the prior import with a kept record — never a second copy", async () => {
    const first = await attachToNewQuote();
    const second = await call({
      method: "POST",
      query: { action: "attach-to-quote" },
      body: attachBody({ quoteId: first.quoteId, fileName: "100-arthur-rev2.xlsx" }),
    });
    expect(second.statusCode).toBe(200);
    const body = second.body as { importId: string; supersededCount: number };
    expect(body.supersededCount).toBe(1);
    expect(body.importId).not.toBe(first.importId);

    const record = store.get(`quotes-v2/${first.quoteId}/workbook-import.json`) as ImportRecord;
    expect(record.current.fileName).toBe("100-arthur-rev2.xlsx");
    expect(record.superseded).toHaveLength(1);
    expect(record.superseded[0]?.importId).toBe(first.importId);
    expect(record.superseded[0]?.lineCount).toBe(9);
    // New upload = new data: decisions restart, review back to pending.
    expect(record.confirmations).toEqual([]);
    expect(record.review.status).toBe("pending");

    // Still exactly ONE set of import-owned sections on the quote.
    const doc = store.get(`quotes-v2/${first.quoteId}.json`) as QuoteDoc;
    expect(doc.sections.filter((s) => s.id.startsWith("qsec_wb_"))).toHaveLength(
      doc.sections.length
    );
    expect(doc.totals.subtotalExGst).toBe(35900);
  });

  it("400 when neither quoteId nor quoteName; 404 for an unknown quoteId; 422 for a line-less workbook", async () => {
    const noTarget = await call({
      method: "POST",
      query: { action: "attach-to-quote" },
      body: attachBody(),
    });
    expect(noTarget.statusCode).toBe(400);

    const missing = await call({
      method: "POST",
      query: { action: "attach-to-quote" },
      body: attachBody({ quoteId: "qv2_nope" }),
    });
    expect(missing.statusCode).toBe(404);

    // A structurally valid zip with no BOQ table → honest 422, nothing written.
    const before = store.size;
    const empty = await call({
      method: "POST",
      query: { action: "attach-to-quote" },
      body: {
        quoteName: "Empty",
        mimeType: XLSX_MIME,
        dataUrl: `data:${XLSX_MIME};base64,${Buffer.from("not a zip").toString("base64")}`,
      },
    });
    expect(empty.statusCode).toBe(422);
    expect(store.size).toBe(before);
  });

  it("flag OFF → 404; non-admin → 403", async () => {
    process.env.FLAG_JOB_DOC_IMPORT = "0";
    const dark = await call({
      method: "POST",
      query: { action: "attach-to-quote" },
      body: attachBody({ quoteName: "X" }),
    });
    expect(dark.statusCode).toBe(404);

    process.env.FLAG_JOB_DOC_IMPORT = "1";
    const field = await call({
      method: "POST",
      role: "electrician",
      userId: "u_field",
      query: { action: "attach-to-quote" },
      body: attachBody({ quoteName: "X" }),
    });
    expect(field.statusCode).toBe(403);
  });
});

describe("GET ?quoteId= — the review read", () => {
  it("returns the record with honest status counters, null when no import", async () => {
    const { quoteId } = await attachToNewQuote();
    const res = await call({ method: "GET", query: { quoteId } });
    expect(res.statusCode).toBe(200);
    const record = (res.body as { workbookImport: ImportRecord }).workbookImport;
    expect(record.status.unconfirmedClassifications).toBe(9);
    expect(record.status.openFindings).toBe(record.current.parse.counts.findings);

    const none = await call({ method: "GET", query: { quoteId: "qv2_never" } });
    expect((none.body as { workbookImport: unknown }).workbookImport).toBeNull();
  });
});

describe("review actions", () => {
  it("confirm-classification re-materialises the quote (alternate confirmed IN moves money)", async () => {
    const { quoteId } = await attachToNewQuote();
    const record = store.get(`quotes-v2/${quoteId}/workbook-import.json`) as ImportRecord;
    const pl3 = record.current.parse.lines.find((l) => /PL3 pendants/.test(l.description))!;
    expect(pl3.classification).toBe("alternate");

    const res = await call({
      method: "POST",
      query: { action: "confirm-classification" },
      body: { quoteId, lineId: pl3.id, classification: "base" },
    });
    expect(res.statusCode).toBe(200);
    const updated = (res.body as { workbookImport: ImportRecord }).workbookImport;
    expect(updated.confirmations).toEqual([
      expect.objectContaining({ lineId: pl3.id, classification: "base", by: "boss" }),
    ]);
    expect(updated.status.unconfirmedClassifications).toBe(8);

    // The confirmed-in alternate now lands on the quote document.
    const doc = store.get(`quotes-v2/${quoteId}.json`) as QuoteDoc;
    expect(doc.totals.subtotalExGst).toBe(38820); // 35,900 + 2,920
    expect(doc.sections.flatMap((s) => s.lines).some((l) => /PL3/.test(l.description))).toBe(true);
  });

  it("confirming the detection default keeps the money out of base but counts as confirmed", async () => {
    const { quoteId } = await attachToNewQuote();
    const record = store.get(`quotes-v2/${quoteId}/workbook-import.json`) as ImportRecord;
    const pl3 = record.current.parse.lines.find((l) => /PL3 pendants/.test(l.description))!;
    const res = await call({
      method: "POST",
      query: { action: "confirm-classification" },
      body: { quoteId, lineId: pl3.id, classification: "alternate" },
    });
    expect(res.statusCode).toBe(200);
    const doc = store.get(`quotes-v2/${quoteId}.json`) as QuoteDoc;
    expect(doc.totals.subtotalExGst).toBe(35900); // unchanged — alternates never in base
  });

  it("rejects an unknown classification (400) and an unknown line (404)", async () => {
    const { quoteId } = await attachToNewQuote();
    const bad = await call({
      method: "POST",
      query: { action: "confirm-classification" },
      body: { quoteId, lineId: "wl_1_6", classification: "maybe" },
    });
    expect(bad.statusCode).toBe(400);
    const gone = await call({
      method: "POST",
      query: { action: "confirm-classification" },
      body: { quoteId, lineId: "wl_9_99", classification: "base" },
    });
    expect(gone.statusCode).toBe(404);
  });

  it("resolve-finding closes a named finding (and waive keeps the reason)", async () => {
    const { quoteId } = await attachToNewQuote();
    const record = store.get(`quotes-v2/${quoteId}/workbook-import.json`) as ImportRecord;
    const findings = record.current.parse.findings;
    const openBefore = findings.length;

    const resolved = await call({
      method: "POST",
      query: { action: "resolve-finding" },
      body: { quoteId, findingId: findings[0]!.id, resolution: "resolved" },
    });
    expect(resolved.statusCode).toBe(200);
    const afterOne = (resolved.body as { workbookImport: ImportRecord }).workbookImport;
    expect(afterOne.status.openFindings).toBe(openBefore - 1);

    const waived = await call({
      method: "POST",
      query: { action: "resolve-finding" },
      body: { quoteId, findingId: findings[1]!.id, resolution: "waived", reason: "builder confirmed rate" },
    });
    const afterTwo = (waived.body as { workbookImport: ImportRecord }).workbookImport;
    expect(afterTwo.status.openFindings).toBe(openBefore - 2);
    expect(afterTwo.resolutions).toContainEqual(
      expect.objectContaining({ findingId: findings[1]!.id, action: "waived", reason: "builder confirmed rate" })
    );

    const badAction = await call({
      method: "POST",
      query: { action: "resolve-finding" },
      body: { quoteId, findingId: findings[0]!.id, resolution: "ignore" },
    });
    expect(badAction.statusCode).toBe(400);
    const badId = await call({
      method: "POST",
      query: { action: "resolve-finding" },
      body: { quoteId, findingId: "nope:X!Y1", resolution: "resolved" },
    });
    expect(badId.statusCode).toBe(404);
  });

  it("complete-review stamps the honest counts at sign-off — no fake clean state", async () => {
    const { quoteId } = await attachToNewQuote();
    const res = await call({
      method: "POST",
      query: { action: "complete-review" },
      body: { quoteId },
    });
    expect(res.statusCode).toBe(200);
    const record = (res.body as { workbookImport: ImportRecord }).workbookImport;
    expect(record.review.status).toBe("complete");
    expect(record.review.openFindingsAtCompletion).toBeGreaterThan(0);
    expect(record.review.unconfirmedAtCompletion).toBe(9);
  });

  it("review actions on a quote with no import → 404", async () => {
    const res = await call({
      method: "POST",
      query: { action: "complete-review" },
      body: { quoteId: "qv2_never" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("create-job with quoteId — the live job↔quote link", () => {
  it("records job.fromQuoteId and quote.linkedJobId (readable by reconciliation)", async () => {
    const { quoteId } = await attachToNewQuote();
    const res = await call({
      method: "POST",
      query: { action: "create-job" },
      body: attachBody({ name: "100 Arthur St", quoteId }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.body as { jobId: string; quoteId: string };
    expect(body.quoteId).toBe(quoteId);

    // job.fromQuoteId — the exact field blobReconciliationDeps.loadScope reads.
    const jobs = (store.get("jobs.json") as { jobs: Array<{ id: string; fromQuoteId?: string }> }).jobs;
    expect(jobs.find((j) => j.id === body.jobId)?.fromQuoteId).toBe(quoteId);

    // The quote remembers the job it became.
    const doc = store.get(`quotes-v2/${quoteId}.json`) as QuoteDoc;
    expect(doc.linkedJobId).toBe(body.jobId);

    // The cost basis carries the link too.
    const cost = store.get(`jobs/${body.jobId}/cost-import.json`) as { quoteId?: string };
    expect(cost.quoteId).toBe(quoteId);
  });

  it("404s on an unknown quoteId (and writes no job)", async () => {
    const res = await call({
      method: "POST",
      query: { action: "create-job" },
      body: attachBody({ name: "X", quoteId: "qv2_nope" }),
    });
    expect(res.statusCode).toBe(404);
    expect((store.get("jobs.json") as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("without quoteId behaves exactly as before (no link written)", async () => {
    const res = await call({
      method: "POST",
      query: { action: "create-job" },
      body: attachBody({ name: "Standalone job" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.body as { jobId: string; quoteId?: string };
    expect(body.quoteId).toBeUndefined();
    const jobs = (store.get("jobs.json") as { jobs: Array<{ id: string; fromQuoteId?: string }> }).jobs;
    expect(jobs.find((j) => j.id === body.jobId)?.fromQuoteId).toBeUndefined();
  });
});
