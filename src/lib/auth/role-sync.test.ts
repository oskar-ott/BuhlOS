import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { needsRoleSync, ROLE_SYNC_PATH } from "./role-sync";

/**
 * Role-change sync (2026-10-15). After the office changed someone's role, the
 * 30-day session cookie kept the old role and the page gates kept routing by
 * it — an electrician made project manager stayed in the field app (no job
 * hours, no materials) until they happened to sign out. The landing pages now
 * send a mismatched session to GET /api/auth?action=refresh, which re-signs it
 * with the LIVE users.json role.
 */

describe("needsRoleSync", () => {
  it("is true when the live login role differs from the signed-in one", () => {
    expect(needsRoleSync("electrician", "pm", false)).toBe(true);
    expect(needsRoleSync("admin", "electrician", false)).toBe(true);
  });

  it("is false when nothing changed (case-insensitive, like every role check)", () => {
    expect(needsRoleSync("pm", "pm", false)).toBe(false);
    expect(needsRoleSync("leadingHand", "leadinghand", false)).toBe(false);
  });

  it("never fires without a live role — a failed lookup is not a change", () => {
    expect(needsRoleSync("electrician", null, false)).toBe(false);
    expect(needsRoleSync("electrician", undefined, false)).toBe(false);
    expect(needsRoleSync("electrician", "", false)).toBe(false);
  });

  it("never fires straight after a sync, so a stale read can't loop the browser", () => {
    expect(needsRoleSync("electrician", "pm", true)).toBe(false);
  });

  it("points at the refresh endpoint", () => {
    expect(ROLE_SYNC_PATH).toBe("/api/auth?action=refresh");
  });
});

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const authApiPath = requireFromHere.resolve("../../../api/auth.js");

let users: Array<Record<string, unknown>> = [];
let auth: {
  signSession: (payload: Record<string, unknown>) => string;
  verifySession: (token: string) => Record<string, unknown> | null;
};
let authHandler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<void>;

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    ended: false,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: unknown) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function sessionCookie(userId: string, role: string) {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function refresh(cookie?: string) {
  const res = createRes();
  await authHandler(
    { method: "GET", query: { action: "refresh" }, headers: cookie ? { cookie } : {} },
    res,
  );
  return res;
}

function issuedSession(res: ReturnType<typeof createRes>) {
  const header = String(res.headers["set-cookie"] ?? "");
  const token = /buhl_session=([^;]*)/.exec(header)?.[1] ?? "";
  return token ? auth.verifySession(decodeURIComponent(token)) : null;
}

describe("GET /api/auth?action=refresh — re-sign the session with the live role", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret-long-enough";
    delete process.env.OWNER_PASSWORD_HASH;
    users = [
      { id: "u_simon", username: "simon", role: "pm", passwordHash: "$2a$10$x" },
      { id: "u_gone", username: "gone", role: "electrician", archived: true, passwordHash: "$2a$10$x" },
    ];
    delete requireFromHere.cache[authApiPath];
    delete requireFromHere.cache[authPath];
    requireFromHere.cache[blobPath] = {
      id: blobPath,
      filename: blobPath,
      loaded: true,
      exports: {
        readBlob: vi.fn(async () => ({ users })),
        writeBlob: vi.fn(),
        setNoCache: vi.fn(),
      },
    } as NodeJS.Module;
    auth = requireFromHere(authPath);
    authHandler = requireFromHere(authApiPath);
  });

  it("an electrician session for a login now set to project manager comes back as pm, routed home", async () => {
    const res = await refresh(sessionCookie("u_simon", "electrician"));
    expect(res.statusCode).toBe(307);
    expect(res.headers["location"]).toBe("/?synced=1");
    expect(res.ended).toBe(true);
    expect(issuedSession(res)).toMatchObject({ userId: "u_simon", role: "pm" });
  });

  it("only copies the stored role — a forged role in the cookie can't survive it", async () => {
    // A cookie claiming more than the login has is re-signed DOWN to the truth.
    const res = await refresh(sessionCookie("u_simon", "admin"));
    expect(issuedSession(res)).toMatchObject({ userId: "u_simon", role: "pm" });
  });

  it("a disabled login is signed out", async () => {
    const res = await refresh(sessionCookie("u_gone", "electrician"));
    expect(res.statusCode).toBe(307);
    expect(res.headers["location"]).toBe("/v2/login");
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("no session → sign in", async () => {
    const res = await refresh();
    expect(res.statusCode).toBe(307);
    expect(res.headers["location"]).toBe("/v2/login");
  });
});
