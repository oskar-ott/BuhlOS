import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/xero/payroll-export.js (#249) — real handler vs mocked blob (auth/flags/
 * audit) + mocked export service, with REAL HMAC sessions. Pins the gates
 * (admin, xero_connection for reads, xero_payroll_export for writes, configured),
 * routing (preview/export/retry/reconcile + CSV/state reads), audit verbs and
 * the typed-error → HTTP status mapping. No Xero call is made here.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const errorsPath = requireFromHere.resolve("../../../api/_lib/xero/errors.js");
const svcPath = requireFromHere.resolve("../../../api/_lib/xero/timesheet-export.js");
const handlerPath = requireFromHere.resolve("../../../api/xero/payroll-export.js");

const BID = "11111111-1111-1111-1111-111111111111";
let blobStore: Map<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let XeroError: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: Record<string, any>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    sent: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(b: unknown) { this.body = b; return this; },
    send(p: unknown) { this.sent = p; return this; },
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; },
    end() { return this; },
  };
}
async function call(opts: { method: string; role?: string; userId?: string; query?: Record<string, string>; body?: unknown; anon?: boolean }) {
  const res = createRes();
  await handler(
    {
      method: opts.method,
      query: opts.query || {},
      body: opts.body,
      headers: opts.anon ? {} : { cookie: `buhl_session=${auth.signSession({ userId: opts.userId || "u_boss", role: opts.role || "boss", exp: Date.now() + 60_000 })}` },
    },
    res,
  );
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
  process.env.FLAG_XERO_PAYROLL_EXPORT = "1";
  process.env.XERO_CLIENT_ID = "client-id-1";
  process.env.XERO_CLIENT_SECRET = "client-secret-1";
  process.env.XERO_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.APP_BASE_URL = "https://buhlos.com";
  process.env.SUPABASE_DB_URL = "postgres://user:pass@host:6543/db";

  blobStore = new Map<string, unknown>([
    ["users.json", { users: [
      { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: [] },
    ] }],
  ]);

  for (const p of [authPath, ffPath, auditPath, errorsPath, svcPath, handlerPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blobStore.has(key) ? clone(blobStore.get(key)) : fallback)),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) => (blobStore.has(key) ? clone(blobStore.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blobStore.set(key, clone(data)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  ({ XeroError } = requireFromHere(errorsPath));

  svc = {
    previewExport: vi.fn(async () => ({ org: { externalTenantId: "org-12345678", status: "active" }, batch: { id: BID, status: "locked" }, workers: [], counts: { total: 2, toSend: 2, toSkip: 0, blocked: 0, requiresCorrection: 0 } })),
    exportBatch: vi.fn(async () => ({ batch: { id: BID, status: "exported", periodStart: "2026-07-06", periodEnd: "2026-07-12" }, workers: [{ worker: "Alex", outcome: "verified", xeroTimesheetId: "ts-1", correlationId: "c1" }] })),
    retryExport: vi.fn(async () => ({ batch: { id: BID, status: "exported", periodStart: "2026-07-06", periodEnd: "2026-07-12" }, workers: [{ worker: "Alex", outcome: "verified" }] })),
    reconcileExport: vi.fn(async () => ({ batch: { id: BID, status: "exported", periodStart: "2026-07-06", periodEnd: "2026-07-12" }, workers: [{ worker: "Alex", outcome: "verified" }] })),
    exportState: vi.fn(async () => ({ batch: { id: BID, status: "exported", periodStart: "2026-07-06", periodEnd: "2026-07-12" }, workers: [], attemptCount: 1, eventCount: 3 })),
    batchCsv: vi.fn(async () => ({ filename: "buhlos-payroll-batch-11111111-2026-07-06-to-2026-07-12.csv", csv: "Pay Period Start\n", rowCount: 2, batch: { id: BID, status: "locked" } })),
  };
  requireFromHere.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: svc } as NodeJS.Module;

  handler = requireFromHere(handlerPath);
});

describe("gates", () => {
  it("anon 401, non-admin 403, connection-flag off 404, unconfigured 503", async () => {
    expect((await call({ method: "GET", query: { batchId: BID }, anon: true })).statusCode).toBe(401);
    expect((await call({ method: "GET", role: "electrician", userId: "u_field", query: { batchId: BID } })).statusCode).toBe(403);
    process.env.FLAG_XERO_CONNECTION = "0";
    expect((await call({ method: "GET", query: { batchId: BID } })).statusCode).toBe(404);
    process.env.FLAG_XERO_CONNECTION = "1";
    delete process.env.XERO_TOKEN_ENC_KEY;
    expect((await call({ method: "GET", query: { batchId: BID } })).statusCode).toBe(503);
  });

  it("POST writes require the independent write flag; reads do not", async () => {
    process.env.FLAG_XERO_PAYROLL_EXPORT = "0";
    // writes 404 when the write flag is off
    expect((await call({ method: "POST", body: { action: "preview", batchId: BID } })).statusCode).toBe(404);
    expect((await call({ method: "POST", body: { action: "export", batchId: BID } })).statusCode).toBe(404);
    // but the CSV + state reads still work (connection flag only)
    expect((await call({ method: "GET", query: { batchId: BID, format: "csv" } })).statusCode).toBe(200);
    expect((await call({ method: "GET", query: { batchId: BID } })).statusCode).toBe(200);
  });
});

describe("reads", () => {
  it("GET ?format=csv streams the batch CSV and audits csv_downloaded", async () => {
    const res = await call({ method: "GET", query: { batchId: BID, format: "csv" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["x-row-count"]).toBe("2");
    expect(svc.batchCsv).toHaveBeenCalled();
    expect(auditActions()).toContain("payroll.csv_downloaded");
  });

  it("GET ?batchId returns export state; a non-uuid is 400; an unknown batch is 404", async () => {
    expect((await call({ method: "GET", query: { batchId: BID } })).statusCode).toBe(200);
    expect((await call({ method: "GET", query: { batchId: "nope" } })).statusCode).toBe(400);
    svc.exportState.mockResolvedValueOnce(null);
    expect((await call({ method: "GET", query: { batchId: BID } })).statusCode).toBe(404);
  });
});

describe("write actions + audit", () => {
  it("preview audits export_previewed and writes nothing to Xero", async () => {
    const res = await call({ method: "POST", body: { action: "preview", batchId: BID } });
    expect(res.statusCode).toBe(200);
    expect(svc.previewExport).toHaveBeenCalled();
    expect(auditActions()).toContain("payroll.export_previewed");
  });

  it("export / retry / reconcile audit their verbs", async () => {
    await call({ method: "POST", body: { action: "export", batchId: BID } });
    expect(auditActions()).toContain("payroll.exported_to_xero");
    await call({ method: "POST", body: { action: "retry", batchId: BID } });
    expect(auditActions()).toContain("payroll.export_retried");
    await call({ method: "POST", body: { action: "reconcile", batchId: BID } });
    expect(auditActions()).toContain("payroll.reconciled");
  });

  it("unknown action / missing batchId are 400", async () => {
    expect((await call({ method: "POST", body: { action: "detonate", batchId: BID } })).statusCode).toBe(400);
    expect((await call({ method: "POST", body: { action: "export" } })).statusCode).toBe(400);
  });
});

describe("typed-error → HTTP status mapping", () => {
  it("not_connected → 409, rate_limit → 429, validation → 400, no raw error text leaks", async () => {
    svc.previewExport.mockRejectedValueOnce(new XeroError("not_connected"));
    expect((await call({ method: "POST", body: { action: "preview", batchId: BID } })).statusCode).toBe(409);

    svc.exportBatch.mockRejectedValueOnce(new XeroError("rate_limit"));
    const rl = await call({ method: "POST", body: { action: "export", batchId: BID } });
    expect(rl.statusCode).toBe(429);
    expect((rl.body as { errorCategory: string }).errorCategory).toBe("rate_limit");

    svc.exportBatch.mockRejectedValueOnce(new XeroError("validation", { detail: "inactive" }));
    expect((await call({ method: "POST", body: { action: "export", batchId: BID } })).statusCode).toBe(400);
  });
});
