import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #760 — env-only owner login. A synthetic super-admin (id `__owner__`) that
 * authenticates against ENV credentials with NO users.json row, so it leaves no
 * trace in the admin Employees view. Real auth + HMAC + bcrypt + the real
 * login/users handlers; only Blob is injected.
 *
 * Pins the security contract: fail-closed when unconfigured, a FORGED sentinel
 * cookie is rejected (the auth-bypass guard), the owner never appears in the
 * roster, and the id/username are reserved against real users.
 */

const requireFromHere = createRequire(import.meta.url);
// bcryptjs has no @types in this repo; require it the same way api/auth.js does
// (createRequire returns `any`, so no missing-declaration error).
const bcrypt = requireFromHere("bcryptjs") as { hash: (s: string, cost: number) => Promise<string> };
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const guardsPath = requireFromHere.resolve("../../../api/_lib/blob-guards.js");
const loginPath = requireFromHere.resolve("../../../api/auth.js");
const usersPath = requireFromHere.resolve("../../../api/users.js");

const OWNER_PW = "correct-horse-battery-staple";
let OWNER_HASH: string;

type Res = ReturnType<typeof createRes>;
type AuthMod = {
  signSession: (p: Record<string, unknown>) => string;
  getCurrentUser: (req: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  canAccessOwnerConsole: (u: unknown) => boolean;
  requireAuth: (req: Record<string, unknown>, res: Res, opts?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  syntheticOwner: () => Record<string, unknown>;
  OWNER_SENTINEL: string;
};

let blob: Map<string, unknown>;
let auth: AuthMod;
let loginHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let usersHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    end() {
      return this;
    },
  };
}

beforeAll(async () => {
  OWNER_HASH = await bcrypt.hash(OWNER_PW, 6); // low cost = fast test
});

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.OWNER_LOGIN_USERNAME = "owner";
  process.env.OWNER_PASSWORD_HASH = OWNER_HASH;
  delete process.env.OWNER_EMAILS; // default → oskaott@gmail.com

  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "boss", email: "boss@x.com", passwordHash: "H", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", email: "f@x.com", passwordHash: "H", assignedJobIds: ["job-x"] },
        ],
      },
    ],
  ]);

  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown, opts: Record<string, unknown> = {}) => {
        const guards = requireFromHere(guardsPath) as {
          applyGuards: (k: string, d: unknown, c: unknown, o: unknown) => unknown;
        };
        const current = blob.has(key) ? clone(blob.get(key)) : null;
        blob.set(key, clone(guards.applyGuards(key, data, current, opts)));
      }),
      setNoCache: vi.fn(),
    },
  } as unknown as NodeJS.Module;

  for (const p of [authPath, guardsPath, loginPath, usersPath]) delete requireFromHere.cache[p];
  auth = requireFromHere(authPath);
  loginHandler = requireFromHere(loginPath);
  usersHandler = requireFromHere(usersPath);
});

afterEach(() => {
  delete process.env.OWNER_LOGIN_USERNAME;
  delete process.env.OWNER_PASSWORD_HASH;
});

function ownerCookie(): string {
  return `buhl_session=${auth.signSession({ userId: auth.OWNER_SENTINEL, role: "owner", exp: Date.now() + 60_000 })}`;
}

async function login(username: string, secret: string): Promise<Res> {
  const res = createRes();
  await loginHandler({ method: "POST", query: { action: "login" }, body: { username, secret }, headers: {} }, res);
  return res;
}

describe("env-owner login (#760)", () => {
  it("correct secret → 200, and the issued cookie resolves to the synthetic owner", async () => {
    const res = await login("owner", OWNER_PW);
    expect(res.statusCode).toBe(200);
    expect((res.body as { user: { id: string; role: string } }).user.id).toBe("__owner__");
    expect((res.body as { user: { role: string } }).user.role).toBe("owner");
    const token = /buhl_session=([^;]+)/.exec(res.headers["Set-Cookie"] || "")?.[1];
    const me = await auth.getCurrentUser({ headers: { cookie: `buhl_session=${token}` } });
    expect(me?.id).toBe("__owner__");
  });

  it("wrong secret → 401", async () => {
    expect((await login("owner", "nope")).statusCode).toBe(401);
  });

  it("FAIL CLOSED: with OWNER_PASSWORD_HASH unset there is no owner login (→ 401, no cookie)", async () => {
    delete process.env.OWNER_PASSWORD_HASH;
    const res = await login("owner", OWNER_PW);
    expect(res.statusCode).toBe(401);
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  it("throttles repeated wrong secrets (429 even on a later correct attempt)", async () => {
    for (let i = 0; i < 5; i++) await login("owner", "nope");
    expect((await login("owner", OWNER_PW)).statusCode).toBe(429);
  });
});

describe("session integrity / getCurrentUser", () => {
  it("a validly-signed sentinel session resolves to the synthetic owner with NO users.json row", async () => {
    blob.delete("users.json"); // prove the owner needs no stored row
    const me = await auth.getCurrentUser({ headers: { cookie: ownerCookie() } });
    expect(me).toMatchObject({ id: "__owner__", role: "owner" });
    expect(me?.email).toBe("oskaott@gmail.com"); // OWNER_EMAILS default
    expect(me).not.toHaveProperty("passwordHash");
  });

  it("AUTH-BYPASS GUARD: a forged/tampered sentinel cookie is rejected (null)", async () => {
    const body = Buffer.from(
      JSON.stringify({ userId: "__owner__", role: "owner", exp: Date.now() + 60_000 }),
    ).toString("base64url");
    const forged = `buhl_session=${body}.not-a-valid-hmac`;
    expect(await auth.getCurrentUser({ headers: { cookie: forged } })).toBeNull();
  });

  it("the synthetic owner passes the owner-console gate", () => {
    expect(auth.canAccessOwnerConsole(auth.syntheticOwner())).toBe(true);
  });

  it("requireAuth admits the owner as admin-tier, including job-scoped", async () => {
    const res = createRes();
    const u = await auth.requireAuth({ headers: { cookie: ownerCookie() } }, res, {
      roles: ["admin"],
      jobId: "job-x",
    });
    expect(u?.id).toBe("__owner__");
    expect(res.statusCode).toBe(200);
  });
});

describe("reservation + no trace", () => {
  it("employee-create with the reserved owner username → 400", async () => {
    const res = createRes();
    await usersHandler(
      {
        method: "POST",
        query: {},
        body: { username: "owner", role: "admin", secret: "password1" },
        headers: { cookie: ownerCookie() },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/reserved/);
  });

  it("the users.json write-guard rejects a stored row claiming the reserved id", () => {
    const guards = requireFromHere(guardsPath) as {
      applyGuards: (k: string, d: unknown, c: unknown, o: unknown) => unknown;
    };
    expect(() =>
      guards.applyGuards(
        "users.json",
        { users: [{ id: "__owner__", username: "x", role: "admin" }] },
        { users: [] },
        {},
      ),
    ).toThrow(/reserved owner id/);
  });

  it("the owner leaves NO trace in the employees list (it has no row)", async () => {
    const res = createRes();
    await usersHandler({ method: "GET", query: {}, headers: { cookie: ownerCookie() } }, res);
    expect(res.statusCode).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("__owner__");
    expect(json).toContain("sparky"); // the real roster did come back
  });
});

async function changePw(cookie: string, currentSecret: string, newSecret: string): Promise<Res> {
  const res = createRes();
  await loginHandler(
    { method: "POST", query: { action: "change-password" }, body: { currentSecret, newSecret }, headers: { cookie } },
    res,
  );
  return res;
}

describe("owner change-password (console-rotatable, blob-backed)", () => {
  const NEW_PW = "new-owner-pw-2026";

  it("correct current → 200, writes the blob; the NEW password logs in and the old (env) one stops working", async () => {
    const res = await changePw(ownerCookie(), OWNER_PW, NEW_PW);
    expect(res.statusCode).toBe(200);
    expect((blob.get("owner-auth.json") as { passwordHash: string }).passwordHash).toBeTruthy();

    // blob hash now wins over the env bootstrap
    expect((await login("owner", NEW_PW)).statusCode).toBe(200);
    expect((await login("owner", OWNER_PW)).statusCode).toBe(401);
  });

  it("wrong current password → 401 (no write)", async () => {
    const res = await changePw(ownerCookie(), "not-the-password", NEW_PW);
    expect(res.statusCode).toBe(401);
    expect(blob.has("owner-auth.json")).toBe(false);
  });

  it("new password shorter than 8 → 400", async () => {
    const res = await changePw(ownerCookie(), OWNER_PW, "short");
    expect(res.statusCode).toBe(400);
  });

  it("owner login not configured (no blob, no env) → 400", async () => {
    delete process.env.OWNER_PASSWORD_HASH;
    const res = await changePw(ownerCookie(), OWNER_PW, NEW_PW);
    expect(res.statusCode).toBe(400);
  });

  it("the owner-auth.json guard accepts a string hash and rejects a non-string", () => {
    const guards = requireFromHere(guardsPath) as {
      applyGuards: (k: string, d: unknown, c: unknown, o: unknown) => unknown;
    };
    expect(() => guards.applyGuards("owner-auth.json", { passwordHash: "$2a$12$x" }, null, {})).not.toThrow();
    expect(() => guards.applyGuards("owner-auth.json", { passwordHash: 123 }, null, {})).toThrow(
      /passwordHash must be a string/,
    );
  });
});
