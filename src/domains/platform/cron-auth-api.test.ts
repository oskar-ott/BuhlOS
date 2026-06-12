import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #381 — cron endpoints fail CLOSED in production when CRON_SECRET is unset.
 *
 * Covers the shared helper (api/_lib/cron-auth.js) directly across all four
 * states, plus real-handler integration on api/notifications.js (the biggest
 * fan-out surface) and api/users.js?action=sweep (destructive) so the
 * adoption — not just the helper — is pinned.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const cronAuthPath = requireFromHere.resolve("../../../api/_lib/cron-auth.js");
const notificationsPath = requireFromHere.resolve("../../../api/notifications.js");
const usersPath = requireFromHere.resolve("../../../api/users.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
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

function freshCronAuth(): {
  cronAuthState: (req: { headers?: Record<string, string> }) => string;
} {
  delete requireFromHere.cache[cronAuthPath];
  return requireFromHere(cronAuthPath);
}

function loadHandler(path: string): (req: Record<string, unknown>, res: Res) => Promise<unknown> {
  for (const p of [authPath, cronAuthPath, notificationsPath, usersPath]) {
    delete requireFromHere.cache[p];
  }
  return requireFromHere(path);
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_ENV;

  blob = new Map<string, unknown>();
  blob.set("users.json", { users: [] });

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
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: {
      getWebPush: vi.fn(() => ({})),
      sendPushToUserId: vi.fn(async () => ({ sent: 0, pruned: 0 })),
    },
  } as NodeJS.Module;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_ENV;
});

describe("cronAuthState — the four states", () => {
  it("secret set: Bearer and x-cron-secret both authorise; anything else is denied", () => {
    process.env.CRON_SECRET = "s3cret";
    const { cronAuthState } = freshCronAuth();
    expect(cronAuthState({ headers: { authorization: "Bearer s3cret" } })).toBe("ok");
    expect(cronAuthState({ headers: { "x-cron-secret": "s3cret" } })).toBe("ok");
    expect(cronAuthState({ headers: { authorization: "Bearer wrong" } })).toBe("denied");
    expect(cronAuthState({ headers: {} })).toBe("denied");
  });

  it("secret UNSET: production fails closed, preview/dev stays permissive", () => {
    const { cronAuthState } = freshCronAuth();
    expect(cronAuthState({ headers: {} })).toBe("ok"); // no VERCEL_ENV = local dev

    process.env.VERCEL_ENV = "preview";
    expect(freshCronAuth().cronAuthState({ headers: {} })).toBe("ok");

    process.env.VERCEL_ENV = "production";
    expect(freshCronAuth().cronAuthState({ headers: {} })).toBe("unconfigured");
  });
});

describe("handler adoption", () => {
  it("notifications cron 503s in unconfigured production WITHOUT leaking the state", async () => {
    process.env.VERCEL_ENV = "production";
    const handler = loadHandler(notificationsPath);
    const res = createRes();
    await handler(
      { method: "GET", query: { action: "send-daily-reminders" }, headers: {} },
      res,
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "cron auth unconfigured" });
  });

  it("notifications cron still 401s a WRONG secret (secret never echoed)", async () => {
    process.env.CRON_SECRET = "s3cret";
    const handler = loadHandler(notificationsPath);
    const res = createRes();
    await handler(
      {
        method: "GET",
        query: { action: "send-daily-reminders" },
        headers: { authorization: "Bearer nope" },
      },
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("s3cret");
  });

  it("notifications cron proceeds past auth with a valid Bearer secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.VERCEL_ENV = "production";
    const handler = loadHandler(notificationsPath);
    const res = createRes();
    await handler(
      {
        method: "GET",
        query: { action: "send-daily-reminders" },
        headers: { authorization: "Bearer s3cret" },
      },
      res,
    );
    expect(res.statusCode).toBe(200); // ran the (empty) fan-out
  });

  it("users sweep — destructive — is NEVER anonymous: 401 without a secret in any env", async () => {
    for (const env of ["production", "preview"]) {
      process.env.VERCEL_ENV = env;
      const handler = loadHandler(usersPath);
      const res = createRes();
      await handler({ method: "GET", query: { action: "sweep" }, headers: {} }, res);
      expect(res.statusCode, env).toBe(401);
    }
  });

  it("users sweep RUNS with a valid cron secret (it was dead code behind the bare GET before)", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.VERCEL_ENV = "production";
    const handler = loadHandler(usersPath);
    const res = createRes();
    await handler(
      { method: "GET", query: { action: "sweep" }, headers: { authorization: "Bearer s3cret" } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
