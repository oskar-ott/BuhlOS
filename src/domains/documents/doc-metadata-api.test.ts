import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/doc-metadata.js — the AI metadata auto-fill endpoint. Real handler + real
 * auth/flag libs, stubbed blob, MOCKED ai gateway (the real API is never
 * called), MOCKED ai-spend ledger and pdf-text layer (so unpdf never runs).
 *
 * READ-ONLY endpoint: it proposes register metadata and writes nothing but the
 * shared spend ledger. Covers: flag-dark 404, client 403, non-manager 403,
 * unconfigured 503, over-budget 402 (before any AI call), a good reply → 200
 * with off-enum category DROPPED (not coerced) + drawingNumber/revision passed
 * through, garbled JSON → 502 (nothing applied), and a >10 MB dataUrl → 413.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const aiPath = requireFromHere.resolve("../../../api/_lib/ai.js");
const aiSpendPath = requireFromHere.resolve("../../../api/_lib/ai-spend.js");
const pdfTextPath = requireFromHere.resolve("../../../api/_lib/pdf-text.js");
const handlerPath = requireFromHere.resolve("../../../api/doc-metadata.js");

class FakeAiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

type AnyRecord = Record<string, unknown>;

let store: Map<string, unknown>;
let aiConfigured: boolean;
let aiCompleteMock: ReturnType<typeof vi.fn>;
let spendTotalUsd: number;
let recordedSpends: AnyRecord[];
let auth: { signSession: (p: AnyRecord) => string };
let handler: (req: AnyRecord, res: ReturnType<typeof createRes>) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function createRes() {
  return {
    statusCode: 200,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response body asserted per test
    body: null as any,
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

const TXT_DATA_URL = "data:text/plain;base64,SGVsbG8="; // "Hello"

async function call(opts: {
  method?: string;
  role?: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method || "POST",
    query: opts.query || { jobId: "job-1" },
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_boss", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}

const suggest = (body: AnyRecord = {}, over: Partial<Parameters<typeof call>[0]> = {}) =>
  call({
    method: "POST",
    query: { jobId: "job-1" },
    body: { dataUrl: TXT_DATA_URL, fileName: "Level 1 Power.pdf", ...body },
    ...over,
  });

function modelReply(obj: AnyRecord): string {
  return JSON.stringify(obj);
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_AI_DRAWINGS = "1";
  aiConfigured = true;
  spendTotalUsd = 0;
  recordedSpends = [];
  aiCompleteMock = vi.fn(async () => ({
    text: modelReply({
      title: "Level 1 Power Layout",
      category: "plan",
      discipline: "electrical",
      drawingNumber: "E-101",
      revision: "C",
      confidence: 0.9,
    }),
    usage: { inputTokens: 800, outputTokens: 120 },
    model: "claude-sonnet-4-6",
  }));

  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", name: "The Boss", role: "boss", assignedJobIds: [] },
          { id: "u_lh_off", username: "lhoff", role: "leadingHand", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-1"] },
        ],
      },
    ],
  ]);

  for (const p of [authPath, ffPath, handlerPath]) delete requireFromHere.cache[p];

  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        store.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  requireFromHere.cache[aiPath] = {
    id: aiPath,
    filename: aiPath,
    loaded: true,
    exports: {
      AiError: FakeAiError,
      isAiConfigured: () => aiConfigured,
      assistantModel: () => "claude-sonnet-4-6",
      aiComplete: (...args: unknown[]) => aiCompleteMock(...args),
    },
  } as NodeJS.Module;

  // In-memory ai-spend seam — the real ledger's shape without blob CAS.
  requireFromHere.cache[aiSpendPath] = {
    id: aiSpendPath,
    filename: aiSpendPath,
    loaded: true,
    exports: {
      COST_CAP_USD: 5,
      readTakeoff: async () => ({ spend: { totalUsd: spendTotalUsd, calls: [] } }),
      overBudget: (tk: { spend: { totalUsd: number } }) => tk.spend.totalUsd >= 5,
      recordSpend: (
        tk: { spend: { totalUsd: number } },
        _usage: unknown,
        kind: string,
        meta: unknown,
      ) => {
        tk.spend.totalUsd += 0.01;
        recordedSpends.push({ kind, meta });
      },
      commitTakeoff: async (
        _jobId: string,
        apply: (tk: { spend: { totalUsd: number; calls: unknown[] } }) => unknown,
      ) => {
        const tk = { spend: { totalUsd: spendTotalUsd, calls: [] as unknown[] } };
        const payload = apply(tk);
        spendTotalUsd = tk.spend.totalUsd;
        return payload;
      },
    },
  } as NodeJS.Module;

  // Mock the PDF text layer so unpdf never runs in unit tests. The TXT fixture
  // isn't a PDF anyway; this keeps the require graph resolvable + deterministic.
  requireFromHere.cache[pdfTextPath] = {
    id: pdfTextPath,
    filename: pdfTextPath,
    loaded: true,
    exports: {
      extractPdfText: async () => ({ ok: true, pages: [{ page: 1, text: "" }], totalChars: 0 }),
      isMeaningfulText: () => false,
      MEANINGFUL_TEXT_MIN_CHARS: 40,
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  for (const p of [blobPath, aiPath, aiSpendPath, pdfTextPath, authPath, ffPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }
  delete process.env.FLAG_AI_DRAWINGS;
  vi.restoreAllMocks();
});

describe("gates", () => {
  it("401 for an anonymous caller", async () => {
    expect((await suggest({}, { anon: true })).statusCode).toBe(401);
  });

  it("404 when the flag is dark — endpoint invisible, model never called", async () => {
    process.env.FLAG_AI_DRAWINGS = "0";
    const res = await suggest();
    expect(res.statusCode).toBe(404);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  // `ai_drawings` is an ADMIN-TIER flag, so non-admin roles never pass the flag
  // gate — they read the endpoint as invisible (404), a stronger guarantee than
  // 403 (the contract-extractions precedent). The handler's explicit client /
  // canManageJob 403s remain as defence-in-depth for any future re-targeting;
  // what matters for security is that neither role can ever spend: the model is
  // never called.
  it("invisible (404) to a client role — read-only, never spends the AI budget", async () => {
    const res = await suggest({}, { userId: "u_client", role: "client" });
    expect(res.statusCode).toBe(404);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("invisible (404) to a leading hand (non-admin tier) — never spends", async () => {
    const res = await suggest({}, { userId: "u_lh_off", role: "leadingHand" });
    expect(res.statusCode).toBe(404);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });
});

describe("reads + proposes", () => {
  it("503 honestly when AI is unconfigured — nothing invented", async () => {
    aiConfigured = false;
    const res = await suggest();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("UNCONFIGURED");
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("400 without a data: URL", async () => {
    const res = await suggest({ dataUrl: "https://example.com/x.pdf" });
    expect(res.statusCode).toBe(400);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("402 before spending once the per-job cap is reached", async () => {
    spendTotalUsd = 9999;
    const res = await suggest();
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toContain("cost cap");
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("413 when the decoded file is over 10 MB", async () => {
    // 11 MB of base64-decoded bytes: base64 length ≈ 4/3 of byte count.
    const bigPayload = "A".repeat(Math.ceil((11 * 1024 * 1024 * 4) / 3));
    const res = await suggest({ dataUrl: `data:application/pdf;base64,${bigPayload}` });
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toContain("too large");
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("200 with a good reply — fields validated, spend recorded once", async () => {
    const res = await suggest();
    expect(res.statusCode).toBe(200);
    expect(aiCompleteMock).toHaveBeenCalledTimes(1);
    expect(res.body.suggestion).toEqual({
      title: "Level 1 Power Layout",
      category: "plan",
      discipline: "electrical",
      drawingNumber: "E-101",
      revision: "C",
    });
    expect(res.body.confidence).toBe(0.9);
    expect(res.body.spend.capUsd).toBe(5);
    expect(recordedSpends).toHaveLength(1);
    expect(recordedSpends[0]!.kind).toBe("doc-metadata");
  });

  it("drops an OFF-ENUM category (never coerced) but passes drawing number / revision through", async () => {
    aiCompleteMock = vi.fn(async () => ({
      text: modelReply({
        title: "Some sheet",
        category: "blueprint", // not in the closed set → dropped
        discipline: "plumbing", // not in the closed set → dropped
        drawingNumber: "A-200",
        revision: "B",
        confidence: 0.5,
      }),
      usage: { inputTokens: 10, outputTokens: 10 },
      model: "claude-sonnet-4-6",
    }));
    const res = await suggest();
    expect(res.statusCode).toBe(200);
    expect("category" in res.body.suggestion).toBe(false);
    expect("discipline" in res.body.suggestion).toBe(false);
    expect(res.body.suggestion.drawingNumber).toBe("A-200");
    expect(res.body.suggestion.revision).toBe("B");
  });

  it("502 on garbled JSON — nothing applied, but the spend is still recorded", async () => {
    aiCompleteMock = vi.fn(async () => ({
      text: "sorry, I can't read this file",
      usage: { inputTokens: 10, outputTokens: 10 },
      model: "claude-sonnet-4-6",
    }));
    const res = await suggest();
    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe("MODEL_INVALID_REPLY");
    expect(recordedSpends).toHaveLength(1); // the money was spent — recorded
  });
});

describe("pure normaliseSuggestion (__test)", () => {
  it("drops off-enum category/discipline, trims + caps, defaults ids to ''", () => {
    const { normaliseSuggestion } = (
      requireFromHere(handlerPath) as {
        __test: {
          normaliseSuggestion: (raw: unknown) => {
            suggestion: AnyRecord;
            confidence: number | null;
          } | null;
        };
      }
    ).__test;
    const out = normaliseSuggestion({
      title: "  Padded title  ",
      category: "PLAN", // case-insensitive → plan
      discipline: "nonsense", // dropped
      drawingNumber: "  E-1  ",
      confidence: 2, // clamped to 1
    })!;
    expect(out.suggestion.title).toBe("Padded title");
    expect(out.suggestion.category).toBe("plan");
    expect("discipline" in out.suggestion).toBe(false);
    expect(out.suggestion.drawingNumber).toBe("E-1");
    expect(out.suggestion.revision).toBe("");
    expect(out.confidence).toBe(1);
    expect(normaliseSuggestion("not an object")).toBeNull();
  });
});
