import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Self-service PIN recovery (api/pin-reset.js), through the REAL handler on an
 * in-memory Blob — the jobs-api harness shape.
 *
 * The contract under test is a SECURITY contract:
 *   - the gate is inbox control: a link only ever goes to the address ON FILE;
 *   - asking reveals nothing (same 200 for unknown / disabled / real);
 *   - tokens are stored hashed, single-use, short-lived, and superseded by a
 *     newer request;
 *   - the reset is IN PLACE (same account id — hours and jobs survive);
 *   - a bad PIN never spends the link.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const emailPath = requireFromHere.resolve("../../../api/_lib/email.js");
const resetPath = requireFromHere.resolve("../../../api/pin-reset.js");
const bcrypt = requireFromHere("bcryptjs") as {
  compare: (plain: string, hash: string) => Promise<boolean>;
  hashSync: (plain: string, rounds: number) => string;
};

let blob: Map<string, unknown>;
let sent: Array<{ kind: string; ctx: Record<string, unknown> }>;
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}

async function call(method: string, action: string, opts: {
  body?: unknown;
  query?: Record<string, string>;
  ip?: string;
} = {}) {
  const res = createRes();
  await handler(
    {
      method,
      query: { action, ...(opts.query || {}) },
      body: opts.body,
      headers: { "x-forwarded-for": opts.ip ?? "10.0.0.1", host: "buhlapp.xyz" },
      socket: {},
    },
    res,
  );
  return res;
}

/** The plaintext token from the most recent email (the only place it exists). */
function lastLink(): string {
  const ctx = sent[sent.length - 1]!.ctx as { ctaUrl: string };
  return decodeURIComponent(ctx.ctaUrl.split("/reset/")[1]!);
}

function storedResets(): Array<Record<string, unknown>> {
  return ((blob.get("pin-resets.json") as { resets?: unknown[] })?.resets ?? []) as Array<Record<string, unknown>>;
}

function userHash(id: string): string {
  const data = blob.get("users.json") as { users: Array<{ id: string; passwordHash: string }> };
  return data.users.find((u) => u.id === id)!.passwordHash;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  sent = [];
  blob = new Map<string, unknown>([
    ["users.json", {
      users: [
        { id: "u_field", username: "anders@gmail.com", email: "anders@gmail.com", name: "Anders Koskela", role: "apprentice", passwordHash: bcrypt.hashSync("0001", 10), assignedJobIds: ["job-a", "job-b"] },
        { id: "u_named", username: "sparky", email: "sparky@work.com", name: "Sparky Jones", role: "electrician", passwordHash: bcrypt.hashSync("0002", 10), assignedJobIds: [] },
        { id: "u_admin", username: "boss", email: "boss@work.com", name: "The Boss", role: "admin", passwordHash: bcrypt.hashSync("bosspass", 10), assignedJobIds: [] },
        { id: "u_gone", username: "gone@work.com", email: "gone@work.com", name: "Gone Away", role: "labourer", passwordHash: bcrypt.hashSync("0003", 10), disabled: true, assignedJobIds: [] },
      ],
    }],
  ]);

  for (const p of [resetPath, emailPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: {
      isEmailConfigured: () => true,
      companyName: () => "bühl electrical",
      sendTemplate: vi.fn(async (kind: string, ctx: Record<string, unknown>) => {
        sent.push({ kind, ctx });
        return { ok: true };
      }),
    },
  } as NodeJS.Module;

  handler = requireFromHere(resetPath);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("POST ?action=request — the gate is inbox control, and asking reveals nothing", () => {
  it("mails a one-time link to the address ON FILE and stores only its hash", async () => {
    const res = await call("POST", "request", { body: { email: "anders@gmail.com" } });
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe("pinReset");
    expect(sent[0]!.ctx.to).toBe("anders@gmail.com");

    const token = lastLink();
    expect(token.length).toBeGreaterThan(20);
    const rows = storedResets();
    expect(rows).toHaveLength(1);
    // The plaintext token is NEVER persisted — only a bcrypt hash of it.
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(await bcrypt.compare(token, rows[0]!.tokenHash as string)).toBe(true);
  });

  it("an UNKNOWN address looks identical to a real one and sends nothing", async () => {
    const real = await call("POST", "request", { body: { email: "anders@gmail.com" }, ip: "10.0.0.2" });
    const fake = await call("POST", "request", { body: { email: "nobody@nowhere.com" }, ip: "10.0.0.3" });
    expect(fake.statusCode).toBe(real.statusCode);
    expect(fake.body).toEqual(real.body);
    expect(sent.map((s) => s.ctx.to)).toEqual(["anders@gmail.com"]);
  });

  it("a DISABLED account is never re-credentialled, and still looks identical", async () => {
    const res = await call("POST", "request", { body: { email: "gone@work.com" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it("resolves a legacy NAME account by its email field, like login does", async () => {
    await call("POST", "request", { body: { email: "sparky@work.com" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.ctx.to).toBe("sparky@work.com");
  });

  it("a NEW link supersedes the account's earlier pending one", async () => {
    await call("POST", "request", { body: { email: "anders@gmail.com" } });
    const firstToken = lastLink();
    await call("POST", "request", { body: { email: "anders@gmail.com" } });
    const secondToken = lastLink();
    expect(secondToken).not.toBe(firstToken);

    // The old link is dead; only the newest works.
    const old = await call("GET", "resolve", { query: { token: firstToken } });
    expect((old.body as { state: string }).state).toBe("invalid");
    const fresh = await call("GET", "resolve", { query: { token: secondToken } });
    expect((fresh.body as { state: string }).state).toBe("valid");
  });

  it("throttles repeat requests for one address without ever changing the reply", async () => {
    const bodies = [];
    for (let i = 0; i < 6; i++) {
      const r = await call("POST", "request", { body: { email: "anders@gmail.com" }, ip: `10.1.0.${i}` });
      bodies.push({ status: r.statusCode, body: r.body });
    }
    // Every reply is the same 200 {ok:true} — a throttle is not a signal…
    for (const b of bodies) expect(b).toEqual({ status: 200, body: { ok: true } });
    // …but the mailbox is protected (3 per 30 min).
    expect(sent.length).toBeLessThanOrEqual(3);
  });
});

describe("GET ?action=resolve — a dead token reveals nothing", () => {
  it("a valid token returns only a first name for the greeting", async () => {
    await call("POST", "request", { body: { email: "anders@gmail.com" } });
    const res = await call("GET", "resolve", { query: { token: lastLink() } });
    expect(res.body).toEqual({ state: "valid", firstName: "Anders", isPassword: false });
  });

  it("a garbage token is just 'invalid' — no account data", async () => {
    const res = await call("GET", "resolve", { query: { token: "not-a-real-token" } });
    expect(res.body).toEqual({ state: "invalid" });
  });

  it("an expired token reports 'expired'", async () => {
    await call("POST", "request", { body: { email: "anders@gmail.com" } });
    const token = lastLink();
    const doc = blob.get("pin-resets.json") as { resets: Array<{ expiresAt: string }> };
    doc.resets[0]!.expiresAt = new Date(Date.now() - 1000).toISOString();
    blob.set("pin-resets.json", doc);
    const res = await call("GET", "resolve", { query: { token } });
    expect((res.body as { state: string }).state).toBe("expired");
  });
});

describe("POST ?action=accept — sets the credential IN PLACE, once", () => {
  async function freshToken(email = "anders@gmail.com") {
    await call("POST", "request", { body: { email } });
    return lastLink();
  }

  it("sets a new PIN that verifies, keeps the SAME account, and spends the link", async () => {
    const token = await freshToken();
    const before = userHash("u_field");
    const res = await call("POST", "accept", { body: { token, pin: "8317", confirmPin: "8317" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { username: string }).username).toBe("anders@gmail.com");

    const after = userHash("u_field");
    expect(after).not.toBe(before);
    expect(await bcrypt.compare("8317", after)).toBe(true);

    // IN PLACE: same id, jobs intact, no duplicate row.
    const users = (blob.get("users.json") as { users: Array<{ id: string; assignedJobIds: string[] }> }).users;
    expect(users.filter((u) => u.id === "u_field")).toHaveLength(1);
    expect(users.find((u) => u.id === "u_field")!.assignedJobIds).toEqual(["job-a", "job-b"]);
    // No credential material is ever returned.
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain("8317");
  });

  it("the link is SINGLE-USE — a replay is refused and the PIN stays put", async () => {
    const token = await freshToken();
    expect((await call("POST", "accept", { body: { token, pin: "8317", confirmPin: "8317" } })).statusCode).toBe(200);
    const afterFirst = userHash("u_field");

    const replay = await call("POST", "accept", { body: { token, pin: "9999", confirmPin: "9999" } });
    expect(replay.statusCode).toBe(409);
    expect(userHash("u_field")).toBe(afterFirst);
    expect(await bcrypt.compare("9999", userHash("u_field"))).toBe(false);
  });

  it("an expired link is refused (410) and changes nothing", async () => {
    const token = await freshToken();
    const before = userHash("u_field");
    const doc = blob.get("pin-resets.json") as { resets: Array<{ expiresAt: string }> };
    doc.resets[0]!.expiresAt = new Date(Date.now() - 1000).toISOString();
    blob.set("pin-resets.json", doc);

    const res = await call("POST", "accept", { body: { token, pin: "8317", confirmPin: "8317" } });
    expect(res.statusCode).toBe(410);
    expect(userHash("u_field")).toBe(before);
  });

  it("a forged token is refused (404)", async () => {
    const before = userHash("u_field");
    const res = await call("POST", "accept", { body: { token: "forged", pin: "8317", confirmPin: "8317" } });
    expect(res.statusCode).toBe(404);
    expect(userHash("u_field")).toBe(before);
  });

  it("a weak or malformed PIN is refused and does NOT spend the link", async () => {
    const token = await freshToken();
    for (const bad of ["123", "12345", "abcd", "1234", "0000", "1111"]) {
      const res = await call("POST", "accept", { body: { token, pin: bad, confirmPin: bad } });
      expect(res.statusCode, bad).toBe(400);
    }
    // Still usable afterwards — a typo must not cost them the link.
    const ok = await call("POST", "accept", { body: { token, pin: "8317", confirmPin: "8317" } });
    expect(ok.statusCode).toBe(200);
  });

  it("mismatched confirmation is refused", async () => {
    const token = await freshToken();
    const res = await call("POST", "accept", { body: { token, pin: "8317", confirmPin: "8318" } });
    expect(res.statusCode).toBe(400);
  });

  it("a literal 'admin' login sets a PASSWORD (6+), not a 4-digit PIN", async () => {
    await call("POST", "request", { body: { email: "boss@work.com" } });
    const token = lastLink();
    expect(sent[sent.length - 1]!.ctx.isPassword).toBe(true);

    expect((await call("POST", "accept", { body: { token, pin: "8317", confirmPin: "8317" } })).statusCode).toBe(400);
    const ok = await call("POST", "accept", { body: { token, pin: "correct-horse", confirmPin: "correct-horse" } });
    expect(ok.statusCode).toBe(200);
    expect(await bcrypt.compare("correct-horse", userHash("u_admin"))).toBe(true);
  });
});
