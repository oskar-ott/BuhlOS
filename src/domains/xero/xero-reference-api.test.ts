import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/xero/reference.js (#610) — the real handler vs a mocked blob store
 * (auth/flags/audit), a mocked token-store and a mocked sync service, with
 * REAL HMAC sessions. Gates, summary shape (+ scopesOk reconnect detection),
 * item lists, refresh happy/partial/could-not-start, audit record, and the
 * no-token-leak guarantee.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const configPath = requireFromHere.resolve("../../../api/_lib/xero/config.js");
const errorsPath = requireFromHere.resolve("../../../api/_lib/xero/errors.js");
const storePath = requireFromHere.resolve("../../../api/_lib/xero/token-store.js");
const refSyncPath = requireFromHere.resolve("../../../api/_lib/xero/reference-sync.js");
const handlerPath = requireFromHere.resolve("../../../api/xero/reference.js");

const FULL_SCOPES =
  "openid profile email offline_access payroll.employees.read payroll.settings.read accounting.settings.read";

let blobStore: Map<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connRow: any;
let syncReferenceData: ReturnType<typeof vi.fn>;
let getReferenceSummary: ReturnType<typeof vi.fn>;
let getReferenceItems: ReturnType<typeof vi.fn>;

const SUMMARY = {
  staleAfterDays: 7,
  groups: [
    { group: "employees", kinds: [{ kind: "employee", count: 3 }], lastSync: { at: "t", status: "ok", itemCount: 3, errorCategory: null, correlationId: null }, stale: false },
  ],
};

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
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
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    end() {
      return this;
    },
  };
}
async function call(opts: {
  method: string;
  role?: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon
      ? {}
      : {
          cookie: `buhl_session=${auth.signSession({ userId: opts.userId || "u_boss", role: opts.role || "boss", exp: Date.now() + 60_000 })}`,
        },
  };
  await handler(req, res);
  return res;
}
function auditActions(): string[] {
  const month = new Date().toISOString().slice(0, 7);
  const doc = blobStore.get(`audit/${month}.json`) as { entries?: Array<{ action: string }> } | undefined;
  return (doc?.entries || []).map((e) => e.action);
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

  for (const p of [authPath, ffPath, auditPath, configPath, errorsPath, storePath, refSyncPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blobStore.has(key) ? clone(blobStore.get(key)) : fallback)),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) => (blobStore.has(key) ? clone(blobStore.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blobStore.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { XeroError } = requireFromHere(errorsPath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__XeroError = XeroError;

  connRow = {
    id: "conn-1",
    tenant_id: "tenant-1",
    status: "connected",
    external_tenant_id: "org-1",
    external_tenant_name: "Buhl Electrical",
    granted_scopes: FULL_SCOPES,
    access_token_enc: "v1.enc.enc.enc",
    refresh_token_enc: "v1.enc.enc.enc",
  };
  requireFromHere.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      getConnection: vi.fn(async () => (connRow ? { ...connRow } : null)),
    },
  } as NodeJS.Module;

  syncReferenceData = vi.fn(async () => [
    { group: "employees", status: "ok", itemCount: 3 },
    { group: "calendars", status: "ok", itemCount: 1 },
  ]);
  getReferenceSummary = vi.fn(async () => clone(SUMMARY));
  getReferenceItems = vi.fn(async () => [
    { xeroId: "emp-1", name: "Karen Buhl", active: true, payload: { status: "ACTIVE" }, syncedAt: "t" },
  ]);
  requireFromHere.cache[refSyncPath] = {
    id: refSyncPath,
    filename: refSyncPath,
    loaded: true,
    exports: {
      SYNC_GROUPS: ["employees", "calendars", "pay_items", "tracking_categories"],
      GROUP_KINDS: {
        employees: ["employee"],
        calendars: ["payroll_calendar"],
        pay_items: ["earnings_rate", "leave_type", "deduction_type", "reimbursement_type"],
        tracking_categories: ["tracking_category"],
      },
      STALE_AFTER_DAYS: 7,
      syncReferenceData: (...a: unknown[]) => syncReferenceData(...a),
      getReferenceSummary: (...a: unknown[]) => getReferenceSummary(...a),
      getReferenceItems: (...a: unknown[]) => getReferenceItems(...a),
    },
  } as NodeJS.Module;

  handler = requireFromHere(handlerPath);
});

describe("gates", () => {
  it("anon 401, non-admin 403, flag off 404, unconfigured 503", async () => {
    expect((await call({ method: "GET", anon: true })).statusCode).toBe(401);
    expect((await call({ method: "GET", role: "electrician", userId: "u_field" })).statusCode).toBe(403);
    process.env.FLAG_XERO_CONNECTION = "0";
    expect((await call({ method: "GET" })).statusCode).toBe(404);
    process.env.FLAG_XERO_CONNECTION = "1";
    delete process.env.XERO_CLIENT_ID;
    expect((await call({ method: "GET" })).statusCode).toBe(503);
  });
});

describe("GET summary", () => {
  it("returns the summary + scopesOk + organisation, no token material", async () => {
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.scopesOk).toBe(true);
    expect(body.organisationName).toBe("Buhl Electrical");
    expect(Array.isArray(body.groups)).toBe(true);
    const s = JSON.stringify(body);
    expect(s).not.toContain("v1.enc");
    expect(s).not.toContain("token");
  });

  it("flags a pre-#610 grant (identity scopes only) as scopesOk=false", async () => {
    connRow.granted_scopes = "openid profile email offline_access";
    const res = await call({ method: "GET" });
    expect((res.body as { scopesOk: boolean }).scopesOk).toBe(false);
  });

  it("409s honestly when not connected", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const XeroError = (globalThis as any).__XeroError;
    getReferenceSummary.mockRejectedValueOnce(new XeroError("not_connected"));
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(409);
    expect((res.body as { errorCategory: string }).errorCategory).toBe("not_connected");
  });

  it("GET ?kind returns items for a valid kind and 400s an unknown one", async () => {
    const res = await call({ method: "GET", query: { kind: "employee" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { items: unknown[] }).items).toHaveLength(1);
    expect((await call({ method: "GET", query: { kind: "invoice" } })).statusCode).toBe(400);
  });
});

describe("POST refresh", () => {
  it("runs the sync, audits, returns per-group outcomes + fresh summary", async () => {
    const res = await call({ method: "POST", body: { action: "refresh" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; results: unknown[]; summary: unknown };
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.summary).toBeTruthy();
    expect(auditActions()).toContain("xero.reference_synced");
  });

  it("partial failure is honest: ok=false, failing group named, still 200", async () => {
    syncReferenceData.mockResolvedValueOnce([
      { group: "employees", status: "failed", errorCategory: "forbidden" },
      { group: "calendars", status: "ok", itemCount: 1 },
    ]);
    const res = await call({ method: "POST", body: { action: "refresh" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; results: Array<{ status: string }> };
    expect(body.ok).toBe(false);
    expect(body.results[0]).toMatchObject({ group: "employees", status: "failed", errorCategory: "forbidden" });
    expect(auditActions()).toContain("xero.reference_synced");
  });

  it("could-not-start (not connected / pending) maps to 409", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const XeroError = (globalThis as any).__XeroError;
    syncReferenceData.mockRejectedValueOnce(new XeroError("pending_selection"));
    const res = await call({ method: "POST", body: { action: "refresh" } });
    expect(res.statusCode).toBe(409);
  });

  it("filters unknown groups and rejects unknown actions", async () => {
    await call({ method: "POST", body: { action: "refresh", groups: ["employees", "invoices"] } });
    expect(syncReferenceData).toHaveBeenCalledWith(expect.objectContaining({ groups: ["employees"] }));
    expect((await call({ method: "POST", body: { action: "sync_everything" } })).statusCode).toBe(400);
  });
});
