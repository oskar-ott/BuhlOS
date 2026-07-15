import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/data.js — the per-job state document endpoint.
 *
 * #509: the POST whole-document overwrite was DISARMED. This endpoint is now
 * READ-ONLY (GET). The regression contract a job's data depends on:
 *   - GET still returns the { dwellings, snags, notes, evidence, ... } blob
 *   - every mutating method (POST included) returns 405 and writes NOTHING —
 *     so a stale/partial body can never wipe evidence/snagsV2/notes again
 *   - the disarm holds even for an unauthenticated POST (the method gate runs
 *     before auth), so the unsafe write path is categorically unreachable
 *
 * Same real-handler harness as task-toggle-api.test.ts: the in-memory Vercel
 * Blob replacement is injected into the require cache, then the real auth + the
 * real handler are loaded so requireAuth/getCurrentUser run for real.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/data.js");

let blob: Map<string, unknown>;
let writeSpy: ReturnType<typeof vi.fn>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>,
) => Promise<unknown>;

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

function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call({
  method = "GET",
  cookie,
  jobId,
  body,
}: {
  method?: string;
  cookie?: string;
  jobId?: string;
  body?: unknown;
}) {
  const res = createRes();
  await handler(
    {
      method,
      query: jobId ? { jobId } : {},
      body,
      headers: cookie ? { cookie } : {},
    },
    res,
  );
  return res;
}

const JOB = "job-active";
const DATA_KEY = `jobs/${JOB}/data.json`;

// A populated job document — exactly the kind of data a blind overwrite would wipe.
const SEED_DATA = {
  dwellings: { "area-1": { roughIn: { tasks: { t1: "complete" } } } },
  snags: [{ id: "s1", desc: "legacy snag" }],
  snagsV2: [{ id: "sv1", title: "v2 snag" }],
  notes: [{ id: "n1", text: "a note" }],
  evidence: [{ id: "ev1", kind: "photo" }],
};

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: [JOB] },
          { id: "u_other", username: "elsewhere", role: "electrician", assignedJobIds: ["job-other"] },
        ],
      },
    ],
    [DATA_KEY, clone(SEED_DATA)],
  ]);

  writeSpy = vi.fn(async (key: string, data: unknown) => {
    blob.set(key, clone(data));
  });

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[handlerPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: writeSpy,
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("GET /api/data — read-only access preserved", () => {
  it("returns the full job data blob for an assigned field worker", async () => {
    const res = await call({ method: "GET", cookie: cookieFor("u_field", "electrician"), jobId: JOB });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(SEED_DATA);
  });

  it("returns the blob for an admin", async () => {
    const res = await call({ method: "GET", cookie: cookieFor("u_admin", "admin"), jobId: JOB });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ evidence: [{ id: "ev1", kind: "photo" }] });
  });

  it("falls back to an empty document when the job has no data blob yet", async () => {
    const res = await call({ method: "GET", cookie: cookieFor("u_admin", "admin"), jobId: "job-fresh" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ dwellings: {}, snags: [], notes: [] });
  });

  it("401s an unauthenticated GET", async () => {
    const res = await call({ method: "GET", jobId: JOB });
    expect(res.statusCode).toBe(401);
  });

  it("now serves any worker an active job (all-jobs access)", async () => {
    const res = await call({ method: "GET", cookie: cookieFor("u_other", "electrician"), jobId: JOB });
    expect(res.statusCode).toBe(200);
  });

  it("400s a GET with no jobId", async () => {
    const res = await call({ method: "GET", cookie: cookieFor("u_admin", "admin") });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/data — disarmed (#509): cannot overwrite the document", () => {
  it("405s a POST and writes NOTHING, leaving evidence/snagsV2/notes intact", async () => {
    const wipeBody = { dwellings: {}, snags: [], notes: [] }; // would have wiped everything
    const res = await call({
      method: "POST",
      cookie: cookieFor("u_admin", "admin"),
      jobId: JOB,
      body: wipeBody,
    });
    expect(res.statusCode).toBe(405);
    expect(res.body).toMatchObject({ error: "method not allowed" });
    // No write happened — the seeded document is untouched.
    expect(writeSpy).not.toHaveBeenCalled();
    expect(blob.get(DATA_KEY)).toEqual(SEED_DATA);
  });

  it("405s even an unauthenticated POST — the write path is categorically unreachable", async () => {
    const res = await call({ method: "POST", jobId: JOB, body: { dwellings: {} } });
    expect(res.statusCode).toBe(405);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(blob.get(DATA_KEY)).toEqual(SEED_DATA);
  });

  it("the 405 detail points callers at the field-owned write endpoints", async () => {
    const res = await call({ method: "POST", cookie: cookieFor("u_admin", "admin"), jobId: JOB, body: {} });
    expect((res.body as { detail?: string }).detail).toContain("/api/task-toggle");
    expect((res.body as { detail?: string }).detail).toContain("/api/snag-quick-raise");
  });

  it("405s other mutating methods (PUT) too", async () => {
    const res = await call({ method: "PUT", cookie: cookieFor("u_admin", "admin"), jobId: JOB });
    expect(res.statusCode).toBe(405);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("200s an OPTIONS preflight", async () => {
    const res = await call({ method: "OPTIONS" });
    expect(res.statusCode).toBe(200);
  });
});
