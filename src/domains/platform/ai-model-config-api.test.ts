import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Lean reset: quotes are dark by default — these tests exercise the enabled behaviour (quote ai-review rides api/quotes.js).
beforeAll(() => {
  process.env.FLAG_QUOTES = "1";
});
afterAll(() => {
  delete process.env.FLAG_QUOTES;
});

/**
 * #378 — the Claude model ids used by tag OCR (api/tags.js) and quote
 * ai-review (api/quotes.js) are env-configurable with a CURRENT bare-alias
 * default. The previous pins were a dated id (retiring 2026-06-15, would
 * have broken field OCR) and a retired family (ai-review already failing).
 *
 * Real handlers, signed sessions, in-memory blob; global fetch is stubbed
 * with a router so the OUTGOING api.anthropic.com request body is captured
 * and asserted — that's the wire-level contract this issue changes.
 *
 * The model constants are read at module load, so handlers are required
 * lazily INSIDE each test after the env is arranged.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const tagsPath = requireFromHere.resolve("../../../api/tags.js");
const quotesPath = requireFromHere.resolve("../../../api/quotes.js");

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

let blob: Map<string, unknown>;
let anthropicCalls: Array<{ model: string; messages: unknown[] }>;
let anthropicReply: string;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
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

/** Fresh require of a handler AFTER env vars are arranged. */
function loadHandler(path: string): Handler {
  for (const p of [authPath, tagsPath, quotesPath]) delete requireFromHere.cache[p];
  return requireFromHere(path) as Handler;
}

function cookieFor(userId: string, role: string): string {
  const auth = requireFromHere(authPath) as {
    signSession: (p: Record<string, unknown>) => string;
  };
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";
  delete process.env.TAGS_AI_MODEL;
  delete process.env.QUOTES_AI_MODEL;

  blob = new Map<string, unknown>();
  anthropicCalls = [];
  anthropicReply = "{}";

  blob.set("users.json", {
    users: [{ id: "u_admin", username: "boss", role: "admin", passwordHash: "$2a$10$x" }],
  });
  blob.set("jobs.json", { jobs: [{ id: "j1", name: "Riverside" }] });
  blob.set("quotes.json", {
    quotes: [{ id: "q1", name: "Tender A", status: "draft", createdAt: "2026-01-01" }],
  });

  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: { list: vi.fn(async () => ({ blobs: [] })), put: vi.fn(async () => ({})) },
  } as NodeJS.Module;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.startsWith("https://api.anthropic.com/")) {
        anthropicCalls.push(JSON.parse(init?.body ?? "{}"));
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: anthropicReply }] }),
          text: async () => "",
        };
      }
      if (u.startsWith("https://img.example/")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "image/jpeg" },
          arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
        };
      }
      const key = u.replace(/^memory:\/\//, "").replace(/\?.*$/, "");
      if (!blob.has(key)) return { ok: false, json: async () => null };
      return { ok: true, json: async () => clone(blob.get(key)) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TAGS_AI_MODEL;
  delete process.env.QUOTES_AI_MODEL;
});

async function runOcr(): Promise<Res> {
  const handler = loadHandler(tagsPath);
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId: "j1", action: "ocr" },
      headers: { cookie: cookieFor("u_admin", "admin") },
      body: { photoUrl: "https://img.example/tag.jpg" },
    },
    res,
  );
  return res;
}

async function runAiReview(): Promise<Res> {
  const handler = loadHandler(quotesPath);
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { id: "q1", action: "ai-review" },
      headers: { cookie: cookieFor("u_admin", "admin") },
      body: { sourceText: "Supply and install 40 twin GPOs across levels 1-3." },
    },
    res,
  );
  return res;
}

describe("tag OCR model (#378)", () => {
  it("calls Anthropic with the current bare-alias default (no dated id)", async () => {
    anthropicReply = JSON.stringify({ tagNumber: "T-100", applianceType: "Drill" });
    const res = await runOcr();
    expect(res.statusCode).toBe(200);
    expect(anthropicCalls).toHaveLength(1);
    expect(anthropicCalls[0]!.model).toBe("claude-sonnet-4-6");
    // it's still a VISION call — the image block must survive the change
    const content = (anthropicCalls[0]!.messages[0] as { content: Array<{ type: string }> })
      .content;
    expect(content.some((b) => b.type === "image")).toBe(true);
  });

  it("TAGS_AI_MODEL env overrides the default", async () => {
    process.env.TAGS_AI_MODEL = "claude-test-override";
    const res = await runOcr();
    expect(res.statusCode).toBe(200);
    expect(anthropicCalls[0]!.model).toBe("claude-test-override");
  });

  it("still 500s loudly when ANTHROPIC_API_KEY is unset (no silent skip for OCR)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await runOcr();
      expect(res.statusCode).toBe(500);
      expect(anthropicCalls).toHaveLength(0);
    } finally {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";
    }
  });
});

describe("quote ai-review model (#378)", () => {
  it("calls Anthropic with the current bare-alias default (retired family gone)", async () => {
    anthropicReply = JSON.stringify({ summary: "Three-level GPO rollout." });
    const res = await runAiReview();
    expect(res.statusCode).toBe(201);
    expect(anthropicCalls).toHaveLength(1);
    expect(anthropicCalls[0]!.model).toBe("claude-sonnet-4-6");
    const review = (res.body as { review: { summary: string } }).review;
    expect(review.summary).toContain("Three-level");
  });

  it("QUOTES_AI_MODEL env overrides the default", async () => {
    process.env.QUOTES_AI_MODEL = "claude-test-override";
    const res = await runAiReview();
    expect(res.statusCode).toBe(201);
    expect(anthropicCalls[0]!.model).toBe("claude-test-override");
  });
});
