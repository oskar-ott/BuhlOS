import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for #384: duplicate/revise must carry the pricing
 * settings and provisional sums with the copy (totals previously reverted
 * silently to PRICING_DEFAULTS), and must strip the source's win/loss
 * record (acceptance / reasonLost) — a copy is a fresh draft.
 * Documents are deliberately NOT copied (admin uploads the new pack).
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const quotesPath = requireFromHere.resolve("../../../api/quotes.js");

type Res = ReturnType<typeof createRes>;
type Handler = ((req: Record<string, unknown>, res: Res) => Promise<unknown>) & {
  computeQuoteTotals: (sections: Record<string, unknown>) => Record<string, unknown>;
};

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let quotes: Handler;

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

async function callAction(action: string, id: string) {
  const res = createRes();
  await quotes(
    {
      method: "POST",
      body: {},
      query: { action, id },
      headers: { cookie: cookieFor("u_admin", "admin") },
    },
    res
  );
  return res;
}

const SRC_ID = "q_src";
const sectionKey = (id: string, file: string) => `quotes/${id}/${file}`;

const PRICING = {
  materialMarkupPct: { default: 40, Switchgear: 10 },
  labourSellRate: 120,
  labourCostMode: "per-line",
  labourCostRate: 65,
  contingencyPct: 5,
  gstPct: 10,
};
const MATERIALS = {
  items: [
    { id: "qmat_1", quoteId: SRC_ID, description: "TPS cable", category: "Cable", quantity: 100, unitCost: 2.5 },
    { id: "qmat_2", quoteId: SRC_ID, description: "DB upgrade", category: "Switchgear", totalCost: 1000 },
  ],
};
const LABOUR = {
  lines: [{ id: "qlab_1", quoteId: SRC_ID, estimatedHours: 10, crewSize: 2, riskFactor: 1.1, hourlyRate: 60 }],
};
const PROVISIONAL = {
  items: [
    { id: "qps_1", quoteId: SRC_ID, kind: "provisional", name: "Switchboard allowance", amountExGst: 2500 },
  ],
};
const NOTES = { assumptions: ["existing sensors reused"], exclusions: [], risks: [], clarifications: [] };

function srcQuote() {
  return {
    id: SRC_ID,
    name: "East Gym fitout",
    status: "won",
    version: 1,
    parentQuoteId: null,
    convertedJobId: null,
    acceptance: { acceptedAt: "2026-06-01T00:00:00.000Z", acceptedAmountExGst: 9000 },
    reasonLost: { category: "price", reason: "stale loss record from an earlier round" },
    createdAt: "2026-05-01T00:00:00.000Z",
    createdBy: "estimator",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function storedQuotes(): { quotes: Array<Record<string, unknown>> } {
  return blob.get("quotes.json") as { quotes: Array<Record<string, unknown>> };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "u_admin", role: "admin", assignedJobIds: [] },
          { id: "u_field", username: "u_field", role: "tradie", assignedJobIds: [] },
        ],
      },
    ],
    ["quotes.json", { quotes: [srcQuote(), { id: "q_legacy", name: "Old shed job", status: "draft", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] }],
    [sectionKey(SRC_ID, "structure.json"), { areaGroups: [{ id: "qag_1", name: "East Gym", areas: [{ id: "qar_1", name: "Court", workPackages: [] }] }] }],
    [sectionKey(SRC_ID, "materials-estimate.json"), MATERIALS],
    [sectionKey(SRC_ID, "labour-estimate.json"), LABOUR],
    [sectionKey(SRC_ID, "notes.json"), NOTES],
    [sectionKey(SRC_ID, "pricing.json"), PRICING],
    [sectionKey(SRC_ID, "provisional.json"), PROVISIONAL],
    [sectionKey(SRC_ID, "documents-index.json"), { documents: [{ id: "qdoc_1", name: "tender-pack-rev-a.pdf" }] }],
  ]);

  for (const modulePath of [blobPath, authPath, quotesPath]) {
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
        blob.set(key, clone(data));
      }),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  quotes = requireFromHere(quotesPath);
});

describe("quotes duplicate/revise carries commercial sections (#384)", () => {
  it("revise copies pricing + provisional, strips the win/loss record, and preserves totals", async () => {
    const res = await callAction("revise", SRC_ID);
    expect(res.statusCode).toBe(201);
    const q = (res.body as { quote: Record<string, unknown> }).quote;

    expect(q.status).toBe("draft");
    expect(q.version).toBe(2);
    expect(q.parentQuoteId).toBe(SRC_ID);
    expect(q.name).toBe("East Gym fitout (rev 2)");
    expect(q.acceptance).toBeUndefined();
    expect(q.reasonLost).toBeUndefined();

    // The persisted index record must not carry the keys at all.
    const persisted = storedQuotes().quotes.find((s) => s.id === q.id)!;
    expect(persisted).toBeDefined();
    expect("acceptance" in persisted).toBe(false);
    expect("reasonLost" in persisted).toBe(false);
    // The source quote keeps its own record untouched.
    const src = storedQuotes().quotes.find((s) => s.id === SRC_ID)!;
    expect(src.acceptance).toEqual(srcQuote().acceptance);

    // Pricing settings travel verbatim.
    const newPricing = blob.get(sectionKey(q.id as string, "pricing.json"));
    expect(newPricing).toEqual(PRICING);

    // Provisional sums travel with fresh ids pointing at the new quote.
    const newProvisional = blob.get(sectionKey(q.id as string, "provisional.json")) as {
      items: Array<Record<string, unknown>>;
    };
    expect(newProvisional.items).toHaveLength(1);
    const psCopy = newProvisional.items[0]!;
    expect(psCopy.name).toBe("Switchboard allowance");
    expect(psCopy.amountExGst).toBe(2500);
    expect(psCopy.quoteId).toBe(q.id);
    expect(psCopy.id).not.toBe("qps_1");

    // Documents are deliberately NOT copied — admin uploads the new pack.
    expect(blob.has(sectionKey(q.id as string, "documents-index.json"))).toBe(false);

    // Totals parity: the revision computes the exact totals of its predecessor.
    const totalsOf = (id: string) =>
      quotes.computeQuoteTotals({
        pricing: blob.get(sectionKey(id, "pricing.json")),
        materials: blob.get(sectionKey(id, "materials-estimate.json")),
        labour: blob.get(sectionKey(id, "labour-estimate.json")),
        provisional: blob.get(sectionKey(id, "provisional.json")),
      });
    expect(totalsOf(q.id as string)).toEqual(totalsOf(SRC_ID));
  });

  it("duplicate mode gives the same guarantees on a clean copy", async () => {
    const res = await callAction("duplicate", SRC_ID);
    expect(res.statusCode).toBe(201);
    const q = (res.body as { quote: Record<string, unknown> }).quote;

    expect(q.status).toBe("draft");
    expect(q.parentQuoteId).toBeNull();
    expect(q.version).toBeNull();
    expect(q.name).toBe("East Gym fitout (copy)");

    const persisted = storedQuotes().quotes.find((s) => s.id === q.id)!;
    expect("acceptance" in persisted).toBe(false);
    expect("reasonLost" in persisted).toBe(false);
    expect(blob.get(sectionKey(q.id as string, "pricing.json"))).toEqual(PRICING);
    expect(blob.has(sectionKey(q.id as string, "documents-index.json"))).toBe(false);
  });

  it("legacy quotes with no stored pricing/provisional sections revise cleanly on defaults", async () => {
    const res = await callAction("revise", "q_legacy");
    expect(res.statusCode).toBe(201);
    const q = (res.body as { quote: Record<string, unknown> }).quote;

    // Sections materialise from SECTION_DEFAULTS — present, empty, default-priced.
    const newPricing = blob.get(sectionKey(q.id as string, "pricing.json")) as Record<string, unknown>;
    expect(newPricing).toBeTruthy();
    expect((newPricing.materialMarkupPct as Record<string, unknown>).default).toBe(25);
    const newProvisional = blob.get(sectionKey(q.id as string, "provisional.json")) as {
      items: unknown[];
    };
    expect(newProvisional.items).toEqual([]);
  });

  it("refuses non-admin callers", async () => {
    const res = createRes();
    await quotes(
      {
        method: "POST",
        body: {},
        query: { action: "revise", id: SRC_ID },
        headers: { cookie: cookieFor("u_field", "tradie") },
      },
      res
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("convert is re-enabled and lands a DRAFT (#244)", () => {
  // The 410 "disabled" gate from #172 §8 / #183 is lifted: convert now routes
  // through the sanctioned creator (api/_lib/job-create.js) and lands a DRAFT.
  // Full convert coverage lives in quotes-convert-api.test.ts; this is the
  // guard that the gate was lifted, exercised on this file's won-quote fixture.
  it("no longer 410s; creates a draft job and flips the quote to converted_to_job", async () => {
    const res = await callAction("convert", SRC_ID);
    expect(res.statusCode).toBe(201);
    const jobId = (res.body as { jobId: string }).jobId;
    const job = (res.body as { job: { status: string } }).job;
    expect(job.status).toBe("draft");

    // The job store now exists and per-job seeds were written by createJob.
    expect(blob.has("jobs.json")).toBe(true);
    expect(blob.get(`jobs/${jobId}/data.json`)).toEqual({ dwellings: {}, snags: [], notes: [] });

    // Two-way trace.
    const src = storedQuotes().quotes.find((s) => s.id === SRC_ID)!;
    expect(src.status).toBe("converted_to_job");
    expect(src.convertedJobId).toBe(jobId);
  });
});
