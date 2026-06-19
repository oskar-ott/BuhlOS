import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * #511 — the quotes-v2 registry roll-up write must be guarded like the document
 * write. Two concurrent saves used to read the same registry snapshot, each add
 * their row, and last-write-wins DROPPED one quote from the office money-list.
 * `upsertRegistryRow` now threads expectedRev + retries on a stale-revision
 * conflict (re-reading the fresh registry), so no concurrent row is lost.
 *
 * Tests the helper directly against a faithful in-memory blob that stamps __rev,
 * honours expectedRev, and can simulate a concurrent writer landing between the
 * read and the write. The expectedRev guard itself is covered in
 * blob-guards-api.test.ts.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const handlerPath = requireFromHere.resolve("../../../api/quotes-v2.js");

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

type Row = { id: string; name?: string };
type Registry = { quotes: Row[]; __rev?: number };
const KEY = "quotes-v2.json";

let store: Map<string, Registry>;
let writeCount: number;
let failNextWriteStale: boolean;
let concurrentRowOnStale: Row | null;
let helpers: { upsertRegistryRow: (doc: unknown) => Promise<void> };

function staleError() {
  const e = new Error("stale write") as Error & { code: string };
  e.code = "stale_write";
  return e;
}

function quoteDoc(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: id.toUpperCase(),
    status: "draft",
    updatedAt: "2026-06-18T00:00:00.000Z",
    totals: { totalIncGst: 100, lineCount: 2 },
    ...over,
  };
}

beforeEach(() => {
  store = new Map();
  writeCount = 0;
  failNextWriteStale = false;
  concurrentRowOnStale = null;

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
      writeBlob: async (key: string, data: Registry, opts: { expectedRev?: number } = {}) => {
        writeCount += 1;
        const current = store.get(key);
        const currentRev = current && Number.isFinite(current.__rev) ? (current.__rev as number) : 0;
        if (failNextWriteStale) {
          failNextWriteStale = false;
          if (concurrentRowOnStale) {
            // a concurrent writer lands its row + bumps the rev before we retry
            const reg = current ?? { quotes: [], __rev: 0 };
            reg.quotes.push(concurrentRowOnStale);
            reg.__rev = currentRev + 1;
            store.set(key, clone(reg));
          }
          throw staleError();
        }
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

const ids = () => (store.get(KEY)?.quotes ?? []).map((q) => q.id);

describe("upsertRegistryRow — guarded registry roll-up (#511)", () => {
  it("appends a new row and updates an existing one in place", async () => {
    await helpers.upsertRegistryRow(quoteDoc("qa"));
    expect(ids()).toEqual(["qa"]);
    await helpers.upsertRegistryRow(quoteDoc("qa", { status: "won" }));
    expect(ids()).toEqual(["qa"]); // updated, not duplicated
    expect(store.get(KEY)!.quotes[0]).toMatchObject({ id: "qa", status: "won" });
  });

  it("two sequential saves keep BOTH rows", async () => {
    await helpers.upsertRegistryRow(quoteDoc("qa"));
    await helpers.upsertRegistryRow(quoteDoc("qb"));
    expect(ids().sort()).toEqual(["qa", "qb"]);
  });

  it("a concurrent save landing mid-write is NOT dropped — the retry re-reads it", async () => {
    store.set(KEY, { quotes: [{ id: "qa", name: "QA" }], __rev: 1 });
    concurrentRowOnStale = { id: "qc", name: "QC" }; // a concurrent writer lands qc
    failNextWriteStale = true;

    await helpers.upsertRegistryRow(quoteDoc("qb")); // our save retries after the conflict

    expect(writeCount).toBe(2); // one conflicted + one succeeded
    expect(ids().sort()).toEqual(["qa", "qb", "qc"]); // qa preserved, qc not dropped, qb added
  });
});
