import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/owner-settings — the per-feature config-knob write path (#760 PR2).
 * Real signed session + real auth + real feature-settings / audit / guards;
 * only Blob is injected. Pins the same fail-closed owner boundary as the rest of
 * the console, registry validation (unknown 404 / out-of-range 400), CAS, and the
 * feature_config.changed audit.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const guardsPath = requireFromHere.resolve("../../../api/_lib/blob-guards.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const settingsPath = requireFromHere.resolve("../../../api/_lib/feature-settings.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const handlerPath = requireFromHere.resolve("../../../api/owner-settings.js");

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
let blob: Map<string, unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

const ROLE_USER: Record<string, string> = {
  owner: "u_owner",
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
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call(opts: {
  method?: string;
  role?: string;
  userId?: string;
  anon?: boolean;
  body?: Record<string, unknown>;
}) {
  const res = createRes();
  const role = opts.role || "owner";
  const userId = opts.userId || ROLE_USER[role] || "u_owner";
  const req = {
    method: opts.method || "PUT",
    query: {},
    headers: opts.anon ? {} : { cookie: cookieFor(userId, role) },
    body: opts.body || {},
  };
  await handler(req, res);
  return res;
}

function settingsDoc() {
  return (blob.get("feature-settings.json") as { settings?: Record<string, Record<string, unknown>> }) || {};
}

function auditEntriesThisMonth(): Array<Record<string, unknown>> {
  const ym = new Date().toISOString().slice(0, 7);
  const doc = blob.get(`audit/${ym}.json`) as { entries?: Array<Record<string, unknown>> } | undefined;
  return doc?.entries ?? [];
}

const OK = { featureKey: "itp_simple", key: "maxUploadMb", value: 20 };

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.OWNER_EMAILS;

  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_owner", role: "owner", email: "owner@buhl.test", passwordHash: "H", assignedJobIds: [] },
          { id: "u_admin", role: "boss", email: "boss@x.com", passwordHash: "H", assignedJobIds: [] },
          { id: "u_field", role: "electrician", email: "f@buhl.test", passwordHash: "H", assignedJobIds: [] },
          { id: "u_client", role: "client", email: "c@buhl.test", passwordHash: "H", assignedJobIds: [] },
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
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown, opts: Record<string, unknown> = {}) => {
        const guards = requireFromHere(guardsPath) as {
          applyGuards: (k: string, d: unknown, cur: unknown, o: unknown) => unknown;
        };
        const current = blob.has(key) ? clone(blob.get(key)) : null;
        blob.set(key, clone(guards.applyGuards(key, data, current, opts)));
      }),
      setNoCache: vi.fn(),
    },
  } as unknown as NodeJS.Module;

  delete requireFromHere.cache[settingsPath];
  delete requireFromHere.cache[auditPath];
  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[guardsPath];
  delete requireFromHere.cache[handlerPath];
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.OWNER_EMAILS;
});

describe("PUT /api/owner-settings — access (fails closed)", () => {
  it("401s anon, 403s field/client/non-owner-admin", async () => {
    expect((await call({ anon: true, body: OK })).statusCode).toBe(401);
    expect((await call({ role: "electrician", body: OK })).statusCode).toBe(403);
    expect((await call({ role: "client", body: OK })).statusCode).toBe(403);
    expect((await call({ role: "boss", body: OK })).statusCode).toBe(403);
  });

  it("admits the owner", async () => {
    expect((await call({ role: "owner", body: OK })).statusCode).toBe(200);
  });

  it("405s a non-PUT method; 200s OPTIONS", async () => {
    expect((await call({ method: "POST", body: OK })).statusCode).toBe(405);
    expect((await call({ method: "OPTIONS" })).statusCode).toBe(200);
  });
});

describe("PUT /api/owner-settings — validation + write", () => {
  it("404s an unknown setting", async () => {
    const res = await call({ body: { featureKey: "nope", key: "x", value: 1 } });
    expect(res.statusCode).toBe(404);
    expect((res.body as { code: string }).code).toBe("unknown_setting");
  });

  it("400s an out-of-range value with a message", async () => {
    const res = await call({ body: { featureKey: "itp_simple", key: "maxUploadMb", value: 9999 } });
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_value");
    expect((res.body as { error: string }).error).toMatch(/between 1 and 25/);
  });

  it("400s a wrong-type value", async () => {
    const res = await call({ body: { featureKey: "itp_simple", key: "maxUploadMb", value: "big" } });
    expect(res.statusCode).toBe(400);
  });

  it("happy path stores the override and echoes resolved + rev", async () => {
    const res = await call({ body: OK });
    expect(res.statusCode).toBe(200);
    const body = res.body as { resolved: number; rev: number };
    expect(body.resolved).toBe(20);
    expect(settingsDoc().settings?.itp_simple?.maxUploadMb).toBe(20);
    expect(Number.isFinite(body.rev)).toBe(true);
  });

  it("409s a stale write (CAS) and leaves the blob unchanged", async () => {
    blob.set("feature-settings.json", { settings: {}, __rev: 5 });
    const res = await call({ body: { ...OK, expectedRev: 0 } });
    expect(res.statusCode).toBe(409);
    expect((res.body as { code: string }).code).toBe("stale_write");
    expect(settingsDoc().settings?.itp_simple).toBeUndefined();
  });

  it("emits a feature_config.changed audit entry with from/to", async () => {
    await call({ body: OK });
    const entry = auditEntriesThisMonth().find((e) => e.action === "feature_config.changed");
    expect(entry).toBeTruthy();
    expect(entry?.targetType).toBe("feature_config");
    expect(entry?.targetId).toBe("itp_simple.maxUploadMb");
    expect((entry?.metadata as { to?: number })?.to).toBe(20);
  });
});
