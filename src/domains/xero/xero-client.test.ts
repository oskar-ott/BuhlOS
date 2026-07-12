import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/_lib/xero/client.js (#247) — the shared client's refresh decision
 * logic, persist-before-use rotation, CAS-loser behaviour, terminal
 * invalid_grant handling, DB-failure-after-refresh, the 401-retry and 429
 * paths, and that thrown errors never carry token material.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const client = requireFromHere("../../../api/_lib/xero/client.js");

const ENV = {
  XERO_CLIENT_ID: "client-id-1",
  XERO_CLIENT_SECRET: "client-secret-1",
  XERO_TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: "https://buhlos.com",
  SUPABASE_DB_URL: "postgres://user:pass@host:6543/db",
};

type FakeRow = {
  id: string;
  status: string;
  refresh_version: number;
  access_token_expires_at: string | null;
  external_tenant_id: string | null;
  tokens: { accessToken: string; refreshToken: string };
};

function future(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

function makeFakeStore(row: FakeRow | null) {
  const state = { row };
  return {
    state,
    getConnection: vi.fn(async () => (state.row ? { ...state.row } : null)),
    decryptTokens: vi.fn((r: FakeRow) => ({ ...r.tokens })),
    rotateTokens: vi.fn(async ({ expectedVersion, tokens }: { expectedVersion: number; tokens: { accessToken: string; refreshToken: string; expiresAt: string } }) => {
      if (!state.row || state.row.refresh_version !== expectedVersion) return null;
      state.row = {
        ...state.row,
        refresh_version: state.row.refresh_version + 1,
        access_token_expires_at: tokens.expiresAt,
        tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      };
      return { ...state.row };
    }),
    markFailure: vi.fn(async ({ status }: { status?: string }) => {
      if (state.row && status) state.row.status = status;
      return state.row ? { ...state.row } : null;
    }),
    touchSuccess: vi.fn(async () => {}),
  };
}

function tokenResponse(access: string, refresh: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ access_token: access, refresh_token: refresh, expires_in: 1800, scope: "openid" }),
  };
}

function apiResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function connectedRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "conn-1",
    status: "connected",
    refresh_version: 3,
    access_token_expires_at: future(20 * 60_000),
    external_tenant_id: "org-1",
    tokens: { accessToken: "at-live", refreshToken: "rt-live" },
    ...over,
  };
}

describe("getAccessContext", () => {
  it("uses a still-valid access token without refreshing", async () => {
    const store = makeFakeStore(connectedRow());
    const fetchImpl = vi.fn();
    const ctx = await client.getAccessContext({ store, env: ENV, fetchImpl });
    expect(ctx.accessToken).toBe("at-live");
    expect(ctx.externalTenantId).toBe("org-1");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.rotateTokens).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists BEFORE returning it", async () => {
    const store = makeFakeStore(connectedRow({ access_token_expires_at: future(-1000) }));
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      order.push("xero-refresh");
      return tokenResponse("at-new", "rt-new");
    });
    store.rotateTokens.mockImplementationOnce(async (args) => {
      order.push("persist");
      store.state.row = {
        ...store.state.row!,
        refresh_version: 4,
        access_token_expires_at: args.tokens.expiresAt,
        tokens: { accessToken: args.tokens.accessToken, refreshToken: args.tokens.refreshToken },
      };
      return { ...store.state.row };
    });
    const ctx = await client.getAccessContext({ store, env: ENV, fetchImpl });
    expect(ctx.accessToken).toBe("at-new");
    expect(order).toEqual(["xero-refresh", "persist"]);
  });

  it("CAS loser re-reads and uses the WINNER's tokens, never overwrites", async () => {
    const store = makeFakeStore(connectedRow({ access_token_expires_at: future(-1000) }));
    const fetchImpl = vi.fn(async () => tokenResponse("at-loser", "rt-loser"));
    // the CAS refuses (someone else already rotated) …
    store.rotateTokens.mockResolvedValueOnce(null);
    // … and the re-read returns the winner's row
    store.getConnection
      .mockResolvedValueOnce({ ...connectedRow({ access_token_expires_at: future(-1000) }) })
      .mockResolvedValueOnce({
        ...connectedRow({
          refresh_version: 4,
          access_token_expires_at: future(20 * 60_000),
          tokens: { accessToken: "at-winner", refreshToken: "rt-winner" },
        }),
      });
    const ctx = await client.getAccessContext({ store, env: ENV, fetchImpl });
    expect(ctx.accessToken).toBe("at-winner");
    expect(store.rotateTokens).toHaveBeenCalledTimes(1);
  });

  it("invalid_grant marks reconnect_required and throws terminally", async () => {
    const store = makeFakeStore(connectedRow({ access_token_expires_at: future(-1000) }));
    const fetchImpl = vi.fn(async () => apiResponse(400, { error: "invalid_grant" }));
    await expect(client.getAccessContext({ store, env: ENV, fetchImpl })).rejects.toMatchObject({
      category: "reconnect_required",
    });
    expect(store.markFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: "reconnect_required" })
    );
  });

  it("a transient refresh failure degrades (distinguishable from revoked)", async () => {
    const store = makeFakeStore(connectedRow({ access_token_expires_at: future(-1000) }));
    const fetchImpl = vi.fn(async () => apiResponse(503, {}));
    await expect(client.getAccessContext({ store, env: ENV, fetchImpl })).rejects.toMatchObject({
      category: "server",
    });
    expect(store.markFailure).toHaveBeenCalledWith(expect.objectContaining({ status: "degraded" }));
  });

  it("a DB failure after a successful Xero refresh is NOT a successful refresh", async () => {
    const store = makeFakeStore(connectedRow({ access_token_expires_at: future(-1000) }));
    const fetchImpl = vi.fn(async () => tokenResponse("at-new", "rt-new"));
    store.rotateTokens.mockRejectedValueOnce(new Error("db down"));
    await expect(client.getAccessContext({ store, env: ENV, fetchImpl })).rejects.toMatchObject({
      category: "persistence",
    });
  });

  it("concurrent refreshes: one CAS winner, the loser adopts the winner's tokens", async () => {
    const row = connectedRow({ access_token_expires_at: future(-1000) });
    const store = makeFakeStore(row);
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return tokenResponse(`at-r${calls}`, `rt-r${calls}`);
    });
    const [a, b] = await Promise.all([
      client.getAccessContext({ store, env: ENV, fetchImpl }),
      client.getAccessContext({ store, env: ENV, fetchImpl }),
    ]);
    // Exactly one rotation landed (version bumped once); both callers hold
    // the winner's access token.
    expect(store.state.row?.refresh_version).toBe(4);
    expect([a.accessToken, b.accessToken]).toContain(store.state.row?.tokens.accessToken);
    expect(a.accessToken).toBe(store.state.row?.tokens.accessToken);
    expect(b.accessToken).toBe(store.state.row?.tokens.accessToken);
  });

  it("throws typed states for missing/unusable connections", async () => {
    await expect(
      client.getAccessContext({ store: makeFakeStore(null), env: ENV })
    ).rejects.toMatchObject({ category: "not_connected" });
    await expect(
      client.getAccessContext({
        store: makeFakeStore(connectedRow({ status: "reconnect_required" })),
        env: ENV,
      })
    ).rejects.toMatchObject({ category: "reconnect_required" });
    await expect(client.getAccessContext({ store: makeFakeStore(null), env: {} })).rejects.toMatchObject({
      category: "not_configured",
    });
  });

  it("never carries token material in thrown errors", async () => {
    const store = makeFakeStore(connectedRow({ access_token_expires_at: future(-1000) }));
    const fetchImpl = vi.fn(async () => apiResponse(400, { error: "invalid_grant" }));
    try {
      await client.getAccessContext({ store, env: ENV, fetchImpl });
      expect.unreachable("should throw");
    } catch (err) {
      const s = String((err as Error).message) + JSON.stringify(err);
      expect(s).not.toContain("rt-live");
      expect(s).not.toContain("at-live");
    }
  });
});

describe("xeroFetch", () => {
  it("sends bearer + tenant header, touches last_success on 200", async () => {
    const store = makeFakeStore(connectedRow());
    const fetchImpl = vi.fn(async () => apiResponse(200, { ok: true }, { "xero-correlation-id": "corr-9" }));
    const out = await client.xeroFetch("https://api.xero.com/connections", {
      deps: { store, env: ENV, fetchImpl },
    });
    expect(out.data).toEqual({ ok: true });
    expect(out.correlationId).toBe("corr-9");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer at-live");
    expect(init.headers["Xero-tenant-id"]).toBe("org-1");
    expect(store.touchSuccess).toHaveBeenCalled();
  });

  it("on 401 refreshes once and retries once", async () => {
    const store = makeFakeStore(connectedRow());
    const fetchImpl = vi.fn(async (url: string, init: { body?: string }) => {
      if (String(url).includes("identity.xero.com")) return tokenResponse("at-new", "rt-new");
      void init;
      return fetchImpl.mock.calls.filter((c) => String(c[0]).includes("api.xero.com")).length === 1
        ? apiResponse(401)
        : apiResponse(200, { ok: true });
    });
    const out = await client.xeroFetch("https://api.xero.com/connections", {
      deps: { store, env: ENV, fetchImpl },
    });
    expect(out.data).toEqual({ ok: true });
    // one API 401 + one refresh + one API retry
    expect(store.rotateTokens).toHaveBeenCalledTimes(1);
  });

  it("throws rate_limit with Retry-After beyond the wait budget", async () => {
    const store = makeFakeStore(connectedRow());
    const fetchImpl = vi.fn(async () => apiResponse(429, {}, { "retry-after": "60" }));
    await expect(
      client.xeroFetch("https://api.xero.com/connections", { deps: { store, env: ENV, fetchImpl } })
    ).rejects.toMatchObject({ category: "rate_limit", retryAfterSeconds: 60 });
  });
});
