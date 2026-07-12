import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/_lib/xero/oauth.js (#247) — signed OAuth state (expiry, tamper,
 * wrong-user, wrong-purpose), authorize-URL shape, token exchange/refresh
 * classification (invalid_grant → reconnect_required), and the connections
 * read (organisation filtering; correlation-id capture on errors).
 */

const requireFromHere = createRequire(import.meta.url);

const ENV = {
  XERO_CLIENT_ID: "client-id-1",
  XERO_CLIENT_SECRET: "client-secret-1",
  APP_BASE_URL: "https://buhlos.com",
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let oauth: any;

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  Object.assign(process.env, ENV);
  const oauthPath = requireFromHere.resolve("../../../api/_lib/xero/oauth.js");
  delete requireFromHere.cache[oauthPath];
  oauth = requireFromHere(oauthPath);
});

describe("OAuth state", () => {
  it("round-trips for the initiating user", () => {
    const state = oauth.makeState("u_boss");
    const payload = oauth.verifyState(state, "u_boss");
    expect(payload).toBeTruthy();
    expect(payload.userId).toBe("u_boss");
  });

  it("rejects another user's state (binding)", () => {
    const state = oauth.makeState("u_boss");
    expect(oauth.verifyState(state, "u_other")).toBeNull();
  });

  it("rejects tampered state", () => {
    const state = oauth.makeState("u_boss");
    const [body, mac] = state.split(".");
    const tamperedBody = Buffer.from(
      JSON.stringify({ purpose: "xero_oauth", userId: "u_attacker", exp: Date.now() + 60_000 })
    ).toString("base64url");
    expect(oauth.verifyState(`${tamperedBody}.${mac}`, "u_attacker")).toBeNull();
    expect(oauth.verifyState(`${body}.AAAA${mac.slice(4)}`, "u_boss")).toBeNull();
  });

  it("rejects expired state", () => {
    vi.useFakeTimers();
    try {
      const state = oauth.makeState("u_boss");
      vi.advanceTimersByTime(oauth.STATE_TTL_MS + 1000);
      expect(oauth.verifyState(state, "u_boss")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a session cookie replayed as state (purpose binding)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const auth = requireFromHere("../../../api/_lib/auth.js");
    const sessionish = auth.signSession({ userId: "u_boss", role: "boss", exp: Date.now() + 60_000 });
    expect(oauth.verifyState(sessionish, "u_boss")).toBeNull();
  });
});

describe("authorize URL", () => {
  it("carries exactly the connection-milestone params", () => {
    const url = new URL(oauth.authorizeUrl("STATE123"));
    expect(url.origin + url.pathname).toBe("https://login.xero.com/identity/connect/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(ENV.XERO_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://buhlos.com/api/xero/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("state")).toBe("STATE123");
    // no payroll scopes before #610/#249 (ADR no-writes gate)
    expect(url.searchParams.get("scope")).not.toContain("payroll");
    // the client secret never appears in a browser-facing URL
    expect(url.toString()).not.toContain(ENV.XERO_CLIENT_SECRET);
  });
});

describe("token exchange + refresh", () => {
  const tokenBody = {
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_in: 1800,
    scope: "openid profile email offline_access",
  };

  it("exchanges a code and parses expiry", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, tokenBody));
    const tokens = await oauth.exchangeCode("code-1", { fetchImpl });
    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(new Date(tokens.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(String(init.headers.Authorization).startsWith("Basic ")).toBe(true);
    expect(init.body).toContain("grant_type=authorization_code");
  });

  it("classifies invalid_grant on refresh as reconnect_required", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: "invalid_grant" }));
    await expect(oauth.refreshTokens("rt-old", { fetchImpl })).rejects.toMatchObject({
      name: "XeroError",
      category: "reconnect_required",
    });
  });

  it("classifies a 500 refresh failure as transient server", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {}));
    await expect(oauth.refreshTokens("rt-old", { fetchImpl })).rejects.toMatchObject({
      category: "server",
    });
  });

  it("rejects a malformed token response without leaking it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: "at-only" }));
    await expect(oauth.exchangeCode("code-1", { fetchImpl })).rejects.toMatchObject({
      category: "unexpected",
    });
  });

  it("classifies network failure and timeouts", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { name: "TypeError" });
    });
    await expect(oauth.exchangeCode("code-1", { fetchImpl })).rejects.toMatchObject({
      category: "network",
    });
  });
});

describe("connections read", () => {
  it("returns organisations only, name+id only", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [
        { tenantId: "org-1", tenantType: "ORGANISATION", tenantName: "Buhl Electrical", extra: "x" },
        { tenantId: "prac-1", tenantType: "PRACTICE", tenantName: "Some Practice" },
        { tenantId: "org-2", tenantType: "ORGANISATION" },
      ])
    );
    const orgs = await oauth.listConnections("at-1", { fetchImpl });
    expect(orgs).toEqual([
      { tenantId: "org-1", tenantName: "Buhl Electrical" },
      { tenantId: "org-2", tenantName: "(unnamed organisation)" },
    ]);
  });

  it("captures the correlation id on failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, {}, { "xero-correlation-id": "corr-1" })
    );
    await expect(oauth.listConnections("at-1", { fetchImpl })).rejects.toMatchObject({
      category: "forbidden",
      correlationId: "corr-1",
    });
  });
});
