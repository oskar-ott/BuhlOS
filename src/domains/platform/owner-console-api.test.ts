import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/owner — the Owner Console data endpoint (docs/owner-console.md) and
 * the AUTHORITATIVE owner-only access boundary. Real signed session + real auth
 * + real feature-flag / audit modules; only Blob is injected (no network).
 *
 * Pins the security contract: fails closed for anon (401), field/client (403),
 * and a normal admin who is NOT an owner (403); admits the stored 'owner' role
 * and the OWNER_EMAILS allowlist; never leaks secrets; flags are read-only.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const guardsPath = requireFromHere.resolve("../../../api/_lib/blob-guards.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const flagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const handlerPath = requireFromHere.resolve("../../../api/owner.js");
const ownerFlagsPath = requireFromHere.resolve("../../../api/owner-flags.js");

type Handler = (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: Handler;
let flagsHandler: Handler;
let blob: Map<string, unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

const ROLE_USER: Record<string, string> = {
  owner: "u_owner",
  boss: "u_admin",
  emailowner: "u_emailowner",
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
  const role = opts.role || "owner";
  const userId = opts.userId || ROLE_USER[role] || "u_owner";
  const req = {
    method: opts.method || "GET",
    query: {},
    headers: opts.anon ? {} : { cookie: cookieFor(userId, role) },
  };
  await handler(req, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.OWNER_EMAILS;

  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_owner", role: "owner", email: "owner@buhl.test", passwordHash: "HASH", assignedJobIds: [] },
          { id: "u_admin", role: "boss", email: "boss@elsewhere.com", passwordHash: "HASH", assignedJobIds: [] },
          { id: "u_emailowner", role: "admin", email: "oskaott@gmail.com", passwordHash: "HASH", assignedJobIds: [] },
          { id: "u_field", role: "electrician", email: "field@buhl.test", passwordHash: "HASH", assignedJobIds: [] },
          { id: "u_client", role: "client", email: "client@buhl.test", passwordHash: "HASH", assignedJobIds: [] },
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
      // Faithful write: run the REAL guards (shape validation + CAS + __rev
      // stamping) against the in-memory store, so the write route's protected /
      // unknown / stale paths are exercised end-to-end.
      writeBlob: vi.fn(async (key: string, data: unknown, opts: Record<string, unknown> = {}) => {
        const guards = requireFromHere(guardsPath) as {
          applyGuards: (k: string, d: unknown, cur: unknown, o: unknown) => unknown;
        };
        const current = blob.has(key) ? clone(blob.get(key)) : null;
        const stamped = guards.applyGuards(key, data, current, opts);
        blob.set(key, clone(stamped));
      }),
      setNoCache: vi.fn(),
    },
  } as unknown as NodeJS.Module;

  delete requireFromHere.cache[flagsPath];
  delete requireFromHere.cache[auditPath];
  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[guardsPath];
  delete requireFromHere.cache[handlerPath];
  delete requireFromHere.cache[ownerFlagsPath];
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
  flagsHandler = requireFromHere(ownerFlagsPath);
});

afterEach(() => {
  delete process.env.OWNER_EMAILS;
});

describe("GET /api/owner — access (fails closed)", () => {
  it("401s an unauthenticated request", async () => {
    const res = await call({ anon: true });
    expect(res.statusCode).toBe(401);
  });

  it("403s a field worker", async () => {
    const res = await call({ role: "electrician" });
    expect(res.statusCode).toBe(403);
  });

  it("403s a client", async () => {
    const res = await call({ role: "client" });
    expect(res.statusCode).toBe(403);
  });

  it("403s a NORMAL admin who is not an owner (the headline narrowing)", async () => {
    const res = await call({ role: "boss" });
    expect(res.statusCode).toBe(403);
    expect((res.body as Record<string, unknown>).ok).toBe(false);
  });

  it("admits the stored 'owner' role (200, identityBasis owner-role)", async () => {
    const res = await call({ role: "owner" });
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; meta: { identityBasis: string } };
    expect(body.ok).toBe(true);
    expect(body.meta.identityBasis).toBe("owner-role");
  });

  it("admits an OWNER_EMAILS-allowlisted admin (200, identityBasis email-allowlist)", async () => {
    const res = await call({ role: "admin", userId: "u_emailowner" });
    expect(res.statusCode).toBe(200);
    const body = res.body as { meta: { identityBasis: string } };
    expect(body.meta.identityBasis).toBe("email-allowlist");
  });

  it("405s a non-GET method", async () => {
    const res = await call({ method: "POST", role: "owner" });
    expect(res.statusCode).toBe(405);
  });
});

describe("GET /api/owner — payload (real, honest, no secrets, read-only)", () => {
  it("returns every section with real flag data and toggleable, protected-fenced flags", async () => {
    const res = await call({ role: "owner" });
    const body = res.body as {
      health: unknown;
      capabilities: { flagToggle: boolean };
      flags: { items: Array<{ key: string; toggleable: boolean; protected: boolean }> };
      coverage: { rows: Array<{ area: string; auditTracked: boolean }> };
      usage: { notInstrumented: string[] };
      problems: Array<{ severity: string }>;
    };
    expect(body.health).toBeTruthy();
    expect(Array.isArray(body.flags.items)).toBe(true);
    expect(body.flags.items.length).toBeGreaterThan(0);
    // Flags now toggle via POST /api/owner-flags: capability on, feature flags
    // toggleable, protected data-plane flags fenced read-only.
    expect(body.capabilities.flagToggle).toBe(true);
    expect(body.flags.items.some((f) => f.toggleable)).toBe(true);
    const supa = body.flags.items.find((f) => f.key === "supabase_dual_write");
    expect(supa?.protected).toBe(true);
    expect(supa?.toggleable).toBe(false);
    const safety = body.flags.items.find((f) => f.key === "safety_docs");
    expect(safety?.protected).toBe(false);
    expect(safety?.toggleable).toBe(true);
    // Coverage auditTracked is DERIVED from the real audit registry, so Hours
    // (which has hours.* actions) is tracked.
    const hours = body.coverage.rows.find((r) => r.area === "Hours");
    expect(hours?.auditTracked).toBe(true);
    // Honest instrumentation gaps are surfaced, not hidden.
    expect(body.usage.notInstrumented.length).toBeGreaterThan(0);
    expect(body.problems.some((p) => p.severity === "not_instrumented")).toBe(true);
  });

  it("never leaks secrets (no password hash, no raw SESSION_SECRET, email masked)", async () => {
    process.env.OWNER_EMAILS = "owner@buhl.test";
    const res = await call({ role: "owner" });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("HASH");
    expect(json).not.toContain("passwordHash");
    expect(json).not.toContain("test-session-secret-long-enough");
    // The viewer's own email is masked, never returned in full.
    expect(json).not.toContain("owner@buhl.test");
    const body = res.body as { meta: { viewer: { email: string | null } } };
    expect(body.meta.viewer.email).toMatch(/\*/);
  });
});

// ── POST /api/owner-flags — the runtime toggle write path (#760) ─────────────

async function callWrite(opts: {
  role?: string;
  userId?: string;
  anon?: boolean;
  method?: string;
  body?: Record<string, unknown>;
}) {
  const res = createRes();
  const role = opts.role || "owner";
  const userId = opts.userId || ROLE_USER[role] || "u_owner";
  const req = {
    method: opts.method || "POST",
    query: {},
    headers: opts.anon ? {} : { cookie: cookieFor(userId, role) },
    body: opts.body || {},
  };
  await flagsHandler(req, res);
  return res;
}

function flagsDoc() {
  return (blob.get("flags.json") as { flags?: Record<string, unknown>; ownerPreview?: Record<string, unknown> } | undefined) || {};
}

function auditEntriesThisMonth(): Array<Record<string, unknown>> {
  const ym = new Date().toISOString().slice(0, 7);
  const doc = blob.get(`audit/${ym}.json`) as { entries?: Array<Record<string, unknown>> } | undefined;
  return doc?.entries ?? [];
}

const OK = { key: "safety_docs", scope: "customer", value: true };

describe("POST /api/owner-flags — access (fails closed, same boundary as GET)", () => {
  it("401s anon, 403s field/client/non-owner-admin", async () => {
    expect((await callWrite({ anon: true, body: OK })).statusCode).toBe(401);
    expect((await callWrite({ role: "electrician", body: OK })).statusCode).toBe(403);
    expect((await callWrite({ role: "client", body: OK })).statusCode).toBe(403);
    expect((await callWrite({ role: "boss", body: OK })).statusCode).toBe(403);
  });

  it("admits the owner role and the email-allowlist owner", async () => {
    expect((await callWrite({ role: "owner", body: OK })).statusCode).toBe(200);
    expect(
      (await callWrite({ role: "admin", userId: "u_emailowner", body: OK })).statusCode,
    ).toBe(200);
  });

  it("405s a non-POST method", async () => {
    expect((await callWrite({ method: "PUT", body: OK })).statusCode).toBe(405);
  });

  it("200s an OPTIONS preflight", async () => {
    expect((await callWrite({ method: "OPTIONS" })).statusCode).toBe(200);
  });
});

describe("POST /api/owner-flags — validation (fails closed)", () => {
  it("400s an unknown flag key", async () => {
    const res = await callWrite({ body: { key: "not_a_flag", scope: "customer", value: true } });
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe("unknown_flag");
  });

  it("400s a bad scope", async () => {
    const res = await callWrite({ body: { key: "safety_docs", scope: "nope", value: true } });
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe("bad_scope");
  });

  it("400s a non-boolean / non-null value", async () => {
    const res = await callWrite({ body: { key: "safety_docs", scope: "customer", value: "yes" } });
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe("bad_value");
  });

  it("409s a protected data-plane flag and leaves the blob untouched (both scopes)", async () => {
    for (const scope of ["customer", "ownerPreview"]) {
      const res = await callWrite({ body: { key: "supabase_dual_write", scope, value: true } });
      expect(res.statusCode).toBe(409);
      expect((res.body as { code: string }).code).toBe("protected");
    }
    expect(blob.has("flags.json")).toBe(false); // nothing was written
  });
});

describe("POST /api/owner-flags — write semantics", () => {
  it("customer toggle pins the launch gate and echoes resolved + rev", async () => {
    const res = await callWrite({ body: { key: "safety_docs", scope: "customer", value: true } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { resolved: { customer: boolean; owner: boolean }; rev: number };
    expect(body.resolved.customer).toBe(true);
    expect(flagsDoc().flags?.safety_docs).toBe(true);
    expect(Number.isFinite(body.rev)).toBe(true);
  });

  it("owner-preview write sets the override without changing the customer baseline", async () => {
    const res = await callWrite({ body: { key: "safety_docs", scope: "ownerPreview", value: true } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { resolved: { customer: boolean; owner: boolean } };
    expect(body.resolved.owner).toBe(true);
    expect(body.resolved.customer).toBe(false); // customers still don't see it
    expect(flagsDoc().ownerPreview?.safety_docs).toBe(true);
    expect(flagsDoc().flags?.safety_docs).toBeUndefined();
  });

  it("value:null clears an override", async () => {
    await callWrite({ body: { key: "safety_docs", scope: "ownerPreview", value: true } });
    expect(flagsDoc().ownerPreview?.safety_docs).toBe(true);
    const res = await callWrite({ body: { key: "safety_docs", scope: "ownerPreview", value: null } });
    expect(res.statusCode).toBe(200);
    expect(flagsDoc().ownerPreview?.safety_docs).toBeUndefined();
  });

  it("409s a stale write (CAS) and leaves the blob unchanged", async () => {
    blob.set("flags.json", { flags: {}, __rev: 5 });
    const res = await callWrite({
      body: { key: "safety_docs", scope: "customer", value: true, expectedRev: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect((res.body as { code: string }).code).toBe("stale_write");
    expect(flagsDoc().flags?.safety_docs).toBeUndefined();
  });
});

describe("POST /api/owner-flags — audit", () => {
  it("emits a feature_flag.toggled entry on a successful toggle", async () => {
    await callWrite({ body: { key: "safety_docs", scope: "customer", value: true } });
    const entry = auditEntriesThisMonth().find((e) => e.action === "feature_flag.toggled");
    expect(entry).toBeTruthy();
    expect(entry?.targetType).toBe("feature_flag");
    expect(entry?.targetId).toBe("safety_docs");
    expect((entry?.metadata as { scope?: string })?.scope).toBe("customer");
  });

  it("a failing audit write never fails the toggle (best-effort)", async () => {
    const blobMod = requireFromHere.cache[blobPath]!.exports as {
      writeBlob: (k: string, d: unknown, o?: unknown) => Promise<void>;
    };
    const realWrite = blobMod.writeBlob;
    blobMod.writeBlob = vi.fn(async (key: string, data: unknown, opts?: unknown) => {
      if (String(key).startsWith("audit/")) throw new Error("audit down");
      return realWrite(key, data, opts);
    });
    const res = await callWrite({ body: { key: "safety_docs", scope: "customer", value: true } });
    expect(res.statusCode).toBe(200);
    expect(flagsDoc().flags?.safety_docs).toBe(true);
  });
});
