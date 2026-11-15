import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FILE-02 — evidence/photo blob orphan GC (part of #152).
 *
 * Tests the pure sweep logic in api/_lib/evidence-orphan-gc.js via dependency
 * injection (injectable listAll/readBlob/del over an in-memory fake blob store),
 * so no @vercel/blob SDK or network is touched.
 *
 * Coverage the brief requires:
 *   - the GC identifies an orphan vs a live-referenced blob;
 *   - a soft-deleted-but-restorable record's bytes are NOT reclaimed
 *     (rejected evidence stays in data.json → still LIVE);
 *   - dry-run deletes nothing.
 */

const requireFromHere = createRequire(import.meta.url);
const gcPath = requireFromHere.resolve("../../../api/_lib/evidence-orphan-gc.js");

type Blob = { pathname: string; url: string };
type Gc = {
  sweepJob: (
    opts: { jobId: string; write?: boolean },
    deps: object
  ) => Promise<{
    jobId: string;
    scanned: number;
    live: number;
    orphans: string[];
    deleted: number;
    deleteErrors: Array<{ pathname: string; error: string }>;
    write: boolean;
    aborted?: string;
  }>;
  sweepAll: (
    opts: { write?: boolean },
    deps: object
  ) => Promise<{
    jobs: number;
    scanned: number;
    live: number;
    orphans: number;
    deleted: number;
    perJob: Array<{ jobId: string; orphans: string[]; deleted: number }>;
  }>;
  isReferenced: (pathname: string, url: string, refs: Set<string>) => boolean;
};

let gc: Gc;

// In-memory blob store: pathname → bytes (for binaries) / JSON text (for docs).
let store: Map<string, string>;

function urlFor(pathname: string): string {
  return `https://blob.test/${encodeURIComponent(pathname)}`;
}

function makeDeps() {
  const del = vi.fn(async (urls: string[]) => {
    for (const u of urls) {
      // GC passes the URL; map it back to a pathname to delete from the store.
      const pathname = u.startsWith("https://")
        ? decodeURIComponent(new URL(u).pathname.slice(1))
        : u;
      store.delete(pathname);
    }
  });
  const deps = {
    listAll: async (prefix: string): Promise<Blob[]> =>
      [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((pathname) => ({ pathname, url: urlFor(pathname) })),
    readBlob: async (key: string, fallback: unknown) => {
      const v = store.get(key);
      return v === undefined ? fallback : JSON.parse(v);
    },
    del,
  };
  return { deps, del };
}

beforeEach(() => {
  for (const p of [gcPath]) delete requireFromHere.cache[p];
  gc = requireFromHere(gcPath) as Gc;
  store = new Map<string, string>();
});

/** Seed jobs.json + a per-job data.json + some photo blobs. */
function seed() {
  store.set("jobs.json", JSON.stringify({ jobs: [{ id: "j1", name: "Birdwood" }] }));
}

describe("isReferenced", () => {
  it("matches by full pathname, by url, and by photoId token", () => {
    const path = "jobs/j1/evidence-photos/1718000000000_abc123.jpg";
    const url = urlFor(path);
    expect(gc.isReferenced(path, url, new Set([path]))).toBe(true);
    expect(gc.isReferenced(path, url, new Set([url]))).toBe(true);
    // bare photoId stored on the record (evidence.photoId)
    expect(
      gc.isReferenced(path, url, new Set(["1718000000000_abc123"]))
    ).toBe(true);
    // no reference anywhere → orphan
    expect(gc.isReferenced(path, url, new Set(["something-else"]))).toBe(false);
  });

  it("does not over-match on a too-short id fragment", () => {
    const path = "jobs/j1/photos/ab.jpg"; // 2-char stem
    // A 2-char stem must not be treated as a unique token (would falsely keep).
    expect(gc.isReferenced(path, urlFor(path), new Set(["ab"]))).toBe(false);
  });
});

describe("sweepJob — orphan vs live", () => {
  it("keeps a live-referenced evidence photo, flags an unreferenced one", async () => {
    seed();
    const livePath = "jobs/j1/evidence-photos/live_photo_00001.jpg";
    const orphanPath = "jobs/j1/evidence-photos/orphan_photo_9999.jpg";
    store.set(livePath, "JPEGBYTES-LIVE");
    store.set(orphanPath, "JPEGBYTES-ORPHAN");
    // data.json references ONLY the live photo (via its url).
    store.set(
      "jobs/j1/data.json",
      JSON.stringify({
        evidence: [
          { id: "ev1", kind: "photo", photoUrl: urlFor(livePath), status: "submitted" },
        ],
        snags: [],
      })
    );

    const { deps, del } = makeDeps();
    const r = await gc.sweepJob({ jobId: "j1", write: true }, deps);

    expect(r.scanned).toBe(2);
    expect(r.live).toBe(1);
    expect(r.orphans).toEqual([orphanPath]);
    expect(r.deleted).toBe(1);
    // only the orphan's bytes were deleted; the live photo survives.
    expect(store.has(livePath)).toBe(true);
    expect(store.has(orphanPath)).toBe(false);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("keeps a photo referenced only by bare photoId (not full url)", async () => {
    seed();
    const path = "jobs/j1/snag-photos/1718000000000_zzz999.jpg";
    store.set(path, "JPEGBYTES");
    // snag stores the bare photo id, not the full url.
    store.set(
      "jobs/j1/data.json",
      JSON.stringify({
        evidence: [],
        snags: [{ id: "s1", photos: [{ id: "1718000000000_zzz999" }] }],
      })
    );

    const { deps } = makeDeps();
    const r = await gc.sweepJob({ jobId: "j1", write: true }, deps);
    expect(r.orphans).toEqual([]);
    expect(r.live).toBe(1);
    expect(store.has(path)).toBe(true);
  });
});

describe("sweepJob — restorable soft state is NOT reclaimed", () => {
  it("keeps bytes of a REJECTED (restorable) evidence photo", async () => {
    seed();
    // Rejected evidence is restorable (rejected→submitted transition exists in
    // api/evidence.js) and STAYS in data.json.evidence[]. Its bytes must NOT be
    // reclaimed — the GC sees it as a live reference.
    const rejectedPath = "jobs/j1/evidence-photos/rejected_photo_123.jpg";
    store.set(rejectedPath, "JPEGBYTES-REJECTED");
    store.set(
      "jobs/j1/data.json",
      JSON.stringify({
        evidence: [
          {
            id: "ev_rej",
            kind: "photo",
            photoUrl: urlFor(rejectedPath),
            status: "rejected",
            rejectionReason: "blurry",
          },
        ],
        snags: [],
      })
    );

    const { deps, del } = makeDeps();
    const r = await gc.sweepJob({ jobId: "j1", write: true }, deps);
    expect(r.orphans).toEqual([]);
    expect(r.live).toBe(1);
    expect(r.deleted).toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect(store.has(rejectedPath)).toBe(true);
  });
});

describe("sweepJob — dry-run deletes nothing", () => {
  it("reports the orphan but deletes nothing when write is false (default)", async () => {
    seed();
    const orphanPath = "jobs/j1/photos/orphan_dwelling_777.jpg";
    store.set(orphanPath, "JPEGBYTES-ORPHAN");
    store.set("jobs/j1/data.json", JSON.stringify({ evidence: [], snags: [] }));

    const { deps, del } = makeDeps();
    // default (no write flag)
    const r = await gc.sweepJob({ jobId: "j1" }, deps);
    expect(r.write).toBe(false);
    expect(r.orphans).toEqual([orphanPath]);
    expect(r.deleted).toBe(0);
    expect(del).not.toHaveBeenCalled();
    // bytes untouched
    expect(store.has(orphanPath)).toBe(true);
  });
});

describe("sweepJob — fails closed on unreadable reference doc", () => {
  it("skips the job (no delete) if a reference doc read throws", async () => {
    seed();
    const orphanPath = "jobs/j1/photos/x_00001.jpg";
    store.set(orphanPath, "JPEGBYTES");

    const { deps, del } = makeDeps();
    // make data.json read throw (transient blob failure)
    const throwingReadBlob = async (key: string, fallback: unknown) => {
      if (key === "jobs/j1/data.json") throw new Error("transient blob read failure");
      return (deps.readBlob as (k: string, f: unknown) => Promise<unknown>)(key, fallback);
    };

    const r = await gc.sweepJob(
      { jobId: "j1", write: true },
      { ...deps, readBlob: throwingReadBlob }
    );
    expect(r.aborted).toBeTruthy();
    expect(r.deleted).toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect(store.has(orphanPath)).toBe(true);
  });
});

describe("sweepAll", () => {
  it("aggregates across jobs and only deletes orphans when writing", async () => {
    store.set(
      "jobs.json",
      JSON.stringify({ jobs: [{ id: "j1" }, { id: "j2" }] })
    );
    const liveA = "jobs/j1/evidence-photos/live_aaaaa_1.jpg";
    const orphanA = "jobs/j1/evidence-photos/orphan_aaaaa_2.jpg";
    const orphanB = "jobs/j2/snag-photos/orphan_bbbbb_3.jpg";
    store.set(liveA, "L");
    store.set(orphanA, "O");
    store.set(orphanB, "O");
    store.set(
      "jobs/j1/data.json",
      JSON.stringify({ evidence: [{ id: "e", photoUrl: urlFor(liveA) }], snags: [] })
    );
    store.set("jobs/j2/data.json", JSON.stringify({ evidence: [], snags: [] }));

    const { deps, del } = makeDeps();

    // dry-run first: reports 2 orphans, deletes nothing
    const dry = await gc.sweepAll({ write: false }, deps);
    expect(dry.jobs).toBe(2);
    expect(dry.scanned).toBe(3);
    expect(dry.live).toBe(1);
    expect(dry.orphans).toBe(2);
    expect(dry.deleted).toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect(store.has(orphanA)).toBe(true);
    expect(store.has(orphanB)).toBe(true);

    // write: deletes exactly the 2 orphans, keeps the live one
    const wet = await gc.sweepAll({ write: true }, deps);
    expect(wet.deleted).toBe(2);
    expect(store.has(liveA)).toBe(true);
    expect(store.has(orphanA)).toBe(false);
    expect(store.has(orphanB)).toBe(false);
  });
});
