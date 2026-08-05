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
const errorLogPath = requireFromHere.resolve("../../../api/_lib/error-log.js");
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
  delete requireFromHere.cache[errorLogPath];
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
    const previewable = body.flags.items.find((f) => f.key === "signup_link");
    expect(previewable?.protected).toBe(false);
    expect(previewable?.toggleable).toBe(true);
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

  it("includes the writable feature-settings projection (#760 PR2)", async () => {
    const res = await call({ role: "owner" });
    const body = res.body as {
      capabilities: { settingsWrite?: boolean };
      settings?: { items: Array<{ featureKey: string; key: string; value: unknown }> };
    };
    expect(body.capabilities.settingsWrite).toBe(true);
    expect(body.settings).toBeTruthy();
    // The registry is EMPTY since the job-page rebuild deleted itp_simple's
    // knobs (the last registered feature) — the seam stays, honestly empty.
    expect(body.settings?.items ?? []).toEqual([]);
  });
});

// ── GET /api/owner — errors panel (#154) ─────────────────────────────────────

describe("GET /api/owner — errors panel (#154, honest partial coverage)", () => {
  it("returns an honest empty errors panel when the journal has no entries", async () => {
    const res = await call({ role: "owner" });
    const body = res.body as {
      errors: {
        available: boolean;
        count7d: number;
        total: number;
        recent: unknown[];
        topGroups: unknown[];
        coverageNote: string;
      };
    };
    expect(body.errors).toBeTruthy();
    expect(body.errors.available).toBe(false);
    expect(body.errors.count7d).toBe(0);
    expect(body.errors.total).toBe(0);
    expect(body.errors.recent).toEqual([]);
    expect(body.errors.topGroups).toEqual([]);
    // The panel states its own partial scope — no overclaiming.
    expect(body.errors.coverageNote).toContain("Partial");
  });

  it("aggregates seeded events: 7-day count, fingerprint groups, recent w/o stack", async () => {
    const now = Date.now();
    const mk = (over: Record<string, unknown>) => ({
      id: `err_${Math.random().toString(36).slice(2, 10)}`,
      ts: new Date(now - 3600_000).toISOString(),
      source: "api",
      handler: "jobs",
      message: "boom",
      severity: "error",
      statusCode: 500,
      stack: "Error: boom",
      userId: null,
      jobId: null,
      fingerprint: "aaaaaaaaaaaa",
      ...over,
    });
    blob.set("platform/errors.json", {
      entries: [
        mk({}),
        mk({}),
        mk({ handler: "data", message: "bang", fingerprint: "bbbbbbbbbbbb" }),
        // Older than 7 days — counted in total but not count7d.
        mk({ ts: new Date(now - 10 * 86400_000).toISOString(), fingerprint: "cccccccccccc" }),
      ],
    });
    const res = await call({ role: "owner" });
    const body = res.body as {
      errors: {
        available: boolean;
        count7d: number;
        total: number;
        recent: Array<Record<string, unknown>>;
        topGroups: Array<{ fingerprint: string; count: number; handler: string }>;
      };
    };
    expect(body.errors.available).toBe(true);
    expect(body.errors.total).toBe(4);
    expect(body.errors.count7d).toBe(3);
    const top = body.errors.topGroups[0]!;
    expect(top.fingerprint).toBe("aaaaaaaaaaaa");
    expect(top.count).toBe(2);
    expect(top.handler).toBe("jobs");
    // No payloads in the projection (same discipline as the audit panel).
    expect(body.errors.recent[0]).not.toHaveProperty("stack");
    expect(body.errors.recent[0]).not.toHaveProperty("metadata");
  });

  it("marks ONLY wrapped-handler areas errorsTracked in the coverage matrix", async () => {
    const res = await call({ role: "owner" });
    const body = res.body as {
      coverage: { rows: Array<{ area: string; errorsTracked: boolean }> };
      problems: Array<{ title: string }>;
      nextActions: Array<{ title: string }>;
    };
    const tracked = body.coverage.rows.filter((r) => r.errorsTracked).map((r) => r.area);
    expect(tracked.sort()).toEqual(
      ["Hours", "Jobs", "Phil — Hours"].sort(),
    );
    // Command centre has no wrapped handler — stays honest-false.
    const cc = body.coverage.rows.find((r) => r.area === "Command centre");
    expect(cc?.errorsTracked).toBe(false);
    // The old "no telemetry" problem is replaced by an honest PARTIAL note.
    expect(body.problems.some((p) => p.title === "No error / failed-action telemetry")).toBe(false);
    expect(body.problems.some((p) => p.title.includes("partial"))).toBe(true);
    expect(
      body.nextActions.some((a) => a.title.includes("Extend error capture")),
    ).toBe(true);
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

const OK = { key: "signup_link", scope: "customer", value: true };

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
    const res = await callWrite({ body: { key: "signup_link", scope: "nope", value: true } });
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe("bad_scope");
  });

  it("400s a non-boolean / non-null value", async () => {
    const res = await callWrite({ body: { key: "signup_link", scope: "customer", value: "yes" } });
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
    const res = await callWrite({ body: { key: "signup_link", scope: "customer", value: true } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { resolved: { customer: boolean; owner: boolean }; rev: number };
    expect(body.resolved.customer).toBe(true);
    expect(flagsDoc().flags?.signup_link).toBe(true);
    expect(Number.isFinite(body.rev)).toBe(true);
  });

  it("owner-preview write sets the override without changing the customer baseline", async () => {
    const res = await callWrite({ body: { key: "signup_link", scope: "ownerPreview", value: true } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { resolved: { customer: boolean; owner: boolean } };
    expect(body.resolved.owner).toBe(true);
    expect(body.resolved.customer).toBe(false); // customers still don't see it
    expect(flagsDoc().ownerPreview?.signup_link).toBe(true);
    expect(flagsDoc().flags?.signup_link).toBeUndefined();
  });

  it("value:null clears an override", async () => {
    await callWrite({ body: { key: "signup_link", scope: "ownerPreview", value: true } });
    expect(flagsDoc().ownerPreview?.signup_link).toBe(true);
    const res = await callWrite({ body: { key: "signup_link", scope: "ownerPreview", value: null } });
    expect(res.statusCode).toBe(200);
    expect(flagsDoc().ownerPreview?.signup_link).toBeUndefined();
  });

  it("409s a stale write (CAS) and leaves the blob unchanged", async () => {
    blob.set("flags.json", { flags: {}, __rev: 5 });
    const res = await callWrite({
      body: { key: "signup_link", scope: "customer", value: true, expectedRev: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect((res.body as { code: string }).code).toBe("stale_write");
    expect(flagsDoc().flags?.signup_link).toBeUndefined();
  });
});

describe("POST /api/owner-flags — staged rollout (#760 easy control)", () => {
  it("rollout:live sets customer on and clears the owner-preview override (one write)", async () => {
    // Start from a preview state, then release to everyone.
    await callWrite({ body: { key: "signup_link", scope: "ownerPreview", value: true } });
    const res = await callWrite({ body: { key: "signup_link", rollout: "live" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { rollout: string; resolved: { customer: boolean; owner: boolean } };
    expect(body.rollout).toBe("live");
    expect(body.resolved.customer).toBe(true);
    expect(body.resolved.owner).toBe(true);
    expect(flagsDoc().flags?.signup_link).toBe(true);
    expect(flagsDoc().ownerPreview?.signup_link).toBeUndefined(); // cleared
  });

  it("rollout:preview hides from customers but keeps it visible to the owner", async () => {
    const res = await callWrite({ body: { key: "signup_link", rollout: "preview" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { resolved: { customer: boolean; owner: boolean } };
    expect(body.resolved.customer).toBe(false);
    expect(body.resolved.owner).toBe(true);
    expect(flagsDoc().flags?.signup_link).toBe(false);
    expect(flagsDoc().ownerPreview?.signup_link).toBe(true);
  });

  it("rollout:off darkens the feature for everyone (both dials off)", async () => {
    await callWrite({ body: { key: "signup_link", rollout: "live" } });
    const res = await callWrite({ body: { key: "signup_link", rollout: "off" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { resolved: { customer: boolean; owner: boolean } };
    expect(body.resolved.customer).toBe(false);
    expect(body.resolved.owner).toBe(false);
    expect(flagsDoc().flags?.signup_link).toBe(false);
    expect(flagsDoc().ownerPreview?.signup_link).toBe(false);
  });

  it("400s an unknown rollout state", async () => {
    const res = await callWrite({ body: { key: "signup_link", rollout: "sideways" } });
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe("bad_rollout");
  });

  it("409s a protected flag even via rollout (data-plane stays ops-only)", async () => {
    const res = await callWrite({ body: { key: "supabase_dual_write", rollout: "live" } });
    expect(res.statusCode).toBe(409);
  });

  it("records the rollout state in the audit metadata", async () => {
    await callWrite({ body: { key: "signup_link", rollout: "preview", reason: "testing first" } });
    const entry = auditEntriesThisMonth().find((e) => e.action === "feature_flag.toggled");
    expect((entry?.metadata as { rollout?: string })?.rollout).toBe("preview");
    expect((entry?.metadata as { reason?: string })?.reason).toBe("testing first");
  });
});

describe("POST /api/owner-flags — audit", () => {
  it("emits a feature_flag.toggled entry on a successful toggle", async () => {
    await callWrite({ body: { key: "signup_link", scope: "customer", value: true } });
    const entry = auditEntriesThisMonth().find((e) => e.action === "feature_flag.toggled");
    expect(entry).toBeTruthy();
    expect(entry?.targetType).toBe("feature_flag");
    expect(entry?.targetId).toBe("signup_link");
    expect((entry?.metadata as { scope?: string })?.scope).toBe("customer");
  });

  it("threads the board's optional reason into the audit metadata (#760 board)", async () => {
    await callWrite({
      body: { key: "signup_link", scope: "customer", value: false, reason: "not ready for launch" },
    });
    const entry = auditEntriesThisMonth().find((e) => e.action === "feature_flag.toggled");
    expect((entry?.metadata as { reason?: string })?.reason).toBe("not ready for launch");
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
    const res = await callWrite({ body: { key: "signup_link", scope: "customer", value: true } });
    expect(res.statusCode).toBe(200);
    expect(flagsDoc().flags?.signup_link).toBe(true);
  });
});
