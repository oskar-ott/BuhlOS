import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/xero/worker-mappings.js (#248) — the real handler vs mocked blob
 * (auth/flags/audit) + a mocked mapping lib, with REAL HMAC sessions:
 * gates, board GET, confirm (incl. the NAMED 1:1 conflict and the inactive-
 * employee warning), unlink, audit rows, and input validation.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const errorsPath = requireFromHere.resolve("../../../api/_lib/xero/errors.js");
const libPath = requireFromHere.resolve("../../../api/_lib/xero/worker-mappings.js");
const handlerPath = requireFromHere.resolve("../../../api/xero/worker-mappings.js");

let blobStore: Map<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let XeroError: any;
let getWorkerMappingBoard: ReturnType<typeof vi.fn>;
let confirmMapping: ReturnType<typeof vi.fn>;
let removeMapping: ReturnType<typeof vi.fn>;

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
async function call(opts: { method: string; role?: string; userId?: string; body?: unknown; anon?: boolean }) {
  const res = createRes();
  await handler(
    {
      method: opts.method,
      query: {},
      body: opts.body,
      headers: opts.anon
        ? {}
        : { cookie: `buhl_session=${auth.signSession({ userId: opts.userId || "u_boss", role: opts.role || "boss", exp: Date.now() + 60_000 })}` },
    },
    res
  );
  return res;
}
function auditActions(): Array<{ action: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown> }> {
  const month = new Date().toISOString().slice(0, 7);
  const doc = blobStore.get(`audit/${month}.json`) as { entries?: Array<{ action: string }> } | undefined;
  return (doc?.entries as Array<{ action: string; targetType?: string; targetId?: string }>) || [];
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

  for (const p of [authPath, ffPath, auditPath, errorsPath, libPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }
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

  getWorkerMappingBoard = vi.fn(async () => ({
    organisationName: "Demo Company (AU)",
    workers: [{ workerId: "w1", workerName: "Karen", mapping: null, suggestion: null, invalidLegacyId: null, legacyConflictWith: [] }],
    unmappedCount: 1,
    employees: [{ xeroId: "emp-1", name: "Karen Buhl", active: true, email: null, status: "ACTIVE" }],
    employeeCache: { count: 1, lastSync: { at: "t", status: "ok", errorCategory: null }, trustworthy: true },
  }));
  confirmMapping = vi.fn(async () => ({
    mapping: { source: "manual" },
    workerName: "Karen",
    employeeName: "Karen Buhl",
    employeeInactive: false,
    previousEmployeeId: null,
  }));
  removeMapping = vi.fn(async () => ({ xero_id: "emp-1", xero_name_snapshot: "Karen Buhl" }));
  requireFromHere.cache[libPath] = {
    id: libPath, filename: libPath, loaded: true,
    exports: {
      getWorkerMappingBoard: (...a: unknown[]) => getWorkerMappingBoard(...a),
      confirmMapping: (...a: unknown[]) => confirmMapping(...a),
      removeMapping: (...a: unknown[]) => removeMapping(...a),
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
    delete process.env.XERO_CLIENT_SECRET;
    expect((await call({ method: "GET" })).statusCode).toBe(503);
  });
});

describe("GET board", () => {
  it("returns the board; not-connected maps to 409", async () => {
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { unmappedCount: number }).unmappedCount).toBe(1);
    getWorkerMappingBoard.mockRejectedValueOnce(new XeroError("not_connected"));
    expect((await call({ method: "GET" })).statusCode).toBe(409);
  });
});

describe("POST map / unmap", () => {
  it("confirms a link and writes the audit row", async () => {
    const res = await call({ method: "POST", body: { action: "map", workerId: "w1", employeeId: "emp-1", source: "email_suggestion" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, employeeName: "Karen Buhl", remapped: false });
    expect(confirmMapping).toHaveBeenCalledWith(expect.objectContaining({ workerId: "w1", employeeId: "emp-1", source: "email_suggestion" }));
    const rows = auditActions().filter((e) => e.action === "xero.worker_mapped");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: "xero_mapping", targetId: "w1" });
  });

  it("a 1:1 conflict returns 409 naming the existing holder", async () => {
    const err = new XeroError("conflict", { detail: "employee_already_linked" });
    err.conflictWith = { workerId: "w2", workerName: "Daniel" };
    confirmMapping.mockRejectedValueOnce(err);
    const res = await call({ method: "POST", body: { action: "map", workerId: "w1", employeeId: "emp-1" } });
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("Daniel");
    expect(auditActions().some((e) => e.action === "xero.worker_mapped")).toBe(false);
  });

  it("an inactive employee confirm succeeds with the warning surfaced", async () => {
    confirmMapping.mockResolvedValueOnce({
      mapping: { source: "manual" }, workerName: "Old Mate", employeeName: "Old Mate",
      employeeInactive: true, previousEmployeeId: null,
    });
    const res = await call({ method: "POST", body: { action: "map", workerId: "w_old", employeeId: "emp-old" } });
    expect(res.body).toMatchObject({ ok: true, employeeInactive: true });
  });

  it("unmap removes and audits; nothing-to-remove is 404", async () => {
    const res = await call({ method: "POST", body: { action: "unmap", workerId: "w1" } });
    expect(res.statusCode).toBe(200);
    expect(auditActions().some((e) => e.action === "xero.worker_unmapped")).toBe(true);
    removeMapping.mockResolvedValueOnce(null);
    expect((await call({ method: "POST", body: { action: "unmap", workerId: "w1" } })).statusCode).toBe(404);
  });

  it("validates inputs: missing workerId/employeeId, unknown action", async () => {
    expect((await call({ method: "POST", body: { action: "map", employeeId: "emp-1" } })).statusCode).toBe(400);
    expect((await call({ method: "POST", body: { action: "map", workerId: "w1" } })).statusCode).toBe(400);
    expect((await call({ method: "POST", body: { action: "link_everyone", workerId: "w1" } })).statusCode).toBe(400);
  });
});
