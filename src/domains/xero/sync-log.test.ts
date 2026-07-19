import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_STATUSES,
  OpenStoreSchema,
  TERMINAL_OUTCOMES,
  XERO_ERROR_CATEGORIES,
  XERO_ERROR_TAXONOMY,
  XERO_SYNC_TYPES,
  headlineState,
  openCounts,
  taxonomyFor,
} from "./sync-log";

/**
 * #251 recorder + contract tests. Two halves:
 *   1. the TS domain (selectors, taxonomy, MIRROR-LAW pins vs the CJS lib)
 *   2. the CJS recorder against a faked blob store (record/upsert idempotence,
 *      open-never-trimmed, resolve/ack/retry transitions incl. resolved-
 *      meanwhile, unknown-type/status rejection, required ack note, scrubber,
 *      month rollover + history cap)
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const libPath = requireFromHere.resolve("../../../api/_lib/xero-sync-log.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lib: any;
let blob: Map<string, unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

beforeEach(() => {
  blob = new Map();
  delete requireFromHere.cache[libPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  lib = requireFromHere(libPath);
  lib._resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const FAIL = {
  syncType: "timesheet_export",
  operation: "op-1",
  recordRef: "batch-1/worker-9",
  status: "failed",
  reason: "Xero rejected the record",
  category: "xero_validation",
} as const;

describe("mirror law — TS lists 1:1 with the CJS recorder", () => {
  it("sync types, open statuses and terminal outcomes never drift", () => {
    expect([...XERO_SYNC_TYPES].sort()).toEqual([...lib.SYNC_TYPES].sort());
    expect([...OPEN_STATUSES].sort()).toEqual([...lib.OPEN_STATUSES].sort());
    expect([...TERMINAL_OUTCOMES].sort()).toEqual([...lib.TERMINAL_OUTCOMES].sort());
  });
});

describe("domain selectors + taxonomy", () => {
  it("openCounts totals per type", () => {
    const c = openCounts([
      { syncType: "timesheet_export" },
      { syncType: "timesheet_export" },
      { syncType: "reference_sync" },
    ]);
    expect(c.total).toBe(3);
    expect(c.byType.timesheet_export).toBe(2);
    expect(c.byType.reconciliation).toBe(0);
  });

  it("headline: green means connected AND clear — never just 'nothing recorded'", () => {
    expect(headlineState({ connection: "never", openTotal: 0 })).toBe("never_connected");
    expect(headlineState({ connection: "disconnected", openTotal: 0 })).toBe("disconnected");
    expect(headlineState({ connection: "connected", openTotal: 0 })).toBe("all_clear");
    expect(headlineState({ connection: "connected", openTotal: 2 })).toBe("attention");
  });

  it("every taxonomy category carries the full operator contract", () => {
    expect(XERO_ERROR_CATEGORIES.length).toBe(15);
    for (const key of XERO_ERROR_CATEGORIES) {
      const meta = XERO_ERROR_TAXONOMY[key];
      expect(meta.operatorMessage.length).toBeGreaterThan(10);
      expect(meta.developerDetail.length).toBeGreaterThan(10);
      expect(meta.requiredAction.length).toBeGreaterThan(5);
      expect(typeof meta.retryable).toBe("boolean");
    }
    expect(taxonomyFor("nope")).toBeNull();
  });
});

describe("recorder — record()", () => {
  it("rejects unknown syncType and unknown status loudly", async () => {
    await expect(lib.record({ ...FAIL, syncType: "typo_sync" })).rejects.toThrow(/unknown syncType/);
    await expect(lib.record({ ...FAIL, status: "exploded" })).rejects.toThrow(/unknown status/);
    expect(blob.size).toBe(0);
  });

  it("a failure lands in the open set; re-recording upserts (no duplicates), bumps seenCount", async () => {
    await lib.record(FAIL);
    await lib.record({ ...FAIL, reason: "still failing" });
    const state = await lib.openState();
    expect(state.items).toHaveLength(1);
    expect(state.items[0].seenCount).toBe(2);
    expect(state.items[0].reason).toBe("still failing");
    expect(state.counts.byType.timesheet_export).toBe(1);
    const parsed = OpenStoreSchema.parse(blob.get(lib.OPEN_KEY));
    expect(parsed.items[0]!.operation).toBe("op-1");
  });

  it("a success stamps lastSuccessAt and appends terminal history — opens untouched", async () => {
    await lib.record(FAIL);
    await lib.record({ syncType: "timesheet_export", operation: "op-2", recordRef: "batch-1", status: "ok" });
    const state = await lib.openState();
    expect(state.items).toHaveLength(1); // op-1 still open
    expect(state.lastSuccessAt.timesheet_export).toBeTruthy();
    const month = blob.get(lib.monthKey(new Date().toISOString())) as { entries: Array<{ outcome: string }> };
    expect(month.entries.map((e) => e.outcome)).toEqual(["ok"]);
  });

  it("a later ok for the SAME operation closes its open failure (find #7 — no phantom opens)", async () => {
    await lib.record(FAIL);
    expect((await lib.openState()).items).toHaveLength(1);
    const out = await lib.record({ syncType: "timesheet_export", operation: "op-1", recordRef: "batch-1/worker-9", status: "ok" });
    expect(out.resolvedPrior).toBe(true);
    expect((await lib.openState()).items).toHaveLength(0);
    const month = blob.get(lib.monthKey(new Date().toISOString())) as { entries: Array<{ outcome: string }> };
    expect(month.entries.map((e) => e.outcome)).toEqual(["resolved", "ok"]);
  });

  it("scrubs credential-shaped content in reason and xeroError at the chokepoint", async () => {
    await lib.record({
      ...FAIL,
      reason: "failed with Authorization: Bearer abc.def-ghi_jkl",
      xeroError: { detail: 'refresh_token: "SECRETSECRET"', nested: ["client_secret=beef1234"] },
    });
    const state = await lib.openState();
    expect(JSON.stringify(state.items[0])).not.toMatch(/SECRETSECRET|beef1234|abc\.def/);
    expect(state.items[0].reason).toContain("[scrubbed]");
  });
});

describe("recorder — transitions", () => {
  it("resolve moves open → history (resolved), and reports not-open honestly", async () => {
    await lib.record(FAIL);
    expect(await lib.resolve("op-1")).toMatchObject({ resolved: true, outcome: "resolved" });
    expect((await lib.openState()).items).toHaveLength(0);
    const month = blob.get(lib.monthKey(new Date().toISOString())) as { entries: Array<{ outcome: string; operation: string }> };
    expect(month.entries.at(-1)).toMatchObject({ outcome: "resolved", operation: "op-1" });
    expect(await lib.resolve("op-1")).toMatchObject({ resolved: false });
  });

  it("acknowledge REQUIRES a note, stores it scrubbed, and preserves attribution", async () => {
    await lib.record(FAIL);
    await expect(lib.acknowledge("op-1", { by: "boss" })).rejects.toThrow(/requires a note/);
    await lib.acknowledge("op-1", { by: "boss", note: "Worker paid manually; Bearer tok.en" });
    expect((await lib.openState()).items).toHaveLength(0);
    const month = blob.get(lib.monthKey(new Date().toISOString())) as {
      entries: Array<{ outcome: string; acknowledgedBy: string; acknowledgedNote: string }>;
    };
    const ack = month.entries.at(-1)!;
    expect(ack.outcome).toBe("acknowledged");
    expect(ack.acknowledgedBy).toBe("boss");
    expect(ack.acknowledgedNote).toContain("[scrubbed]");
    expect(ack.acknowledgedNote).not.toContain("tok.en");
  });

  it("retry goes through the registered handler only; resolved-meanwhile is honoured; failure re-records", async () => {
    await lib.record(FAIL);
    await expect(lib.retry("op-1")).rejects.toThrow(/no retry handler/);

    const handler = vi.fn(async () => ({ outcome: "resolved_meanwhile", reason: "landed via full re-push" }));
    lib.registerRetryHandler("timesheet_export", handler);
    expect(await lib.retry("op-1")).toMatchObject({ retried: true, outcome: "resolved_meanwhile" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ operation: "op-1", recordRef: FAIL.recordRef }));
    expect((await lib.openState()).items).toHaveLength(0);

    await lib.record(FAIL);
    lib.registerRetryHandler("timesheet_export", vi.fn(async () => ({ outcome: "failed", reason: "still invalid" })));
    expect(await lib.retry("op-1")).toMatchObject({ retried: true, outcome: "failed" });
    const state = await lib.openState();
    expect(state.items[0].seenCount).toBe(2);
    expect(state.items[0].reason).toBe("still invalid");
  });

  it("rejects registering a handler for an unknown type", () => {
    expect(() => lib.registerRetryHandler("typo_sync", async () => ({}))).toThrow(/unknown syncType/);
  });
});

describe("recorder — history discipline", () => {
  it("history caps + trims, open set is NEVER trimmed", async () => {
    const key = lib.monthKey(new Date().toISOString());
    blob.set(key, {
      entries: Array.from({ length: lib.MAX_ENTRIES_PER_MONTH }, (_, i) => ({ id: `h${i}`, outcome: "ok" })),
    });
    await lib.record({ syncType: "reference_sync", operation: "op-x", recordRef: "r", status: "ok" });
    const month = blob.get(key) as { entries: unknown[] };
    expect(month.entries).toHaveLength(lib.TRIM_TO_PER_MONTH);

    for (let i = 0; i < 40; i++) {
      await lib.record({ syncType: "reference_sync", operation: `op-${i}`, recordRef: "r", status: "failed", reason: "x" });
    }
    expect((await lib.openState()).items).toHaveLength(40); // untrimmed, all present
  });

  it("terminal entries land in the month of their own timestamp (rollover-safe)", () => {
    expect(lib.monthKey("2026-07-31T23:59:59Z")).toBe("xero/sync-log/2026-07.json");
    expect(lib.monthKey("2026-08-01T00:00:01Z")).toBe("xero/sync-log/2026-08.json");
  });
});
