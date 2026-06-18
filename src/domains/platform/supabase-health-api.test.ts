import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #533 — the read-only Supabase connectivity proving slice
 * (GET /api/supabase-health). Real signed session + real auth tier helpers +
 * the real feature-flag module; the blob store and the Supabase DB client are
 * injected (no network, no live Postgres). Pins: admin-only gating,
 * dark-by-default (flag off → inert, the DB is never touched), the healthy
 * shape, and honest failure (a connect error → 502, never a faked success).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const dbPath = requireFromHere.resolve("../../../api/_lib/supabase-db.js");
const flagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const handlerPath = requireFromHere.resolve("../../../api/supabase-health.js");

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
let getDbCalls: number;
let dbMode: "ok" | "fail" | "guard-throw";
let blob: Map<string, unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// getCurrentUser resolves the session user from users.json by id and returns
// the BLOB role — so each cookie's userId must map to a seeded user.
const ROLE_USER: Record<string, string> = {
  boss: "u_admin",
  electrician: "u_field",
  client: "u_client",
};

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
  const token = auth.signSession({ userId, role, exp: Date.now() + 60_000 });
  return `buhl_session=${token}`;
}

async function call(opts: { method?: string; role?: string; userId?: string; anon?: boolean }) {
  const res = createRes();
  const role = opts.role || "boss";
  const userId = opts.userId || ROLE_USER[role] || "u_admin";
  const req = {
    method: opts.method || "GET",
    query: {},
    headers: opts.anon ? {} : { cookie: cookieFor(userId, role) },
  };
  await handler(req, res);
  return res;
}

// A fake Postgres.js `sql` tagged-template: answers the three health queries
// the handler runs, or rejects to simulate a connection / auth failure.
function fakeSql(strings: TemplateStringsArray) {
  if (dbMode === "fail") {
    return Promise.reject(
      Object.assign(new Error('password authentication failed for user "postgres"'), { code: "28P01" })
    );
  }
  const q = strings.join(" ");
  if (/information_schema\.tables/.test(q)) return Promise.resolve([{ n: 31 }]);
  if (/schema_migrations/.test(q)) return Promise.resolve([{ n: 2 }]);
  if (/version\(\)/.test(q)) return Promise.resolve([{ v: "PostgreSQL 17.6 on aarch64-unknown-linux-gnu" }]);
  return Promise.resolve([]);
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.FLAG_SUPABASE_READ_HEALTH;
  delete process.env.SUPABASE_ENV;
  delete process.env.SUPABASE_PROJECT_REF;
  getDbCalls = 0;
  dbMode = "ok";

  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", role: "boss", assignedJobIds: [] },
          { id: "u_field", role: "electrician", assignedJobIds: [] },
          { id: "u_client", role: "client", assignedJobIds: [] },
        ],
      },
    ],
  ]);

  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      // getCurrentUser reads users.json; feature-flags reads flags.json
      // (absent → fallback, so the flag stays env-controlled in these tests).
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  requireFromHere.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      getDb: vi.fn(() => {
        getDbCalls++;
        // The supabase-env guard throws SYNCHRONOUSLY inside the real getDb()
        // on a misconfigured / production-without-env runtime — simulate that
        // so the headline "guarded → fails closed → 502" path is pinned.
        if (dbMode === "guard-throw") {
          throw Object.assign(new Error("SUPABASE_ENV is not set"), { code: "MISSING_ENV" });
        }
        return fakeSql;
      }),
      closeDb: vi.fn(async () => {}),
    },
  } as NodeJS.Module;

  delete requireFromHere.cache[flagsPath];
  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[handlerPath];
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("GET /api/supabase-health (#533 read-only proving slice)", () => {
  it("is dark by default: admin gets { enabled:false } and the DB is never touched", async () => {
    const res = await call({ role: "boss" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    expect(getDbCalls).toBe(0);
  });

  it("flag on + admin → live health read from Supabase", async () => {
    process.env.FLAG_SUPABASE_READ_HEALTH = "true";
    const res = await call({ role: "boss" });
    expect(res.statusCode).toBe(200);
    expect(getDbCalls).toBe(1);
    const body = res.body as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.publicTables).toBe(31);
    expect(body.migrations).toBe(2);
    expect(String(body.server)).toMatch(/^PostgreSQL/);
    // proves the "on aarch64-…" host detail is trimmed off
    expect(String(body.server)).not.toContain(" on ");
  });

  it("flag on + admin + connect failure → 502, honest, never faked", async () => {
    process.env.FLAG_SUPABASE_READ_HEALTH = "true";
    dbMode = "fail";
    const res = await call({ role: "boss" });
    expect(res.statusCode).toBe(502);
    const body = res.body as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("28P01");
  });

  it("flag on + admin + the env guard throws inside getDb → 502 (the 'fails closed' path)", async () => {
    process.env.FLAG_SUPABASE_READ_HEALTH = "true";
    dbMode = "guard-throw";
    const res = await call({ role: "boss" });
    expect(res.statusCode).toBe(502);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("MISSING_ENV");
  });

  it("403s a field worker even with the flag on, and never touches the DB", async () => {
    process.env.FLAG_SUPABASE_READ_HEALTH = "true";
    const res = await call({ role: "electrician" });
    expect(res.statusCode).toBe(403);
    expect(getDbCalls).toBe(0);
  });

  it("403s a client", async () => {
    process.env.FLAG_SUPABASE_READ_HEALTH = "true";
    const res = await call({ role: "client" });
    expect(res.statusCode).toBe(403);
  });

  it("401s an unauthenticated request", async () => {
    const res = await call({ anon: true });
    expect(res.statusCode).toBe(401);
  });

  it("405s a non-GET method", async () => {
    process.env.FLAG_SUPABASE_READ_HEALTH = "true";
    const res = await call({ method: "POST", role: "boss" });
    expect(res.statusCode).toBe(405);
  });
});
