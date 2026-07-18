import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/xero-sync-log.js (#251) — real handler + REAL recorder over faked
 * blob, with auth/flags/audit/bridge faked at the module seam. Pins: admin
 * gate + flag-dark 404, state read, month-history read + validation, ack
 * requires a note + audits, retry through the registry only (404 when not
 * open), and sequential retry_all.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const bridgePath = requireFromHere.resolve("../../../api/_lib/xero/sync-log-bridge.js");
const recorderPath = requireFromHere.resolve("../../../api/_lib/xero-sync-log.js");
const handlerPath = requireFromHere.resolve("../../../api/xero-sync-log.js");

type Res = ReturnType<typeof createRes>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recorder: any;
let blob: Map<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let authUser: any;
let flagOn: boolean;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auditCalls: any[];

const ADMIN = { id: "u_boss", username: "boss", role: "admin" };

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
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
async function call(opts: { method: string; query?: Record<string, string>; body?: unknown }): Promise<Res> {
  const res = createRes();
  await handler({ method: opts.method, query: opts.query || {}, headers: {}, body: opts.body }, res);
  return res;
}

async function seedFailure(operation = "tsx:b-1") {
  await recorder.record({
    syncType: "timesheet_export",
    operation,
    recordRef: "b-1",
    status: "failed",
    reason: "1 of 2 workers not landed",
    category: "period_locked",
  });
}

beforeEach(() => {
  blob = new Map();
  authUser = ADMIN;
  flagOn = true;
  auditCalls = [];

  for (const p of [handlerPath, recorderPath]) delete requireFromHere.cache[p];
  const fake = (path: string, exports: unknown) => {
    requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
  };
  fake(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
    writeBlob: vi.fn(async (key: string, data: unknown) => {
      blob.set(key, clone(data));
    }),
    setNoCache: vi.fn(),
  });
  fake(authPath, {
    requireAuth: vi.fn(async (_req: unknown, res: Res) => {
      if (authUser) return authUser;
      res.status(401).json({ error: "unauthorised" });
      return null;
    }),
  });
  fake(ffPath, { isFlagEnabled: vi.fn(async () => flagOn) });
  fake(auditPath, {
    append: vi.fn(async (p: unknown) => {
      auditCalls.push(p);
      return { id: "al_x" };
    }),
  });
  fake(bridgePath, {}); // registration is the real bridge's job; retries here use test handlers

  handler = requireFromHere(handlerPath);
  recorder = requireFromHere(recorderPath);
  recorder._resetForTests();
});

describe("api/xero-sync-log (#251)", () => {
  it("requires auth and is 404-dark without xero_connection", async () => {
    authUser = null;
    expect((await call({ method: "GET" })).statusCode).toBe(401);

    authUser = ADMIN;
    flagOn = false;
    expect((await call({ method: "GET" })).statusCode).toBe(404);
  });

  it("GET returns the open working set with counts + freshness", async () => {
    await seedFailure();
    await recorder.record({ syncType: "reference_sync", operation: "ref:employees", recordRef: "employees", status: "ok" });
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(200);
    const body = res.body as { items: unknown[]; counts: { total: number }; lastSuccessAt: Record<string, string> };
    expect(body.items).toHaveLength(1);
    expect(body.counts.total).toBe(1);
    expect(body.lastSuccessAt.reference_sync).toBeTruthy();
  });

  it("GET ?month validates and returns terminal history", async () => {
    expect((await call({ method: "GET", query: { month: "july" } })).statusCode).toBe(400);
    await seedFailure();
    await recorder.resolve("tsx:b-1");
    const month = new Date().toISOString().slice(0, 7);
    const res = await call({ method: "GET", query: { month } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { entries: Array<{ outcome: string }> }).entries.at(-1)).toMatchObject({ outcome: "resolved" });
  });

  it("acknowledge requires a note, closes the item, audits", async () => {
    await seedFailure();
    expect(
      (await call({ method: "POST", body: { action: "acknowledge", operation: "tsx:b-1", note: "  " } })).statusCode,
    ).toBe(400);
    const res = await call({
      method: "POST",
      body: { action: "acknowledge", operation: "tsx:b-1", note: "paid manually" },
    });
    expect(res.statusCode).toBe(200);
    expect((await recorder.openState()).items).toHaveLength(0);
    expect(auditCalls.some((c) => c.action === "xero.sync_acknowledged")).toBe(true);
  });

  it("retry 404s when not open; runs the registered handler when open", async () => {
    expect((await call({ method: "POST", body: { action: "retry", operation: "tsx:nope" } })).statusCode).toBe(404);

    await seedFailure();
    recorder.registerRetryHandler("timesheet_export", vi.fn(async () => ({ outcome: "resolved", reason: "landed" })));
    const res = await call({ method: "POST", body: { action: "retry", operation: "tsx:b-1" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { outcome: string }).outcome).toBe("resolved");
    expect(auditCalls.some((c) => c.action === "xero.sync_retried")).toBe(true);
  });

  it("retry_all runs sequentially over every open item", async () => {
    await seedFailure("tsx:b-1");
    await seedFailure("tsx:b-2");
    const handlerFn = vi.fn(async () => ({ outcome: "resolved", reason: "landed" }));
    recorder.registerRetryHandler("timesheet_export", handlerFn);
    const res = await call({ method: "POST", body: { action: "retry_all" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { outcomes: Array<{ outcome: string }>; pausedOnRateLimit: boolean };
    expect(body.outcomes).toHaveLength(2);
    expect(body.pausedOnRateLimit).toBe(false);
    expect(handlerFn).toHaveBeenCalledTimes(2);
    expect((await recorder.openState()).items).toHaveLength(0);
  });
});
