import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the api/xero/*.js handlers (#247) — real serverless
 * handlers vs a mocked blob store (auth/flags/audit), a mocked token-store
 * and mocked Xero network calls, with REAL HMAC sessions and REAL signed
 * OAuth state. Covers the auth/flag/config gates, the OAuth start redirect,
 * every callback outcome, explicit organisation selection, disconnect, the
 * health read — and that no token material ever reaches a response.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const oauthPath = requireFromHere.resolve("../../../api/_lib/xero/oauth.js");
const storePath = requireFromHere.resolve("../../../api/_lib/xero/token-store.js");
const clientPath = requireFromHere.resolve("../../../api/_lib/xero/client.js");
const configPath = requireFromHere.resolve("../../../api/_lib/xero/config.js");
const errorsPath = requireFromHere.resolve("../../../api/_lib/xero/errors.js");
const healthPath = requireFromHere.resolve("../../../api/_lib/xero/connection-health.js");
const secretBoxPath = requireFromHere.resolve("../../../api/_lib/secret-box.js");
const connectPath = requireFromHere.resolve("../../../api/xero/connect.js");
const callbackPath = requireFromHere.resolve("../../../api/xero/callback.js");
const statusPath = requireFromHere.resolve("../../../api/xero/status.js");
const organisationsPath = requireFromHere.resolve("../../../api/xero/organisations.js");
const disconnectPath = requireFromHere.resolve("../../../api/xero/disconnect.js");

const TOKENS = {
  accessToken: "at-secret-1",
  refreshToken: "rt-secret-1",
  expiresAt: new Date(Date.now() + 1800_000).toISOString(),
  scope: "openid profile email offline_access",
};
const ONE_ORG = [{ tenantId: "org-1", tenantName: "Buhl Electrical" }];
const TWO_ORGS = [
  { tenantId: "org-1", tenantName: "Buhl Electrical" },
  { tenantId: "org-2", tenantName: "Buhl Holdings" },
];

let blobStore: Map<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let oauth: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handlers: Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connState: { row: any };
let exchangeCode: ReturnType<typeof vi.fn>;
let listConnections: ReturnType<typeof vi.fn>;
let revokeRefreshToken: ReturnType<typeof vi.fn>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    ended: false,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}
function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: any,
  opts: { method: string; role?: string; userId?: string; query?: Record<string, string>; body?: unknown; anon?: boolean }
) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_boss", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}
function auditEntries(): Array<{ action: string; metadata?: Record<string, unknown> }> {
  const month = new Date().toISOString().slice(0, 7);
  const doc = blobStore.get(`audit/${month}.json`) as { entries?: Array<{ action: string }> } | undefined;
  return (doc?.entries as Array<{ action: string; metadata?: Record<string, unknown> }>) || [];
}
function pendingRow() {
  return {
    id: "conn-1",
    status: "pending_selection",
    refresh_version: 1,
    access_token_enc: "v1.enc-iv.enc-ct.enc-tag",
    refresh_token_enc: "v1.enc-iv.enc-ct.enc-tag",
    access_token_expires_at: TOKENS.expiresAt,
    granted_scopes: TOKENS.scope,
    external_tenant_id: null as string | null,
    external_tenant_name: null as string | null,
    connected_at: null as string | null,
    last_success_at: null as string | null,
    last_refresh_attempt_at: null as string | null,
    last_refresh_success_at: null as string | null,
    last_error_category: null as string | null,
    __plainAccess: TOKENS.accessToken,
    __plainRefresh: TOKENS.refreshToken,
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_XERO_CONNECTION = "1";
  process.env.XERO_CLIENT_ID = "client-id-1";
  process.env.XERO_CLIENT_SECRET = "client-secret-1";
  process.env.XERO_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.APP_BASE_URL = "https://buhlos.com";
  process.env.SUPABASE_DB_URL = "postgres://user:pass@host:6543/db";

  blobStore = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: [] },
        ],
      },
    ],
  ]);

  for (const p of [
    authPath, ffPath, auditPath, oauthPath, clientPath, configPath, errorsPath,
    healthPath, secretBoxPath, connectPath, callbackPath, statusPath,
    organisationsPath, disconnectPath, storePath,
  ]) {
    delete requireFromHere.cache[p];
  }

  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blobStore.has(key) ? clone(blobStore.get(key)) : fallback
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blobStore.has(key) ? clone(blobStore.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blobStore.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);

  // Real oauth module (real signed state), with the NETWORK functions stubbed.
  oauth = requireFromHere(oauthPath);
  exchangeCode = vi.fn(async () => ({ ...TOKENS }));
  listConnections = vi.fn(async () => clone(ONE_ORG));
  revokeRefreshToken = vi.fn(async () => {});
  requireFromHere.cache[oauthPath]!.exports = {
    ...oauth,
    exchangeCode: (...a: unknown[]) => exchangeCode(...a),
    listConnections: (...a: unknown[]) => listConnections(...a),
    revokeRefreshToken: (...a: unknown[]) => revokeRefreshToken(...a),
  };

  // In-memory token-store — handlers never open a DB connection in tests.
  connState = { row: null };
  requireFromHere.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      getConnection: vi.fn(async () => (connState.row ? { ...connState.row } : null)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decryptTokens: vi.fn((row: any) => ({ accessToken: row.__plainAccess, refreshToken: row.__plainRefresh })),
      replaceConnection: vi.fn(async ({ tokens }: { tokens: typeof TOKENS }) => {
        connState.row = { ...pendingRow(), __plainAccess: tokens.accessToken, __plainRefresh: tokens.refreshToken };
        return { ...connState.row };
      }),
      selectOrganisation: vi.fn(
        async ({ id, externalTenantId, externalTenantName }: { id: string; externalTenantId: string; externalTenantName: string }) => {
          if (!connState.row || connState.row.id !== id || connState.row.status !== "pending_selection") return null;
          Object.assign(connState.row, {
            external_tenant_id: externalTenantId,
            external_tenant_name: externalTenantName,
            status: "connected",
            connected_at: new Date().toISOString(),
            last_success_at: new Date().toISOString(),
          });
          return { ...connState.row };
        }
      ),
      rotateTokens: vi.fn(async () => (connState.row ? { ...connState.row } : null)),
      markFailure: vi.fn(async () => (connState.row ? { ...connState.row } : null)),
      touchSuccess: vi.fn(async () => {}),
      deleteConnection: vi.fn(async () => {
        connState.row = null;
      }),
    },
  } as NodeJS.Module;

  handlers = {
    connect: requireFromHere(connectPath),
    callback: requireFromHere(callbackPath),
    status: requireFromHere(statusPath),
    organisations: requireFromHere(organisationsPath),
    disconnect: requireFromHere(disconnectPath),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FLAG_XERO_CONNECTION;
});

describe("gates (every route)", () => {
  it("anonymous → 401; non-admin → 403; flag off → 404", async () => {
    for (const h of [handlers.connect, handlers.status]) {
      expect((await call(h, { method: "GET", anon: true })).statusCode).toBe(401);
      expect((await call(h, { method: "GET", role: "electrician", userId: "u_field" })).statusCode).toBe(403);
    }
    process.env.FLAG_XERO_CONNECTION = "0";
    expect((await call(handlers.connect, { method: "GET" })).statusCode).toBe(404);
    expect((await call(handlers.status, { method: "GET" })).statusCode).toBe(404);
    expect((await call(handlers.disconnect, { method: "POST" })).statusCode).toBe(404);
    expect((await call(handlers.organisations, { method: "GET" })).statusCode).toBe(404);
  });

  it("unconfigured environment is honest, with presence booleans only", async () => {
    delete process.env.XERO_CLIENT_SECRET;
    const res = await call(handlers.connect, { method: "GET" });
    expect(res.statusCode).toBe(503);
    const body = res.body as { config: Record<string, boolean> };
    expect(body.config.clientSecret).toBe(false);
    expect(body.config.clientId).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("client-id-1");
  });
});

describe("GET /api/xero/connect", () => {
  it("302s to Xero with a verifiable state and no secret", async () => {
    const res = await call(handlers.connect, { method: "GET" });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location!);
    expect(loc.origin + loc.pathname).toBe("https://login.xero.com/identity/connect/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://buhlos.com/api/xero/callback");
    const state = loc.searchParams.get("state")!;
    expect(oauth.verifyState(state, "u_boss")).toBeTruthy();
    expect(oauth.verifyState(state, "u_field")).toBeNull();
    expect(res.headers.location).not.toContain("client-secret-1");
    expect(auditEntries().some((e) => e.action === "xero.connect_started")).toBe(true);
  });
});

describe("GET /api/xero/callback", () => {
  const settings = "/settings/integrations/xero";

  it("consent denial redirects honestly, nothing stored", async () => {
    const res = await call(handlers.callback, { method: "GET", query: { error: "access_denied" } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${settings}?xero_error=consent_denied`);
    expect(connState.row).toBeNull();
  });

  it("invalid, expired-shape and foreign states are rejected", async () => {
    const bad = await call(handlers.callback, { method: "GET", query: { state: "garbage", code: "c" } });
    expect(bad.headers.location).toBe(`${settings}?xero_error=invalid_state`);
    // a state minted for another admin fails the binding check
    const foreign = oauth.makeState("u_other_admin");
    const res = await call(handlers.callback, { method: "GET", query: { state: foreign, code: "c" } });
    expect(res.headers.location).toBe(`${settings}?xero_error=invalid_state`);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("missing code is rejected after a valid state", async () => {
    const state = oauth.makeState("u_boss");
    const res = await call(handlers.callback, { method: "GET", query: { state } });
    expect(res.headers.location).toBe(`${settings}?xero_error=missing_code`);
  });

  it("single organisation: exchanges, stores encrypted, auto-selects, verifies", async () => {
    const state = oauth.makeState("u_boss");
    const res = await call(handlers.callback, { method: "GET", query: { state, code: "code-1" } });
    expect(res.headers.location).toBe(`${settings}?xero_result=connected`);
    expect(connState.row.status).toBe("connected");
    expect(connState.row.external_tenant_name).toBe("Buhl Electrical");
    const actions = auditEntries().map((e) => e.action);
    expect(actions).toContain("xero.connected");
    expect(actions).toContain("xero.organisation_selected");
    // no token material in the redirect or the audit journal
    const journal = JSON.stringify([...blobStore.entries()].filter(([k]) => k.startsWith("audit/")));
    expect(res.headers.location).not.toContain(TOKENS.accessToken);
    expect(journal).not.toContain(TOKENS.accessToken);
    expect(journal).not.toContain(TOKENS.refreshToken);
    expect(journal).not.toContain("code-1");
  });

  it("multiple organisations: never silently picks — pending explicit selection", async () => {
    listConnections.mockResolvedValue(clone(TWO_ORGS));
    const state = oauth.makeState("u_boss");
    const res = await call(handlers.callback, { method: "GET", query: { state, code: "code-1" } });
    expect(res.headers.location).toBe(`${settings}?xero_result=select_organisation`);
    expect(connState.row.status).toBe("pending_selection");
    expect(connState.row.external_tenant_id).toBeNull();
  });

  it("zero organisations / exchange failure / storage failure are honest", async () => {
    listConnections.mockResolvedValue([]);
    let res = await call(handlers.callback, { method: "GET", query: { state: oauth.makeState("u_boss"), code: "c" } });
    expect(res.headers.location).toBe(`${settings}?xero_error=no_organisations`);
    expect(connState.row).toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { XeroError } = requireFromHere(errorsPath);
    exchangeCode.mockRejectedValueOnce(new XeroError("validation", { status: 400 }));
    res = await call(handlers.callback, { method: "GET", query: { state: oauth.makeState("u_boss"), code: "c" } });
    expect(res.headers.location).toBe(`${settings}?xero_error=exchange_validation`);

    listConnections.mockResolvedValue(clone(ONE_ORG));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (requireFromHere.cache[storePath]!.exports as any).replaceConnection.mockRejectedValueOnce(new Error("db down"));
    res = await call(handlers.callback, { method: "GET", query: { state: oauth.makeState("u_boss"), code: "c" } });
    expect(res.headers.location).toBe(`${settings}?xero_error=persistence`);
  });

  it("feature dark: no processing, safe redirect only", async () => {
    process.env.FLAG_XERO_CONNECTION = "0";
    const res = await call(handlers.callback, { method: "GET", query: { state: "x", code: "c" } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(settings);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(connState.row).toBeNull();
  });
});

describe("organisation selection", () => {
  beforeEach(async () => {
    listConnections.mockResolvedValue(clone(TWO_ORGS));
    await call(handlers.callback, { method: "GET", query: { state: oauth.makeState("u_boss"), code: "c" } });
  });

  it("GET lists names + tenant ids only", async () => {
    const res = await call(handlers.organisations, { method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ organisations: TWO_ORGS });
    expect(JSON.stringify(res.body)).not.toContain(TOKENS.accessToken);
  });

  it("POST rejects a tenant id that is not in the authorised list", async () => {
    const res = await call(handlers.organisations, { method: "POST", body: { tenantId: "org-evil" } });
    expect(res.statusCode).toBe(400);
    expect(connState.row.status).toBe("pending_selection");
  });

  it("POST confirms an authorised organisation and audits the choice", async () => {
    const res = await call(handlers.organisations, { method: "POST", body: { tenantId: "org-2" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, organisationName: "Buhl Holdings" });
    expect(connState.row.status).toBe("connected");
    const selected = auditEntries().filter((e) => e.action === "xero.organisation_selected");
    expect(selected.length).toBe(1);
    expect(selected[0]!.metadata).toMatchObject({ externalTenantId: "org-2", auto: false });
  });

  it("selection endpoints 409 when nothing is pending", async () => {
    await call(handlers.organisations, { method: "POST", body: { tenantId: "org-2" } });
    expect((await call(handlers.organisations, { method: "GET" })).statusCode).toBe(409);
    expect((await call(handlers.organisations, { method: "POST", body: { tenantId: "org-1" } })).statusCode).toBe(409);
  });

  it("non-admin cannot select a tenant", async () => {
    const res = await call(handlers.organisations, {
      method: "POST",
      role: "electrician",
      userId: "u_field",
      body: { tenantId: "org-2" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("status + disconnect", () => {
  it("GET status reports disconnected / connected honestly, without token material", async () => {
    let res = await call(handlers.status, { method: "GET" });
    expect((res.body as { state: string }).state).toBe("disconnected");

    await call(handlers.callback, { method: "GET", query: { state: oauth.makeState("u_boss"), code: "c" } });
    res = await call(handlers.status, { method: "GET" });
    const body = res.body as Record<string, unknown>;
    expect(body.state).toBe("connected");
    expect(body.organisationName).toBe("Buhl Electrical");
    const s = JSON.stringify(body);
    expect(s).not.toContain(TOKENS.accessToken);
    expect(s).not.toContain(TOKENS.refreshToken);
    expect(s).not.toContain("v1.enc");
    expect(s).not.toContain("token_enc");
  });

  it("GET status reports not_configured with presence booleans", async () => {
    delete process.env.XERO_CLIENT_ID;
    const res = await call(handlers.status, { method: "GET" });
    const body = res.body as { state: string; config: Record<string, boolean> };
    expect(body.state).toBe("not_configured");
    expect(body.config.clientId).toBe(false);
  });

  it("POST check runs the harmless read and reports failure as state, not 500", async () => {
    await call(handlers.callback, { method: "GET", query: { state: oauth.makeState("u_boss"), code: "c" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [],
    })));
    let res = await call(handlers.status, { method: "POST", body: { action: "check" } });
    expect((res.body as { lastCheck: { ok: boolean } }).lastCheck.ok).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("down"), { name: "TypeError" });
    }));
    res = await call(handlers.status, { method: "POST", body: { action: "check" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { lastCheck: { ok: boolean; errorCategory: string } }).lastCheck).toEqual({
      ok: false,
      errorCategory: "network",
    });
    expect(auditEntries().some((e) => e.action === "xero.connection_checked")).toBe(true);
  });

  it("disconnect: revokes, hard-deletes, audits BEFORE the delete; revocation failure still disconnects", async () => {
    await call(handlers.callback, { method: "GET", query: { state: oauth.makeState("u_boss"), code: "c" } });
    let res = await call(handlers.disconnect, { method: "POST" });
    expect(res.body).toEqual({ ok: true, revokedAtProvider: true });
    expect(revokeRefreshToken).toHaveBeenCalledWith(TOKENS.refreshToken);
    expect(connState.row).toBeNull();
    expect(auditEntries().some((e) => e.action === "xero.disconnected")).toBe(true);

    // reconnect, then a failing revocation still deletes locally + says so
    await call(handlers.callback, { method: "GET", query: { state: oauth.makeState("u_boss"), code: "c" } });
    revokeRefreshToken.mockRejectedValueOnce(new Error("xero down"));
    res = await call(handlers.disconnect, { method: "POST" });
    expect(res.body).toEqual({ ok: true, revokedAtProvider: false });
    expect(connState.row).toBeNull();

    // disconnecting again → honest 409
    expect((await call(handlers.disconnect, { method: "POST" })).statusCode).toBe(409);
  });
});
