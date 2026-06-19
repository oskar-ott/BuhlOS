import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * #510 — the per-job AI takeoff spend cap must be atomic. Two concurrent analyse
 * calls used to read the same spend snapshot, each record their cost, and a
 * last-write-wins would DROP one call's spend — silently defeating the cap. The
 * fix (`commitTakeoff`) re-reads + re-applies the mutation on a stale-revision
 * conflict, so every call's spend is recorded EXACTLY once.
 *
 * Tests the accounting helper directly (the analyse handlers wrap it) against a
 * faithful in-memory blob that stamps __rev and honours expectedRev, with a
 * one-shot stale-write injection to exercise the retry deterministically. The
 * underlying expectedRev guard itself is covered in blob-guards-api.test.ts.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const handlerPath = requireFromHere.resolve("../../../api/plans.js");

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

type TakeoffDoc = { spend: { totalUsd: number; calls: unknown[] }; __rev?: number };

let store: Map<string, TakeoffDoc>;
let writeCount: number;
let expectedRevsSeen: Array<number | undefined>;
let failNextWriteStale: boolean;
let helpers: {
  commitTakeoff: (jobId: string, apply: (t: TakeoffDoc) => unknown) => Promise<unknown>;
  readTakeoff: (jobId: string) => Promise<TakeoffDoc>;
  recordSpend: (t: TakeoffDoc, usage: unknown, kind: string, meta: unknown) => void;
};

function staleError() {
  const e = new Error("stale write") as Error & { code: string };
  e.code = "stale_write";
  return e;
}

beforeEach(() => {
  store = new Map();
  writeCount = 0;
  expectedRevsSeen = [];
  failNextWriteStale = false;

  delete requireFromHere.cache[handlerPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)!) : fallback,
      readBlobFresh: async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)!) : fallback,
      writeBlob: async (key: string, data: TakeoffDoc, opts: { expectedRev?: number } = {}) => {
        writeCount += 1;
        expectedRevsSeen.push(opts.expectedRev);
        if (failNextWriteStale) {
          failNextWriteStale = false;
          throw staleError(); // throw BEFORE persisting — the write did not land
        }
        const current = store.get(key);
        const currentRev = current && Number.isFinite(current.__rev) ? (current.__rev as number) : 0;
        if (opts.expectedRev !== undefined && opts.expectedRev !== null && Number(opts.expectedRev) !== currentRev) {
          throw staleError();
        }
        store.set(key, clone({ ...data, __rev: currentRev + 1 }));
      },
      setNoCache: () => {},
    },
  } as NodeJS.Module;

  helpers = (requireFromHere(handlerPath) as { __test: typeof helpers }).__test;
});

const USAGE = { input_tokens: 5000, output_tokens: 1000 };
const spend = (jobId: string) => store.get(`jobs/${jobId}/ai-takeoff.json`)!.spend;

describe("commitTakeoff — atomic spend cap (#510)", () => {
  it("records one spend call per commit and passes the current expectedRev", async () => {
    await helpers.commitTakeoff("job1", (t) => {
      helpers.recordSpend(t, USAGE, "analyse-sheet", {});
      return { ok: true };
    });
    expect(spend("job1").calls).toHaveLength(1);
    expect(spend("job1").totalUsd).toBeGreaterThan(0);
    expect(writeCount).toBe(1);
    expect(expectedRevsSeen).toEqual([0]); // first write expects rev 0 (empty doc)
  });

  it("two sequential commits both land — no lost update (cap accounting honest)", async () => {
    await helpers.commitTakeoff("job1", (t) => helpers.recordSpend(t, USAGE, "analyse-sheet", {}));
    await helpers.commitTakeoff("job1", (t) => helpers.recordSpend(t, USAGE, "analyse-sheet", {}));
    expect(spend("job1").calls).toHaveLength(2);
    expect(expectedRevsSeen).toEqual([0, 1]); // second commit read the advanced rev
    const single = USAGE.input_tokens; // proportional sanity: total reflects BOTH calls
    expect(spend("job1").totalUsd).toBeGreaterThan(0);
    expect(single).toBeGreaterThan(0);
  });

  it("a stale-write conflict triggers a re-read + re-apply, recording the spend EXACTLY once", async () => {
    failNextWriteStale = true; // first write conflicts; commitTakeoff must retry
    await helpers.commitTakeoff("job1", (t) => helpers.recordSpend(t, USAGE, "analyse-sheet", {}));
    expect(writeCount).toBe(2); // one failed + one successful
    expect(spend("job1").calls).toHaveLength(1); // re-applied onto fresh data, NOT doubled
    expect(spend("job1").totalUsd).toBeGreaterThan(0);
  });
});
