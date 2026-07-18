import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #251 bridge tests — REAL recorder + REAL bridge over a faked blob store,
 * with the heavy export/reference libs faked at the module seam. Pins:
 * batch rollup summarisation, ok vs open recording, the loud-surfaced
 * warning contract when the recorder write fails, and both retry handlers
 * (resolved / resolved_meanwhile / still-failed) traversing the original
 * service entry points only.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const recorderPath = requireFromHere.resolve("../../../api/_lib/xero-sync-log.js");
const exportSvcPath = requireFromHere.resolve("../../../api/_lib/xero/timesheet-export.js");
const refSyncPath = requireFromHere.resolve("../../../api/_lib/xero/reference-sync.js");
const bridgePath = requireFromHere.resolve("../../../api/_lib/xero/sync-log-bridge.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bridge: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recorder: any;
let blob: Map<string, unknown>;
let blobWriteFails: boolean;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let retryExport: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let syncReferenceData: any;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function workers(...outcomes: Array<[string, string, string?]>) {
  return {
    batch: { status: "exported" },
    workers: outcomes.map(([worker, outcome, category]) => ({ worker, outcome, ...(category ? { category } : {}) })),
  };
}

beforeEach(() => {
  blob = new Map();
  blobWriteFails = false;
  retryExport = vi.fn();
  syncReferenceData = vi.fn();

  for (const p of [recorderPath, bridgePath]) delete requireFromHere.cache[p];
  const fake = (path: string, exports: unknown) => {
    requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
  };
  fake(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
    writeBlob: vi.fn(async (key: string, data: unknown) => {
      if (blobWriteFails) throw new Error("blob down");
      blob.set(key, clone(data));
    }),
    setNoCache: vi.fn(),
  });
  fake(exportSvcPath, { retryExport });
  fake(refSyncPath, { syncReferenceData });

  bridge = requireFromHere(bridgePath);
  recorder = requireFromHere(recorderPath);
});

describe("summariseBatch (pure)", () => {
  it("landed when every worker verified/skipped; reason names the failures otherwise", () => {
    const ok = bridge.summariseBatch(workers(["Amy", "verified"], ["Bob", "skipped"]));
    expect(ok).toMatchObject({ landed: true, verified: 1, skipped: 1, failedCount: 0 });

    const bad = bridge.summariseBatch(
      workers(["Amy", "verified"], ["Bob", "rejected", "xero_validation"], ["Cal", "blocked"]),
    );
    expect(bad.landed).toBe(false);
    expect(bad.category).toBe("xero_validation");
    expect(bad.reason).toContain("2 of 3 workers not landed");
    expect(bad.reason).toContain("Bob: rejected");
  });
});

describe("recordBatchOutcome", () => {
  it("landed batch → ok record (lastSuccess stamped, nothing open)", async () => {
    const warning = await bridge.recordBatchOutcome({ batchId: "b-1", out: workers(["Amy", "verified"]) });
    expect(warning).toBeNull();
    const state = await recorder.openState();
    expect(state.items).toHaveLength(0);
    expect(state.lastSuccessAt.timesheet_export).toBeTruthy();
  });

  it("unlanded batch → ONE open item per batch, upserted across attempts", async () => {
    await bridge.recordBatchOutcome({ batchId: "b-1", out: workers(["Bob", "rejected", "employee_inactive"]) });
    await bridge.recordBatchOutcome({ batchId: "b-1", out: workers(["Bob", "retry_required", "rate_limit"]) });
    const state = await recorder.openState();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      operation: "tsx:b-1",
      recordRef: "b-1",
      syncType: "timesheet_export",
      seenCount: 2,
      category: "rate_limit",
    });
  });

  it("recorder failure → loud warning string, never a throw", async () => {
    blobWriteFails = true;
    const warning = await bridge.recordBatchOutcome({ batchId: "b-1", out: workers(["Bob", "rejected"]) });
    expect(warning).toContain("sync-log write failed");
    expect(warning).toContain("authoritative");
  });
});

describe("recordReferenceOutcomes", () => {
  it("records ok and failed groups distinctly", async () => {
    const warning = await bridge.recordReferenceOutcomes([
      { group: "employees", status: "ok", itemCount: 7 },
      { group: "pay_items", status: "failed", errorCategory: "rate_limit" },
    ]);
    expect(warning).toBeNull();
    const state = await recorder.openState();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ operation: "ref:pay_items", syncType: "reference_sync", category: "rate_limit" });
    expect(state.lastSuccessAt.reference_sync).toBeTruthy();
  });
});

describe("retry handlers (registered at load, original code paths only)", () => {
  it("timesheet retry that lands new sends → resolved; skips-only → resolved_meanwhile", async () => {
    await bridge.recordBatchOutcome({ batchId: "b-1", out: workers(["Bob", "rejected"]) });

    retryExport.mockResolvedValueOnce(workers(["Bob", "verified"]));
    expect(await recorder.retry("tsx:b-1")).toMatchObject({ retried: true, outcome: "resolved" });
    expect(retryExport).toHaveBeenCalledWith(expect.objectContaining({ batchId: "b-1" }));
    expect((await recorder.openState()).items).toHaveLength(0);

    await bridge.recordBatchOutcome({ batchId: "b-2", out: workers(["Cal", "rejected"]) });
    retryExport.mockResolvedValueOnce(workers(["Cal", "skipped"]));
    expect(await recorder.retry("tsx:b-2")).toMatchObject({ retried: true, outcome: "resolved_meanwhile" });
  });

  it("timesheet retry still failing → item stays open with the fresh reason", async () => {
    await bridge.recordBatchOutcome({ batchId: "b-3", out: workers(["Dee", "rejected", "period_locked"]) });
    retryExport.mockResolvedValueOnce(workers(["Dee", "rejected", "period_locked"]));
    expect(await recorder.retry("tsx:b-3")).toMatchObject({ retried: true, outcome: "failed" });
    const state = await recorder.openState();
    expect(state.items[0]).toMatchObject({ operation: "tsx:b-3", seenCount: 2, category: "period_locked" });
  });

  it("reference retry re-runs ONLY the failed group and resolves on ok", async () => {
    await bridge.recordReferenceOutcomes([{ group: "employees", status: "failed", errorCategory: "network_timeout" }]);
    syncReferenceData.mockResolvedValueOnce([{ group: "employees", status: "ok", itemCount: 5 }]);
    expect(await recorder.retry("ref:employees")).toMatchObject({ retried: true, outcome: "resolved" });
    expect(syncReferenceData).toHaveBeenCalledWith(expect.objectContaining({ groups: ["employees"] }));
    expect((await recorder.openState()).items).toHaveLength(0);
  });
});
