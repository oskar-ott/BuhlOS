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
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const flagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const handlerPath = requireFromHere.resolve("../../../api/owner.js");

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
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
      setNoCache: vi.fn(),
    },
  } as unknown as NodeJS.Module;

  delete requireFromHere.cache[flagsPath];
  delete requireFromHere.cache[auditPath];
  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[handlerPath];
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
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
  it("returns every section with real flag data and read-only flags", async () => {
    const res = await call({ role: "owner" });
    const body = res.body as {
      health: unknown;
      capabilities: { flagToggle: boolean };
      flags: { items: Array<{ toggleable: boolean }> };
      coverage: { rows: Array<{ area: string; auditTracked: boolean }> };
      usage: { notInstrumented: string[] };
      problems: Array<{ severity: string }>;
    };
    expect(body.health).toBeTruthy();
    expect(Array.isArray(body.flags.items)).toBe(true);
    expect(body.flags.items.length).toBeGreaterThan(0);
    // Read-only this slice: no flag is toggleable and the capability is off.
    expect(body.capabilities.flagToggle).toBe(false);
    expect(body.flags.items.every((f) => f.toggleable === false)).toBe(true);
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
