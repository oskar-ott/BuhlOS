import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/client-errors (#154) — the client error-boundary report sink.
 * Real auth + error-log modules; only Blob is injected (no network).
 *
 * Pins the contract: POST-only (405 otherwise), always 202 on accepted input,
 * anonymous reports allowed but HARD-CAPPED (message ≤ 300, no stack, no
 * metadata), authenticated reports keep attribution + stack + digest, and
 * bodies over ~4KB are rejected (413).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const errorLogPath = requireFromHere.resolve("../../../api/_lib/error-log.js");
const handlerPath = requireFromHere.resolve("../../../api/client-errors.js");

type Handler = (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

interface StoredError {
  source: string;
  handler: string;
  message: string;
  stack: string | null;
  userId: string | null;
  metadata?: Record<string, unknown>;
}

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: Handler;
let blob: Map<string, unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function storedEntries(): StoredError[] {
  const doc = blob.get("platform/errors.json") as { entries?: StoredError[] } | undefined;
  return doc?.entries ?? [];
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

async function call(opts: {
  method?: string;
  anon?: boolean;
  body?: Record<string, unknown>;
}) {
  const res = createRes();
  const headers: Record<string, string> = {};
  if (!opts.anon) {
    const token = auth.signSession({ userId: "u_field", role: "electrician", exp: Date.now() + 60_000 });
    headers.cookie = `buhl_session=${token}`;
  }
  const req = { method: opts.method || "POST", query: {}, headers, body: opts.body || {} };
  await handler(req, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";

  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_field", role: "electrician", email: "field@buhl.test", passwordHash: "HASH", assignedJobIds: [] },
        ],
      },
    ],
  ]);

  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as unknown as NodeJS.Module;

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[errorLogPath];
  delete requireFromHere.cache[handlerPath];
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("POST /api/client-errors — method + abuse guards", () => {
  it("405s a GET", async () => {
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(405);
  });

  it("200s an OPTIONS preflight", async () => {
    const res = await call({ method: "OPTIONS" });
    expect(res.statusCode).toBe(200);
  });

  it("413s a body over ~4KB and records nothing", async () => {
    const res = await call({ body: { message: "boom", stack: "x".repeat(5000) } });
    expect(res.statusCode).toBe(413);
    expect(storedEntries()).toHaveLength(0);
  });

  it("202s an empty message without recording an entry", async () => {
    const res = await call({ body: { message: "   " } });
    expect(res.statusCode).toBe(202);
    expect(storedEntries()).toHaveLength(0);
  });
});

describe("POST /api/client-errors — authenticated report", () => {
  it("202s and records attribution, stack, digest, and the page path", async () => {
    const res = await call({
      body: {
        message: "Cannot read properties of undefined",
        stack: "TypeError: Cannot read\n  at Page",
        digest: "digest123",
        url: "/v2/jobs/job_1",
      },
    });
    expect(res.statusCode).toBe(202);
    const stored = storedEntries();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.source).toBe("client");
    expect(stored[0]!.handler).toBe("page:/v2/jobs/job_1");
    expect(stored[0]!.userId).toBe("u_field");
    expect(stored[0]!.stack).toContain("TypeError");
    expect(stored[0]!.metadata).toEqual({ digest: "digest123" });
  });
});

describe("POST /api/client-errors — anonymous report (pre-login crash)", () => {
  it("202s and records a hard-capped entry: message ≤ 300, no stack, no metadata", async () => {
    const res = await call({
      anon: true,
      body: {
        message: "m".repeat(400),
        stack: "should be dropped",
        digest: "digest123",
        url: "/v2/login",
      },
    });
    expect(res.statusCode).toBe(202);
    const stored = storedEntries();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.source).toBe("client");
    expect(stored[0]!.userId).toBeNull();
    expect(stored[0]!.message).toHaveLength(300);
    expect(stored[0]!.stack).toBeNull();
    expect(stored[0]!.metadata).toBeUndefined();
  });

  it("degrades a broken session to anonymous rather than failing", async () => {
    const res = createRes();
    const req = {
      method: "POST",
      query: {},
      headers: { cookie: "buhl_session=garbage" },
      body: { message: "boom", url: "/v2/login" },
    };
    await handler(req, res);
    expect(res.statusCode).toBe(202);
    expect(storedEntries()[0]!.userId).toBeNull();
  });
});
