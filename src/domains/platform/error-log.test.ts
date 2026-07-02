import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/_lib/error-log.js + api/_lib/error-wrap.js (#154) — the platform error
 * journal and the escaped-error handler wrapper. Real modules; only Blob is
 * injected (no network). Pins the contract:
 *   - entry shape + honest caps (message 500, stack 800, metadata ~1KB)
 *   - FIFO trim 5000 → 4000
 *   - stable fingerprint (handler|message|statusCode)
 *   - appendError NEVER throws (reporting must not take down the request)
 *   - withErrorCapture: normal path untouched; escaped throw → journal + 500;
 *     no double-send once headers have gone out.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const errorLogPath = requireFromHere.resolve("../../../api/_lib/error-log.js");
const errorWrapPath = requireFromHere.resolve("../../../api/_lib/error-wrap.js");

interface ErrorEntry {
  id: string;
  ts: string;
  source: string;
  handler: string;
  message: string;
  severity: string;
  statusCode: number | null;
  stack: string | null;
  userId: string | null;
  jobId: string | null;
  fingerprint: string;
  metadata?: { _truncated?: boolean; preview?: string } & Record<string, unknown>;
}

interface ErrorLogModule {
  appendError: (payload: Record<string, unknown>) => Promise<ErrorEntry | null>;
  readErrors: () => Promise<ErrorEntry[]>;
  fingerprintOf: (handler: string, message: string, statusCode: number | null) => string;
  ERRORS_KEY: string;
  MAX_ENTRIES: number;
  TRIM_TO: number;
}

interface ErrorWrapModule {
  withErrorCapture: (
    handler: (req: unknown, res: unknown) => Promise<unknown>,
    name: string,
  ) => (req: unknown, res: unknown) => Promise<unknown>;
  captureError: ErrorLogModule["appendError"];
}

let blob: Map<string, unknown>;
let writeShouldThrow: boolean;
let errorLog: ErrorLogModule;
let errorWrap: ErrorWrapModule;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function storedEntries(): ErrorEntry[] {
  const doc = blob.get("platform/errors.json") as { entries?: ErrorEntry[] } | undefined;
  return doc?.entries ?? [];
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

beforeEach(() => {
  blob = new Map();
  writeShouldThrow = false;
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        if (writeShouldThrow) throw new Error("blob down");
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as unknown as NodeJS.Module;

  delete requireFromHere.cache[errorLogPath];
  delete requireFromHere.cache[errorWrapPath];
  errorLog = requireFromHere(errorLogPath);
  errorWrap = requireFromHere(errorWrapPath);
});

describe("appendError — entry shape + caps", () => {
  it("stores a full entry with id/ts/fingerprint and echoes it back", async () => {
    const entry = await errorLog.appendError({
      source: "api",
      handler: "jobs",
      message: "boom",
      severity: "error",
      statusCode: 500,
      stack: "Error: boom\n  at handler",
      userId: "u_1",
      jobId: "job_1",
      metadata: { route: "/api/jobs" },
    });
    expect(entry).toBeTruthy();
    expect(entry!.id).toMatch(/^err_[0-9a-z]{8}$/);
    expect(Number.isNaN(Date.parse(entry!.ts))).toBe(false);
    expect(entry!.source).toBe("api");
    expect(entry!.handler).toBe("jobs");
    expect(entry!.message).toBe("boom");
    expect(entry!.severity).toBe("error");
    expect(entry!.statusCode).toBe(500);
    expect(entry!.userId).toBe("u_1");
    expect(entry!.jobId).toBe("job_1");
    expect(entry!.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(entry!.metadata).toEqual({ route: "/api/jobs" });
    // Persisted to the single journal blob.
    expect(storedEntries()).toHaveLength(1);
    expect(storedEntries()[0]!.id).toBe(entry!.id);
  });

  it("caps message at 500 and stack at 800 characters", async () => {
    const entry = await errorLog.appendError({
      handler: "jobs",
      message: "m".repeat(600),
      stack: "s".repeat(2000),
    });
    expect(entry!.message).toHaveLength(500);
    expect(entry!.stack).toHaveLength(800);
  });

  it("truncates oversized metadata HONESTLY (_truncated flag, ~1KB preview)", async () => {
    const entry = await errorLog.appendError({
      handler: "jobs",
      message: "boom",
      metadata: { big: "x".repeat(4000) },
    });
    expect(entry!.metadata?._truncated).toBe(true);
    expect((entry!.metadata?.preview as string).length).toBeLessThanOrEqual(1024);
  });

  it("defaults an unknown source/severity rather than storing junk", async () => {
    const entry = await errorLog.appendError({
      source: "martian",
      severity: "catastrophic",
      handler: "jobs",
      message: "boom",
    });
    expect(entry!.source).toBe("api");
    expect(entry!.severity).toBe("error");
  });

  it("trims 5000 → 4000 FIFO, keeping the newest entry", async () => {
    const old = Array.from({ length: errorLog.MAX_ENTRIES }, (_, i) => ({
      id: `err_old${i}`,
      ts: "2026-01-01T00:00:00.000Z",
      source: "api",
      handler: "jobs",
      message: `old ${i}`,
      severity: "error",
      statusCode: 500,
      stack: null,
      userId: null,
      jobId: null,
      fingerprint: "abcabcabcabc",
    }));
    blob.set("platform/errors.json", { entries: old });
    const entry = await errorLog.appendError({ handler: "jobs", message: "newest" });
    const stored = storedEntries();
    expect(stored).toHaveLength(errorLog.TRIM_TO);
    expect(stored[stored.length - 1]!.id).toBe(entry!.id);
    // Oldest entries were dropped.
    expect(stored[0]!.id).not.toBe("err_old0");
  });

  it("NEVER throws — a blob write failure returns null and records nothing", async () => {
    writeShouldThrow = true;
    await expect(
      errorLog.appendError({ handler: "jobs", message: "boom" }),
    ).resolves.toBeNull();
    expect(storedEntries()).toHaveLength(0);
  });
});

describe("fingerprintOf — grouping stability", () => {
  it("is stable for identical inputs and 12 hex chars", () => {
    const a = errorLog.fingerprintOf("jobs", "boom", 500);
    const b = errorLog.fingerprintOf("jobs", "boom", 500);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs when handler, message, or statusCode differ", () => {
    const base = errorLog.fingerprintOf("jobs", "boom", 500);
    expect(errorLog.fingerprintOf("data", "boom", 500)).not.toBe(base);
    expect(errorLog.fingerprintOf("jobs", "bang", 500)).not.toBe(base);
    expect(errorLog.fingerprintOf("jobs", "boom", 502)).not.toBe(base);
  });
});

describe("withErrorCapture — escaped errors only", () => {
  it("leaves the normal path untouched (same result, no journal entry)", async () => {
    const wrapped = errorWrap.withErrorCapture(async (_req, res) => {
      (res as ReturnType<typeof createRes>).status(200).json({ ok: true });
      return "done";
    }, "jobs");
    const res = createRes();
    const result = await wrapped({}, res);
    expect(result).toBe("done");
    expect(res.statusCode).toBe(200);
    expect(storedEntries()).toHaveLength(0);
  });

  it("journals an escaped throw and answers 500 { error: 'server error' }", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapped = errorWrap.withErrorCapture(async () => {
      throw new Error("kaboom");
    }, "jobs");
    const res = createRes();
    await wrapped({}, res);
    consoleSpy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "server error" });
    const stored = storedEntries();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.source).toBe("api");
    expect(stored[0]!.handler).toBe("jobs");
    expect(stored[0]!.message).toBe("kaboom");
    expect(stored[0]!.statusCode).toBe(500);
    expect(stored[0]!.stack).toContain("kaboom");
  });

  it("does not write a second response once headers have gone out", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapped = errorWrap.withErrorCapture(async (_req, res) => {
      (res as ReturnType<typeof createRes>).status(200).json({ ok: true });
      throw new Error("late kaboom");
    }, "jobs");
    const res = createRes();
    await wrapped({}, res);
    consoleSpy.mockRestore();
    // Journalled, but the already-sent 200 stands.
    expect(storedEntries()).toHaveLength(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("still 500s when journalling itself fails (capture is best-effort)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeShouldThrow = true;
    const wrapped = errorWrap.withErrorCapture(async () => {
      throw new Error("kaboom");
    }, "jobs");
    const res = createRes();
    await wrapped({}, res);
    consoleSpy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "server error" });
  });

  it("exports captureError for inline use in existing catch blocks", async () => {
    const entry = await errorWrap.captureError({ handler: "hours", message: "handled" });
    expect(entry).toBeTruthy();
    expect(storedEntries()).toHaveLength(1);
  });
});
