import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/xero/payroll-batches.js (#893/#894) — real handler vs mocked blob
 * (auth/flags/audit) + mocked batch service, with REAL HMAC sessions: gates,
 * preview/create/lock/unlock/delete, correction creation, honest 409 codes
 * (source drift / validation regression / lost lock race), and audit rows.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const errorsPath = requireFromHere.resolve("../../../api/_lib/xero/errors.js");
const libPath = requireFromHere.resolve("../../../api/_lib/xero/payroll-batches.js");
const handlerPath = requireFromHere.resolve("../../../api/xero/payroll-batches.js");

let blobStore: Map<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let XeroError: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: Record<string, any>;

const BATCH = {
  id: "batch-1",
  status: "ready",
  period_start: "2026-07-06",
  period_end: "2026-07-12",
  item_count: 2,
  total_hours: 10,
  source_hash: "hash-1",
  revision: 1,
};
const VALIDATION = { ready: true, errors: [], warnings: [], summary: { approvedRowCount: 1, workerCount: 1, totalHours: 10, ordinaryHours: 8, overtimeHours: 2 } };

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(b: unknown) { this.body = b; return this; },
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
    res
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

  for (const p of [authPath, ffPath, auditPath, errorsPath, libPath, handlerPath]) delete requireFromHere.cache[p];
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
    previewBatch: vi.fn(async () => ({ periodStart: "2026-07-06", periodEnd: "2026-07-12", validation: clone(VALIDATION), items: [], sourceHash: "hash-1" })),
    createBatch: vi.fn(async () => ({ batch: clone(BATCH), validation: clone(VALIDATION), items: [] })),
    lockBatch: vi.fn(async () => ({ batch: { ...clone(BATCH), status: "locked" }, validation: clone(VALIDATION) })),
    unlockBatch: vi.fn(async () => ({ ...clone(BATCH), status: "ready" })),
    deleteBatch: vi.fn(async () => clone(BATCH)),
    listBatches: vi.fn(async () => [clone(BATCH)]),
    getBatch: vi.fn(async () => ({ batch: clone(BATCH), items: [], events: [] })),
  };
  requireFromHere.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: svc } as NodeJS.Module;

  handler = requireFromHere(handlerPath);
});

describe("gates + reads", () => {
  it("anon 401, non-admin 403, flag off 404, unconfigured 503", async () => {
    expect((await call({ method: "GET", anon: true })).statusCode).toBe(401);
    expect((await call({ method: "GET", role: "electrician", userId: "u_field" })).statusCode).toBe(403);
    process.env.FLAG_XERO_CONNECTION = "0";
    expect((await call({ method: "GET" })).statusCode).toBe(404);
    process.env.FLAG_XERO_CONNECTION = "1";
    delete process.env.XERO_TOKEN_ENC_KEY;
    expect((await call({ method: "GET" })).statusCode).toBe(503);
  });

  it("GET lists, GET ?id returns detail, unknown id 404", async () => {
    expect(((await call({ method: "GET" })).body as { batches: unknown[] }).batches).toHaveLength(1);
    expect((await call({ method: "GET", query: { id: "batch-1" } })).statusCode).toBe(200);
    svc.getBatch.mockResolvedValueOnce(null);
    expect((await call({ method: "GET", query: { id: "nope" } })).statusCode).toBe(404);
  });
});

describe("POST actions", () => {
  it("preview validates without persisting; bad dates 400", async () => {
    const res = await call({ method: "POST", body: { action: "preview", periodStart: "2026-07-06", periodEnd: "2026-07-12" } });
    expect(res.statusCode).toBe(200);
    expect(svc.previewBatch).toHaveBeenCalled();
    expect((await call({ method: "POST", body: { action: "preview", periodStart: "bad", periodEnd: "2026-07-12" } })).statusCode).toBe(400);
    expect((await call({ method: "POST", body: { action: "preview", periodStart: "2026-07-12", periodEnd: "2026-07-06" } })).statusCode).toBe(400);
  });

  it("create audits payroll.batch_created; correction audits its own verb", async () => {
    await call({ method: "POST", body: { action: "create", periodStart: "2026-07-06", periodEnd: "2026-07-12" } });
    expect(auditActions()).toContain("payroll.batch_created");
    await call({ method: "POST", body: { action: "create", periodStart: "2026-07-06", periodEnd: "2026-07-12", supersedesBatchId: "batch-0" } });
    expect(auditActions()).toContain("payroll.batch_correction_created");
    expect(svc.createBatch).toHaveBeenLastCalledWith(expect.objectContaining({ supersedesBatchId: "batch-0" }));
  });

  it("lock success audits; drift/validation/lost-race map to honest 409 codes", async () => {
    const res = await call({ method: "POST", body: { action: "lock", id: "batch-1" } });
    expect(res.statusCode).toBe(200);
    expect(auditActions()).toContain("payroll.batch_locked");

    for (const [detail, code] of [["source_drift", "source_drift"], ["validation_failed", "validation_failed"], ["lock_lost", "lock_lost"]] as const) {
      svc.lockBatch.mockRejectedValueOnce(new XeroError("conflict", { detail }));
      const r = await call({ method: "POST", body: { action: "lock", id: "batch-1" } });
      expect(r.statusCode).toBe(409);
      expect((r.body as { code: string }).code).toBe(code);
    }
  });

  it("unlock + delete audit their verbs; unknown action / missing id 400", async () => {
    await call({ method: "POST", body: { action: "unlock", id: "batch-1" } });
    expect(auditActions()).toContain("payroll.batch_unlocked");
    await call({ method: "POST", body: { action: "delete", id: "batch-1" } });
    expect(auditActions()).toContain("payroll.batch_deleted");
    expect((await call({ method: "POST", body: { action: "lock" } })).statusCode).toBe(400);
    expect((await call({ method: "POST", body: { action: "detonate", id: "batch-1" } })).statusCode).toBe(400);
  });

  it("not-connected surfaces as 409, never a fake empty state", async () => {
    svc.previewBatch.mockRejectedValueOnce(new XeroError("not_connected"));
    const res = await call({ method: "POST", body: { action: "preview", periodStart: "2026-07-06", periodEnd: "2026-07-12" } });
    expect(res.statusCode).toBe(409);
  });
});
