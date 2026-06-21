import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/tags.js — the real serverless handler against a
 * mocked Vercel Blob store and real HMAC sessions.
 *
 * Focus: the LEGACY-SHAPE bug ("couldn't load register"). Old jobs store
 * jobs/<id>/tags.json as a BARE ARRAY `[...]`, not `{ tags: [...] }`. The GET
 * used to return it as-is, so the rebuilt page's TagListResponseSchema ({ tags })
 * failed to parse and PUT/DELETE/POST broke. readRegister() normalises on read;
 * writes heal the shape. These tests pin that across every CRUD path + assert no
 * regression for the modern shape + the auth gates.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const tagsPath = requireFromHere.resolve("../../../api/tags.js");

let blob: Map<string, unknown>;
const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

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

async function call(opts: {
  method: string;
  role?: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_field", opts.role || "electrician") },
  };
  await handler(req, res);
  return res;
}

const TAGS_KEY_LEGACY = "jobs/job-legacy/tags.json";
const TAGS_KEY_MODERN = "jobs/job-modern/tags.json";

// Two real legacy rows (name-only, no applianceType) stored as a BARE ARRAY.
const LEGACY_ROWS = [
  { id: "t1", name: "Temp Board 1", tagNumber: "102742", owner: "Oskar", testDate: "02/04/2026", expiryDate: "02/05/2026", addedDate: "09/04/2026" },
  { id: "t2", name: "Temp Board 2", tagNumber: "102741", owner: "Buhl", testDate: "02/04/2026", expiryDate: "02/05/2026", addedDate: "09/04/2026" },
];

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-legacy", "job-modern", "job-empty"] },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-legacy"] },
        ],
      },
    ],
    [
      "jobs.json",
      { jobs: [{ id: "job-legacy", name: "Legacy" }, { id: "job-modern", name: "Modern" }, { id: "job-empty", name: "Empty" }] },
    ],
    [TAGS_KEY_LEGACY, clone(LEGACY_ROWS)], // BARE ARRAY (the bug)
    [TAGS_KEY_MODERN, { tags: [{ id: "m1", applianceType: "Hilti drill", tagNumber: "555", testDate: "01/06/2026", expiryDate: "01/12/2026" }] }],
  ]);

  delete requireFromHere.cache[blobPath];
  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[tagsPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(tagsPath);
});

type TagList = { tags: Array<{ id: string; name?: string; owner?: string }> };
const stored = (key: string) => blob.get(key) as { tags?: unknown };

describe("GET /api/tags — legacy bare-array normalisation (the fix)", () => {
  it("returns a LEGACY bare-array register as { tags: [...] } — the two records load", async () => {
    const res = await call({ method: "GET", query: { jobId: "job-legacy" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as TagList;
    expect(Array.isArray(body.tags)).toBe(true);
    expect(body.tags.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(body.tags[0]!.name).toBe("Temp Board 1");
  });

  it("returns a MODERN { tags } register unchanged (no regression)", async () => {
    const res = await call({ method: "GET", query: { jobId: "job-modern" } });
    expect((res.body as TagList).tags.map((t) => t.id)).toEqual(["m1"]);
  });

  it("returns { tags: [] } for a job with no register blob", async () => {
    const res = await call({ method: "GET", query: { jobId: "job-empty" } });
    expect(res.body).toEqual({ tags: [] });
  });
});

describe("writes heal a legacy bare-array register to { tags }", () => {
  it("POST appends to a legacy register (existing rows preserved) + heals the shape", async () => {
    const res = await call({
      method: "POST",
      query: { jobId: "job-legacy" },
      body: { applianceType: "Extension lead", tagNumber: "999", expiryDate: "01/01/2027" },
    });
    expect(res.statusCode).toBe(200);
    const reg = stored(TAGS_KEY_LEGACY);
    expect(Array.isArray(reg)).toBe(false); // healed: object, not array
    expect(Array.isArray(reg.tags)).toBe(true);
    expect((reg.tags as unknown[]).length).toBe(3); // 2 legacy + 1 new
  });

  it("PUT edits a LEGACY tag (was a 404 before the fix) + heals", async () => {
    const res = await call({ method: "PUT", query: { jobId: "job-legacy" }, body: { id: "t1", owner: "Updated" } });
    expect(res.statusCode).toBe(200);
    const reg = stored(TAGS_KEY_LEGACY);
    expect(Array.isArray(reg)).toBe(false);
    const t1 = (reg.tags as Array<{ id: string; owner: string }>).find((t) => t.id === "t1");
    expect(t1!.owner).toBe("Updated");
  });

  it("DELETE removes a legacy tag + heals; the other legacy row survives", async () => {
    const res = await call({ method: "DELETE", query: { jobId: "job-legacy" }, body: { id: "t2" } });
    expect(res.statusCode).toBe(200);
    const reg = stored(TAGS_KEY_LEGACY);
    expect(Array.isArray(reg)).toBe(false);
    expect((reg.tags as Array<{ id: string }>).map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("auth gates unchanged", () => {
  it("anonymous GET → 401", async () => {
    const res = await call({ method: "GET", query: { jobId: "job-legacy" }, anon: true });
    expect(res.statusCode).toBe(401);
  });

  it("read-only client POST → 403", async () => {
    const res = await call({
      method: "POST",
      role: "client",
      userId: "u_client",
      query: { jobId: "job-legacy" },
      body: { applianceType: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});
