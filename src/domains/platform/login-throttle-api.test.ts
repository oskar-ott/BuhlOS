import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #514 — the field PIN login throttle, against the REAL api/auth.js handler with
 * an in-memory users blob. Proves: repeated wrong-PIN attempts on one username
 * are locked with a clear 429 + Retry-After; a different username is unaffected
 * (a shared-site IP can't lock the crew); a correct PIN within the limit logs in
 * and resets; and once locked, even the CORRECT PIN is refused until the window
 * passes (no probing a locked account).
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const handlerPath = requireFromHere.resolve("../../../api/auth.js");
const bcrypt = requireFromHere("bcryptjs") as { hashSync: (s: string, rounds: number) => string };

const PIN = "1234";
const HASH = bcrypt.hashSync(PIN, 4); // low rounds — test speed only

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
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

let blob: Map<string, unknown>;
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

async function login(username: string, secret: string) {
  const res = createRes();
  await handler({ method: "POST", query: { action: "login" }, body: { username, secret }, headers: {} }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_field", username: "sparky", role: "electrician", passwordHash: HASH },
          { id: "u_other", username: "wiremate", role: "electrician", passwordHash: HASH },
        ],
      },
    ],
  ]);
  delete requireFromHere.cache[handlerPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async () => {}),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  handler = requireFromHere(handlerPath);
});

describe("POST /api/auth?action=login — PIN throttle (#514)", () => {
  it("locks a username after 5 wrong PINs with a clear 429 + Retry-After", async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await login("sparky", "0000");
      expect(r.statusCode).toBe(401);
    }
    const sixth = await login("sparky", "0000");
    expect(sixth.statusCode).toBe(429);
    expect((sixth.body as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
    expect(sixth.headers["Retry-After"]).toBeTruthy();
  });

  it("a locked username does NOT affect another username (per-username, not per-IP)", async () => {
    for (let i = 0; i < 6; i += 1) await login("sparky", "0000");
    expect((await login("sparky", PIN)).statusCode).toBe(429); // sparky locked
    const other = await login("wiremate", PIN); // different user logs in fine
    expect(other.statusCode).toBe(200);
  });

  it("a correct PIN within the limit logs in and resets the counter", async () => {
    await login("sparky", "0000");
    await login("sparky", "0000");
    const ok = await login("sparky", PIN);
    expect(ok.statusCode).toBe(200);
    expect((ok.body as { user: { passwordHash?: string } }).user.passwordHash).toBeUndefined();
    // counter reset — a fresh wrong attempt is a 401, not a 429
    expect((await login("sparky", "0000")).statusCode).toBe(401);
  });

  it("once locked, even the CORRECT PIN is refused (no probing a locked account)", async () => {
    for (let i = 0; i < 5; i += 1) await login("sparky", "0000");
    const correctButLocked = await login("sparky", PIN);
    expect(correctButLocked.statusCode).toBe(429);
  });

  it("unknown usernames are throttled too (no enumeration via the throttle)", async () => {
    for (let i = 0; i < 5; i += 1) expect((await login("ghost", "0000")).statusCode).toBe(401);
    expect((await login("ghost", "0000")).statusCode).toBe(429);
  });
});

/**
 * Email-first worker login (founder decision 2026-07-28). The worker screen
 * asks for EMAIL; api/auth.js keeps the exact-username match first (legacy
 * crew typing a name keep working) and, on a miss only, resolves the typed
 * value against users' `email` field — one unambiguous match, then the SAME
 * PIN compare + throttle + disabled gates as every login. Live fault this
 * kills: a row whose username is a name but whose email was what the worker
 * typed (Alfredo) could never sign in — the PIN was never compared.
 */
describe("POST /api/auth?action=login — email fallback on exact-username miss", () => {
  beforeEach(() => {
    const users = (blob.get("users.json") as { users: Array<Record<string, unknown>> }).users;
    users.push(
      // Legacy crew member: NAME username, no email on the row.
      { id: "u_bob", username: "bob", role: "electrician", passwordHash: HASH },
      // Signup/invite-created: username IS the email (exact path serves it).
      { id: "u_signup", username: "alfredo.reyes@gmail.com", email: "alfredo.reyes@gmail.com", role: "electrician", passwordHash: HASH },
      // Hand-created: NAME username with the email only in the email field.
      { id: "u_wendy", username: "wendy", email: "wendy.h@gmail.com", role: "electrician", passwordHash: HASH },
      // Legacy dirt: two rows sharing one email — must never be guessed between.
      { id: "u_twin_a", username: "twin.a", email: "shared@gmail.com", role: "electrician", passwordHash: HASH },
      { id: "u_twin_b", username: "twin.b", email: "shared@gmail.com", role: "apprentice", passwordHash: HASH },
      // Disabled account reachable via the email fallback.
      { id: "u_gone", username: "gonzo", email: "gone@gmail.com", role: "electrician", passwordHash: HASH, archived: true },
    );
  });

  it("a legacy NAME username still logs in unchanged (label change breaks nobody)", async () => {
    const r = await login("bob", PIN);
    expect(r.statusCode).toBe(200);
    expect((r.body as { user: { id: string } }).user.id).toBe("u_bob");
  });

  it("a signup-created user (username=email) logs in with the email via the exact path", async () => {
    const r = await login("Alfredo.Reyes@gmail.com", PIN);
    expect(r.statusCode).toBe(200);
    expect((r.body as { user: { id: string; passwordHash?: string } }).user.id).toBe("u_signup");
    expect((r.body as { user: { passwordHash?: string } }).user.passwordHash).toBeUndefined();
  });

  it("a NAME-username row with an email field resolves via the email fallback", async () => {
    const r = await login("Wendy.H@gmail.com", PIN);
    expect(r.statusCode).toBe(200);
    expect((r.body as { user: { id: string } }).user.id).toBe("u_wendy");
    // Her username keeps working too — the exact path is untouched.
    expect((await login("wendy", PIN)).statusCode).toBe(200);
  });

  it("two rows sharing an email stay a generic 401 — never guess between them", async () => {
    const r = await login("shared@gmail.com", PIN);
    expect(r.statusCode).toBe(401);
    expect(r.body).toEqual({ error: "invalid credentials" });
    // Each twin still signs in by their own username.
    expect((await login("twin.a", PIN)).statusCode).toBe(200);
    expect((await login("twin.b", PIN)).statusCode).toBe(200);
  });

  it("an unknown email stays the generic 401", async () => {
    expect((await login("nobody@gmail.com", PIN)).statusCode).toBe(401);
  });

  it("a wrong PIN on an email-resolved user is 401 AND counts toward the throttle", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await login("wendy.h@gmail.com", "0000")).statusCode).toBe(401);
    }
    const sixth = await login("wendy.h@gmail.com", "0000");
    expect(sixth.statusCode).toBe(429); // recorded under the TYPED key
    // Locked under the typed email — even the correct PIN is refused now.
    expect((await login("wendy.h@gmail.com", PIN)).statusCode).toBe(429);
  });

  it("the disabled-user gate applies to an email-resolved account", async () => {
    const r = await login("gone@gmail.com", PIN);
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: "Account disabled. Ask your supervisor." });
  });
});
