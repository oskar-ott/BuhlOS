import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API contract: /api/licences (#331) — the worker licence/ticket register.
 *
 * The promises pinned here:
 *   - self view is session-identity ONLY (?mine=1) — a field worker can never
 *     read a colleague's records (no userId param on the self path; the
 *     admin-only ?userId= path 403s field callers);
 *   - writes are office-tier; field write attempts 403, clients 403 outright,
 *     anonymous 401;
 *   - dates are validated at WRITE (strict ISO, real dates) — this store
 *     never inherits the tags register's silent read-time NaN-drops;
 *   - every response row carries server-computed { status, daysToExpiry };
 *     the admin list adds renewal-aware worstByUser for register chips;
 *   - admin mutations land in the audit log (credential.added/updated/removed).
 */

const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const enginePath = requireFromHere.resolve("../../../api/_lib/licence-compliance.js");
const handlerPath = requireFromHere.resolve("../../../api/licences.js");

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function user(id: string, role: string, extra = {}) {
  return { id, username: id, role, assignedJobIds: [], ...extra };
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

async function call(
  viewer: { id: string; role: string } | null,
  opts: {
    method?: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {}
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: opts.method ?? "GET",
      query: opts.query ?? {},
      body: opts.body,
      headers: viewer ? { cookie: cookieFor(viewer.id, viewer.role) } : {},
    },
    res
  );
  return res;
}

const ADMIN = { id: "u_admin", role: "admin" };
const ELEC = { id: "u_elec", role: "electrician" };
const TRADIE = { id: "u_tradie", role: "tradie" };
const CLIENT = { id: "u_client", role: "client" };

function credentialOf(res: Res): Record<string, unknown> {
  return (res.body as { credential: Record<string, unknown> }).credential;
}

function stored(): Array<Record<string, unknown>> {
  return (
    (blob.get("workforce/credentials.json") as { credentials: Array<Record<string, unknown>> })
      ?.credentials ?? []
  );
}

/** ISO date `days` from today (local). */
function iso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          user("u_admin", "admin"),
          user("u_elec", "electrician"),
          user("u_tradie", "tradie"),
          user("u_client", "client"),
        ],
      },
    ],
  ]);

  for (const p of [blobSdkPath, blobPath, authPath, auditPath, enginePath, handlerPath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: { list: vi.fn(async () => ({ blobs: [] })), put: vi.fn(), del: vi.fn() },
  } as NodeJS.Module;
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gates", () => {
  it("401s anonymous callers", async () => {
    const res = await call(null, {});
    expect(res.statusCode).toBe(401);
  });

  it("403s clients entirely", async () => {
    const res = await call(CLIENT, { query: { mine: "1" } });
    expect(res.statusCode).toBe(403);
  });

  it("field workers cannot read the register or another worker's records", async () => {
    const all = await call(ELEC, {});
    expect(all.statusCode).toBe(403);
    const cross = await call(ELEC, { query: { userId: "u_tradie" } });
    expect(cross.statusCode).toBe(403);
  });

  it("field workers cannot write (office maintains the register, v1)", async () => {
    const res = await call(ELEC, {
      method: "POST",
      body: { userId: "u_elec", typeId: "electrical" },
    });
    expect(res.statusCode).toBe(403);
    expect(stored()).toHaveLength(0);
  });
});

describe("POST — add a record (admin)", () => {
  it("creates with computed status and the canonical frozen label", async () => {
    const res = await call(ADMIN, {
      method: "POST",
      body: {
        userId: "u_elec",
        typeId: "electrical",
        number: "QLD-12345",
        expiryDate: iso(30),
      },
    });
    expect(res.statusCode).toBe(201);
    const c = credentialOf(res);
    expect(c).toMatchObject({
      kind: "licence",
      userId: "u_elec",
      typeId: "electrical",
      label: "Electrical licence",
      number: "QLD-12345",
      status: "expiring",
      daysToExpiry: 30,
    });
    expect(stored()).toHaveLength(1);
  });

  it("no expiry is a real state — status no-expiry", async () => {
    const res = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "white-card", expiryDate: null },
    });
    expect(res.statusCode).toBe(201);
    expect(credentialOf(res)).toMatchObject({ status: "no-expiry", daysToExpiry: null });
  });

  it("validates at write: unknown type, fake dates, dd/mm/yyyy all 400", async () => {
    const badType = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "scuba" },
    });
    expect(badType.statusCode).toBe(400);
    const badDate = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "ewp", expiryDate: "31/12/2026" },
    });
    expect(badDate.statusCode).toBe(400);
    const impossible = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "ewp", expiryDate: "2026-02-31" },
    });
    expect(impossible.statusCode).toBe(400);
    expect(stored()).toHaveLength(0);
  });

  it("type 'other' requires a label; known types ignore caller labels", async () => {
    const missing = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "other" },
    });
    expect(missing.statusCode).toBe(400);
    const named = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "other", label: "Confined spaces" },
    });
    expect(named.statusCode).toBe(201);
    expect(credentialOf(named).label).toBe("Confined spaces");
    const spoofed = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "ewp", label: "Fake label" },
    });
    expect(credentialOf(spoofed).label).toBe("EWP");
  });

  it("404s unknown workers, 400s client targets", async () => {
    const ghost = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_ghost", typeId: "ewp" },
    });
    expect(ghost.statusCode).toBe(404);
    const client = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_client", typeId: "ewp" },
    });
    expect(client.statusCode).toBe(400);
  });

  it("admin mutations land in the audit log", async () => {
    await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "first-aid", number: "FA-999" },
    });
    const auditKeys = [...blob.keys()].filter((k) => k.startsWith("audit/"));
    expect(auditKeys).toHaveLength(1);
    const entries = (blob.get(auditKeys[0]!) as { entries: Array<Record<string, unknown>> })
      .entries;
    expect(entries[0]).toMatchObject({
      action: "credential.added",
      targetType: "credential",
      actorId: "u_admin",
    });
    // PII discipline: the licence number never reaches the audit summary.
    expect(String(entries[0]!.summary)).not.toContain("FA-999");
  });
});

describe("PUT / DELETE (admin)", () => {
  async function seedOne(): Promise<string> {
    const res = await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "ewp", expiryDate: iso(10) },
    });
    return String(credentialOf(res).id);
  }

  it("PUT updates fields with the same validation", async () => {
    const id = await seedOne();
    const bad = await call(ADMIN, {
      method: "PUT",
      body: { id, expiryDate: "not-a-date" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await call(ADMIN, {
      method: "PUT",
      body: { id, expiryDate: iso(400), number: "EWP-1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(credentialOf(ok)).toMatchObject({ status: "current", number: "EWP-1" });
    const missing = await call(ADMIN, { method: "PUT", body: { id: "cred_nope" } });
    expect(missing.statusCode).toBe(404);
  });

  it("DELETE removes the record", async () => {
    const id = await seedOne();
    const res = await call(ADMIN, { method: "DELETE", query: { id } });
    expect(res.statusCode).toBe(200);
    expect(stored()).toHaveLength(0);
    const again = await call(ADMIN, { method: "DELETE", query: { id } });
    expect(again.statusCode).toBe(404);
  });
});

describe("GET scoping + computed views", () => {
  beforeEach(async () => {
    await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "electrical", expiryDate: iso(-5) },
    });
    await call(ADMIN, {
      method: "POST",
      body: { userId: "u_elec", typeId: "electrical", expiryDate: iso(300) },
    });
    await call(ADMIN, {
      method: "POST",
      body: { userId: "u_tradie", typeId: "white-card", expiryDate: iso(30) },
    });
  });

  it("?mine=1 returns only the caller's records (with statuses + type list)", async () => {
    const res = await call(ELEC, { query: { mine: "1" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      credentials: Array<{ userId: string; status: string }>;
      types: unknown[];
      withinDays: number;
    };
    expect(body.credentials).toHaveLength(2);
    expect(body.credentials.every((c) => c.userId === "u_elec")).toBe(true);
    expect(body.types.length).toBeGreaterThan(0);
    expect(body.withinDays).toBe(60);
  });

  it("admin list returns everything + renewal-aware worstByUser", async () => {
    const res = await call(ADMIN, {});
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      credentials: unknown[];
      worstByUser: Record<string, string>;
    };
    expect(body.credentials).toHaveLength(3);
    // u_elec's expired electrical is superseded by the renewal → ok.
    expect(body.worstByUser).toEqual({ u_elec: "ok", u_tradie: "expiring" });
  });

  it("admin ?userId= filters to one worker", async () => {
    const res = await call(ADMIN, { query: { userId: "u_tradie" } });
    const body = res.body as { credentials: Array<{ userId: string }> };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]!.userId).toBe("u_tradie");
  });
});
